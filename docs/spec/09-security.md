# 09 — Security

## Threat Model

### In scope

- Forged or replayed Ghost webhooks attempting to manipulate Discord roles.
- Forged Discord interactions attempting to invoke `/link` / `/unlink`.
- Unauthorized admin API access (mapping CRUD).
- Email enumeration via slash command.
- Account hijacking via `/link` (one Discord user claiming another user's email) — closed by the JWT/code redemption flow.
- Timing-attack-driven secret recovery.

### Out of scope

- Compromise of Cloudflare account credentials.
- Compromise of the Ghost Admin API key (treated as trusted in `GHOST_ADMIN_API_KEY`).
- Compromise of the Discord bot token.
- Denial of service against the worker (rate limiting / WAF is Cloudflare's concern).
- Compromise of Discord's signing infrastructure or Ed25519.

## Mitigations

### Webhook spoofing (`/webhook/added`, `/webhook/updated`, `/webhook/deleted`)

- HMAC-SHA256 over `body + timestamp` keyed with `WEBHOOK_SECRET`.
- 5-minute replay window enforced by `Math.abs(now - t) > 5 * 60 * 1000`.
- Constant-time hex comparison via `timingSafeEqual`.
- Body parsed only **after** signature verifies — no partial trust of payload.

### Discord interaction spoofing (`/discord`)

- Ed25519 signature verification using `DISCORD_PUBLIC_KEY`.
- Verification covers `timestamp + body`, so the signature binds the body byte-for-byte.
- Verification fails closed (`null` → `401 Invalid signature`).

### Admin endpoint hijacking (`/link`)

- `Authorization: Bearer <ADMIN_SECRET>` required.
- `timingSafeEqual` used for the bearer comparison.
- Email format validation prior to KV writes prevents poisoning the key space with arbitrary strings.

### `/link` slash command — proof of email ownership

The linking flow requires the Discord user to first obtain a code from the Ghost site:

1. The Ghost site (logged-in member session) calls `POST /code` with a Ghost-issued member JWT.
2. The Worker verifies the JWT signature against Ghost's published JWKS — only an authenticated Ghost session can produce a valid JWT.
3. The Worker writes `code:<CODE> → email` to KV with a 10-minute TTL and returns the code.
4. The user types `/link <CODE>` in Discord. The Worker reads the email from KV, applies 1:1 conflict checks, writes the mapping, and **deletes the code** (single-use).

This closes the impersonation gap from earlier designs: an attacker can no longer claim an arbitrary Ghost email by guessing it in Discord, because they cannot mint a valid JWT without controlling the Ghost session for that email. Discord-side conflict checks (below) defend against an attacker who somehow obtains a code in transit.

### 1:1 mapping conflict checks

Two conflict checks still run before any KV write or role assignment:

1. **Email-side**: If the email (resolved from the code) is already mapped to a different Discord user, reject.
2. **Discord-side**: If the invoking Discord user is already linked to a different email, reject and require `/unlink` first.

Re-linking the same `(email, userId)` pair is idempotent.

### Code security properties

- **Entropy**: 8 chars × log₂(32) = 40 bits. Combined with the 10-minute TTL, brute-force redemption is impractical (no rate limiting is implemented, but Discord slash command latency caps attack throughput sharply).
- **Lifetime**: `expirationTtl: 600` on the KV write, plus explicit delete on successful redemption.
- **Single-use**: Successful `/link` deletes the code entry; subsequent attempts see "Invalid or expired code."
- **Out-of-band channel**: The code travels browser → Ghost-site display → user's screen → Discord client. There is no transmission of the code via email, SMS, or any other channel that could be intercepted.
- **Scope**: The code unlocks only the email it was minted for; it carries no other authority.

### Ghost membership existence enforcement

The `/link` slash command calls `getGhostMember(email)` against the Ghost Admin API as a final sanity check — if the member cancelled between minting the code and redeeming it, linking is refused. The admin `POST /link` endpoint **bypasses** this check (trusted caller).

### Email validation

`isValidEmail` (in `src/utils.ts`) applies an RFC 5322-style regex and a 254-character maximum (RFC 5321 limit). Applied at all entry points that accept emails:

- `/link` slash command
- `POST /link` admin
- `DELETE /link` admin
- `GET /link/:email` admin

Webhook payloads are **not** re-validated against this regex — Ghost is trusted to send well-formed emails. (Emails are still lowercased before KV access.)

### Email enumeration

`/link` now takes a **code**, not an email, so it no longer leaks Ghost membership information. The `POST /code` endpoint requires a valid Ghost member JWT, so it also cannot be used to probe membership — only members can call it, and they already know their own email.

The remaining enumeration surface is the admin `GET /link/:email` endpoint, which requires the `ADMIN_SECRET` bearer token and is not user-facing.

### Timing attacks on secrets

All comparisons of confidential strings use `timingSafeEqual`:

- `WEBHOOK_SECRET` (via HMAC equality check)
- `ADMIN_SECRET` (via bearer equality check)

Discord and Ghost verification rely on Web Crypto primitives (`crypto.subtle.verify`, `crypto.subtle.sign`), which are constant-time by implementation.

### Hex parsing safety

`hexToBytes` (in `src/utils.ts`) explicitly validates:

```ts
if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string");
}
```

This prevents malformed hex (e.g., from corrupted `DISCORD_PUBLIC_KEY` or attacker-supplied signatures) from silently decoding to wrong bytes.

### Information disclosure

- Discord and Ghost API error bodies are **logged server-side** (`console.error`) but never returned to end users.
- Slash command error replies use generic phrasing ("An error occurred", "Please contact an administrator").
- Webhook errors return shape `{ "error": "<short reason>" }` with no internal state.

## Secret Handling

- Secrets are stored in Cloudflare's encrypted secret store (set via `wrangler secret put`).
- Locally, secrets live in `.dev.vars` which is `.gitignore`d.
- No secrets are logged. Verify by `grep`ping `console.log`/`console.error` calls — none print secret values.
- Secrets are accessed only through the `Env` object passed to handlers (no globals).

## Rotation

- All secrets can be rotated by `wrangler secret put <NAME>` followed by `wrangler deploy` (rotation is hot; no downtime, but in-flight requests with the old secret will fail post-rotation).
- `WEBHOOK_SECRET` rotation requires updating the secret in Ghost's webhook configuration simultaneously.
- `DISCORD_PUBLIC_KEY` cannot be rotated independently — it is set by Discord and tied to the application.
- `GHOST_ADMIN_API_KEY` is rotated by revoking and regenerating the Ghost integration key.

## No Persistent PII Beyond Linkage

The KV store contains only `email ↔ discord_user_id` pairs. No names, statuses, payment data, or other PII is persisted. Ghost remains the source of truth for member data; the worker holds only the bridge.

## Hardening Notes (current code)

The following defenses are implemented in code; tests cover each path.

- **Ghost NQL filter escaping** (`src/ghost.ts:escapeNqlValue`). The email is passed to the Ghost Admin API via the `filter=email:'<value>'` query parameter. Both `\` and `'` are escaped (`\` → `\\`, `'` → `\'`) before URL-encoding, so an email containing a quote cannot break out of the NQL string value.
- **Discord signature throw-safety** (`src/discord.ts:verifyDiscordSignature`). Hex decoding and key import are wrapped in `try/catch`; any failure returns `null` → `401`. A malformed `X-Signature-Ed25519` header can no longer surface as a 500.
- **Required JWT `kid`** (`src/jwt.ts`). JWTs without a `kid` header are rejected before key lookup, removing the "first key in JWKS" fallback that could mask key rotation.
- **JWT `iss` origin check** (`src/jwt.ts:sameOrigin`). The issuer is compared by parsed URL origin (scheme + host + port). Prefix-matching attacks like `iss=https://ghost.test.attacker.com` are rejected even if `GHOST_URL` starts with the same string.
- **Defensive `userId` resolution** (`src/commands.ts`). Slash command handlers accept either `member.user.id` (guild interactions) or `user.id` (DM/user-app interactions). If neither is present, the interaction is rejected with a polite ephemeral reply rather than writing `discord:undefined` to KV.
