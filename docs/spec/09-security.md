# 09 — Security

## Threat Model

### In scope

- Forged or replayed Ghost webhooks attempting to manipulate Discord roles.
- Forged Discord interactions attempting to invoke `/link` / `/unlink`.
- Unauthorized admin API access (mapping CRUD).
- Email enumeration via slash command.
- Account hijacking via `/link` (one Discord user claiming another user's email) — closed by the JWT/code redemption flow.
- Role multiplication: one Ghost membership granting roles to several Discord accounts (link, unlink, relink).
- Exhaustion of the KV write quota (free tier: 1,000 writes/day) by a logged-in member scripting `POST /code`.
- Timing-attack-driven secret recovery.

### Out of scope

- Compromise of Cloudflare account credentials.
- Compromise of the Ghost site's member-token signing key (published as JWKS; trusted for both email ownership and the `paid` flag).
- Compromise of the Discord bot token.
- Volumetric denial of service against the worker (WAF / DDoS protection is Cloudflare's concern). Application-level abuse of `POST /code` is in scope (see [KV write budget](#kv-write-budget-post-code)).
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
- `X-Signature-Timestamp` must be within ±5 minutes of the Worker's clock, so a captured interaction cannot be replayed later.
- Verification fails closed (`null` → `401 Invalid signature`).

### Admin endpoint hijacking (`/link`)

- `Authorization: Bearer <ADMIN_SECRET>` required.
- `timingSafeEqual` used for the bearer comparison.
- Email format validation prior to KV writes prevents poisoning the key space with arbitrary strings; `POST /link` also requires `discord_user_id` to be a snowflake (`/^\d{17,20}$/`), so it cannot write keys like `discord:undefined` or other arbitrary strings.
- `POST /link` deletes stale reverse entries when the email or the Discord user was previously linked elsewhere, so an admin re-link cannot leave a dangling `discord:<old_user>` → email or `<old_email>` → user key that would break the 1:1 invariant.
- `DELETE /link` removes both roles before deleting the mapping, and keeps the mapping (`502`) if removal fails — same rationale as [`/unlink`](#role-revocation-on-unlink).
- Malformed percent-encoding in `GET /link/:email` is rejected with `400` instead of surfacing as an uncaught exception.

### `/link` slash command — proof of email ownership

The linking flow requires the Discord user to first obtain a code from the Ghost site:

1. The Ghost site (logged-in member session) fetches `/members/api/entitlements` and calls `POST /code` with the resulting Ghost-issued member entitlement JWT (5-minute expiry).
2. The Worker verifies the JWT signature against Ghost's published JWKS — only an authenticated Ghost session can produce a valid JWT — and requires `scope === "members:entitlements:read"` with a boolean `paid` claim. Identity tokens (`/members/api/session`) are rejected, so a token issued for a different purpose cannot be replayed here.
3. The Worker writes `code:<CODE> → {"email", "paid"}` to KV with a 10-minute TTL and returns the code.
4. The user types `/link <CODE>` in Discord. The Worker reads `{ email, paid }` from KV, applies 1:1 conflict checks, **deletes the code** (single-use), then writes the mapping and assigns roles from `paid`.

This closes the impersonation gap from earlier designs: an attacker can no longer claim an arbitrary Ghost email by guessing it in Discord, because they cannot mint a valid JWT without controlling the Ghost session for that email. Discord-side conflict checks (below) defend against an attacker who somehow obtains a code in transit.

### 1:1 mapping conflict checks

Two conflict checks still run before any KV write or role assignment (and before the code is consumed, so a rejected attempt does not burn the code):

1. **Email-side**: If the email (resolved from the code) is already mapped to a different Discord user, reject.
2. **Discord-side**: If the invoking Discord user is already linked to a different email, reject and require `/unlink` first.

Re-linking the same `(email, userId)` pair is idempotent.

### Role revocation on unlink

Roles are only ever revoked through a mapping: Ghost webhooks look up `email → discord_user_id`. If `/unlink` deleted the mapping but left the roles, nothing could revoke them later, and a single membership could hand roles to an unlimited number of Discord accounts (link account A, unlink, mint a new code, link account B, …). `/unlink` and admin `DELETE /link` therefore remove the Member and Premium roles **first** and delete the mapping only if removal succeeded. A Discord `404` (member already left the guild) counts as success. Any other failure keeps the mapping, so webhooks still govern the roles and the operation can be retried.

### KV write budget (`POST /code`)

Before, every `POST /code` call wrote a new code, so any logged-in member could script it and exhaust the KV free-tier quota (1,000 writes/day), breaking linking for everyone. Now:

- **One live code per member.** `pending:<email>` points to the member's current code. While it has ≥ 120 s left, the same `paid` value, and `code:<CODE>` still holds the email, the same code is returned and **nothing is written**. A new code (two writes) is minted only when there is no reusable one.
- **Optional per-member rate limit.** If the `CODE_RATE_LIMITER` binding is configured ([08 — Configuration](./08-configuration.md#rate-limiting-optional)), calls beyond its limit (sample: 5 per 60 s per email) get `429` with `Retry-After: 60`.

Only members can reach this code path (a valid Ghost-signed JWT is required first), so the budget cannot be drained anonymously.

### Code security properties

- **Entropy**: 8 chars × log₂(32) = 40 bits. Combined with the 10-minute TTL, brute-force redemption is impractical (`/link` redemption itself is not rate-limited by the Worker, but Discord slash command latency and Discord's own per-user limits cap attack throughput sharply).
- **Lifetime**: `expirationTtl: 600` on the KV write, plus explicit delete on successful redemption.
- **Single-use**: Once the conflict checks pass, `/link` deletes the code entry **before** writing the mapping; subsequent attempts see "Invalid or expired code." See [Residual risks](#residual-risks) for the limits of this under KV's eventual consistency.
- **Out-of-band channel**: The code travels browser → Ghost-site display → user's screen → Discord client. There is no transmission of the code via email, SMS, or any other channel that could be intercepted.
- **Scope**: The code unlocks only the email it was minted for (and grants Premium only if `paid` was true in the signed token); it carries no other authority.
- **Integrity of the stored value**: `{ email, paid }` is written only by `POST /code` after signature verification. A malformed or legacy (bare-email) value is treated as "Invalid or expired code".

### Tier status freshness (entitlement snapshot)

The `paid` flag comes from Ghost's entitlement JWT (`paid = member.status !== "free"`, so comped counts as paid), captured when the code is minted. The Worker no longer calls the Ghost Admin API at redemption (suggestion from Cathy_Sarisky on the [Ghost forum](https://forum.ghost.org/t/discord-ghost-role-sync/61933/8)), which removes the need for a Ghost Admin API key entirely.

Trade-off:

- The status used at `/link` time is a **snapshot** up to 10 minutes old (code TTL).
- Once the mapping exists, later status changes are handled by the `member.updated` / `member.deleted` webhooks as usual.
- A status change (upgrade, downgrade, cancellation) or a deletion **invalidates the member's pending code**: the `member.updated` (status changed) and `member.deleted` webhooks delete `pending:<email>` and the `code:<CODE>` it points to, whether or not the member is linked yet. The member simply requests a new code, which carries the new status.
- Without this, a paid member could mint a code, cancel, then redeem the old `paid: true` code (the idempotent re-link path accepts it) and regain Premium indefinitely; a deleted member could also recover their roles the same way.
- Remaining window: the webhook and the redemption race only if Ghost's webhook is delayed past the `/link`; the role is then corrected by the next status change.

The admin `POST /link` endpoint does not consult Ghost at all (trusted caller) and assigns no roles. Admin `DELETE /link` removes the roles (see [Role revocation on unlink](#role-revocation-on-unlink)).

### Email validation

`isValidEmail` (in `src/utils.ts`) applies an RFC 5322-style regex and a 254-character maximum (RFC 5321 limit). Applied at all entry points that accept emails:

- `/link` slash command
- `POST /link` admin
- `DELETE /link` admin
- `GET /link/:email` admin (after percent-decoding; a malformed encoding is a `400`)

Webhook payloads are **not** re-validated against this regex — Ghost is trusted to send well-formed emails. (Emails are still lowercased before KV access.)

### Email enumeration

`/link` now takes a **code**, not an email, so it no longer leaks Ghost membership information. The `POST /code` endpoint requires a valid Ghost member entitlement JWT, so it also cannot be used to probe membership — only members can call it, and they already know their own email.

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

## No Persistent PII Beyond Linkage

The KV store contains only `email ↔ discord_user_id` pairs, plus short-lived (≤ 10 min) `code:<CODE> → { email, paid }` entries. No names, payment data, or other PII is persisted, and no tier status is kept beyond the code TTL. Ghost remains the source of truth for member data; the worker holds only the bridge.

## Hardening Notes (current code)

The following defenses are implemented in code; tests cover each path.

- **Entitlement scope check** (`src/code.ts`). `POST /code` requires `scope === "members:entitlements:read"` and a boolean `paid` claim; identity tokens and tokens missing `paid` are rejected with `401`.
- **Discord signature throw-safety** (`src/discord.ts:verifyDiscordSignature`). Hex decoding and key import are wrapped in `try/catch`; any failure returns `null` → `401`. A malformed `X-Signature-Ed25519` header can no longer surface as a 500.
- **Required JWT `kid`** (`src/jwt.ts`). JWTs without a `kid` header are rejected before key lookup, removing the "first key in JWKS" fallback that could mask key rotation.
- **JWKS refresh on unknown `kid`** (`src/jwt.ts`). An unknown `kid` forces one JWKS refetch, at most once per minute per isolate. Ghost key rotation is picked up immediately instead of failing for up to the 1-hour cache lifetime, and forged random `kid`s cannot make the Worker hammer Ghost's JWKS endpoint.
- **Required JWT `iss` and `aud`** (`src/jwt.ts:sameOrigin`). Both claims must be present and match `GHOST_URL` by parsed URL origin (scheme + host + port); `aud` may be a string or an array. Prefix-matching attacks like `iss=https://ghost.test.attacker.com` are rejected even if `GHOST_URL` starts with the same string, and a token lacking these claims is no longer accepted on the strength of the signature alone.
- **Discord interaction timestamp window** (`src/discord.ts:verifyDiscordSignature`). `X-Signature-Timestamp` must be an integer within ±5 minutes of now; otherwise `401`.
- **Roles removed on unlink** (`src/commands.ts`, `src/admin.ts`). `/unlink` and admin `DELETE /link` remove both roles before deleting the mapping and keep the mapping when removal fails.
- **Code consumed before mapping write** (`src/commands.ts`). Narrows the double-redemption window (see [Residual risks](#residual-risks)).
- **One live code per member + optional rate limit** (`src/code.ts`). Bounds KV writes from `POST /code`.
- **Admin input validation** (`src/admin.ts`, `src/index.ts`). Snowflake check on `discord_user_id`, stale reverse-entry cleanup on `POST /link`, `400` on malformed percent-encoding in `GET /link/:email`.
- **Defensive `userId` resolution** (`src/commands.ts`). Slash command handlers accept either `member.user.id` (guild interactions) or `user.id` (DM/user-app interactions). If neither is present, the interaction is rejected with a polite ephemeral reply rather than writing `discord:undefined` to KV.

## Residual Risks

- **Double redemption under eventual consistency.** Deleting the code before writing the mapping closes the race between two concurrent `/link` calls handled in the same Cloudflare location — which is the normal case, since Discord sends interactions from its own infrastructure. KV is eventually consistent across locations, though, so this is not a strict guarantee: a second redemption served by another location could still read the code before the delete propagates. A strict single-use guarantee would need a strongly consistent store (Durable Objects). The impact is bounded to that one code: only the last writer ends up in the forward `email → discord_user_id` key that webhooks use, so the other Discord account could keep roles that no webhook will revoke (an admin can spot it via its leftover `discord:<id>` key and remove the roles by hand).
- **Code reuse relies on KV reads.** For the same reason, two near-simultaneous `POST /code` calls (or calls served by different locations) can each mint a code. Each is still single-use and expires after 10 minutes; the optional rate limiter (itself approximate and per location) is the cap on repeated calls.
- **Webhook replay within the 5-minute window.** There is no nonce store, so a captured Ghost webhook can be replayed while its timestamp is fresh. The operations are idempotent (adding a role that is present, removing one that is absent), so a replay can only re-apply the state Ghost already announced.
- **Stale roles after an admin re-link.** `POST /link` cleans up stale KV entries but does not touch Discord roles: if it moves an email to a new Discord user, the previous user keeps whatever roles they had. Use `DELETE /link` first when reassigning.
