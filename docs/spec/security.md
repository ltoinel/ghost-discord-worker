# Security

## Authentication schemes

Each trust boundary has its own scheme. Secret strings are compared with `timingSafeEqual` (`src/utils.ts`: loops over the longer input and folds the length difference into the result); signatures are checked with Web Crypto.

| Caller → route | Scheme | Key material | Replay bound |
|---|---|---|---|
| Browser → `POST /code` | Ghost entitlement JWT, RS256/RS384/RS512 | Ghost JWKS (`GHOST_URL`) | Token `exp` (5 min) |
| Ghost → `/webhook/*` | `X-Ghost-Signature`, HMAC-SHA256 | `WEBHOOK_SECRET` | `t` within ±5 min |
| Discord → `/discord` | Ed25519 | `DISCORD_PUBLIC_KEY` | Timestamp within ±5 min |
| Operator → `/link*` | `Authorization: Bearer` | `ADMIN_SECRET` | — |
| Worker → Discord API | `Authorization: Bot <token>` | `DISCORD_BOT_TOKEN` | — |
| Worker → Ghost JWKS | None (public) | — | — |

Every check fails closed: any parse error, missing header or crypto exception means "not authenticated".

### Entitlement token (`POST /code`)

The browser gets it from `GET /members/api/entitlements`, which Ghost serves only to a logged-in member, signed with the same site key as identity tokens. The design (an entitlement token carrying `paid`, instead of an identity token plus a Ghost Admin API lookup) was suggested by Cathy_Sarisky on the [Ghost forum](https://forum.ghost.org/t/discord-ghost-role-sync/61933/8). `verifyGhostMemberJWT` (`src/jwt.ts`):

1. Requires three base64url segments, `alg` in `RS256` / `RS384` / `RS512` (Ghost uses RS512) and a non-empty `kid`.
2. Picks the JWK whose `kid` matches from `<GHOST_URL>/members/.well-known/jwks.json`, never "the first key".
3. Verifies the RSASSA-PKCS1-v1_5 signature with the hash matching `alg`.
4. Requires `exp` in the future, and `iss` and `aud` both present with a URL **origin** equal to `GHOST_URL`'s (`new URL()`, not a prefix match; `aud` may be a string or an array).

`handleCodePost` then requires `scope === "members:entitlements:read"` and a boolean `paid`, so an identity token (`members:identity`) is refused. The email is `sub`, lowercased.

**JWKS cache.** The key set is cached per isolate for 1 hour. An unknown `kid` (typically right after Ghost rotates keys) forces one refetch, at most once per minute per isolate, so rotation is picked up immediately and forged random `kid`s cannot make the Worker hammer Ghost.

### Ghost webhooks

Header `X-Ghost-Signature: sha256=<hex>, t=<unix ms>`. The Worker rejects a missing part or a `t` more than 5 minutes from its clock, computes `HMAC-SHA256(WEBHOOK_SECRET, body + t)` and compares hex digests in constant time. The body is parsed only after the signature matches.

### Discord interactions

Headers `X-Signature-Ed25519` (hex) and `X-Signature-Timestamp` (integer seconds, within ±5 minutes). The signature covers `timestamp + body`. Malformed hex or a bad key returns `401`, never `500`.

### Admin Bearer

`Authorization: Bearer <ADMIN_SECRET>`, exact match in constant time. No prefix tolerance, no rotation mechanism other than replacing the secret.

## Threat model

**In scope**

- Forged or replayed Ghost webhooks or Discord interactions.
- Claiming someone else's Ghost email from Discord (account hijacking).
- Role multiplication: one membership granting roles to several Discord accounts.
- Regaining Premium (or roles after deletion) with a code minted before a status change.
- A logged-in member scripting `POST /code` to exhaust the KV write budget (free tier: 1,000 writes/day).
- Unauthorized use of the admin API; membership enumeration; timing attacks on secrets.

**Out of scope**

- Compromise of the Cloudflare account, the Discord bot token or Discord's signing keys.
- Compromise of the Ghost member signing key: it is trusted for both email ownership and `paid`.
- Volumetric DoS against the Worker (Cloudflare's job).

## Mitigations

- **Proof of ownership.** A code can only be minted from a Ghost-signed entitlement token, so only someone holding the member's Ghost session can link that email. `/link` takes a code, never an email.
- **Codes.** 8 Crockford base32 characters (40 bits) from `crypto.getRandomValues`, 10-minute TTL, deleted on redemption before the mapping is written. Brute force within the TTL is impractical; Discord's own rate limits cap `/link` attempts further.
- **Codes scoped to one email.** A code unlocks only the email it was minted for, and Premium only if the signed token said `paid`. Its KV value is written only after verification.
- **1:1 conflict checks** run before the code is consumed, so a rejected attempt does not burn it.
- **Roles before mapping.** `/unlink` and `DELETE /link` remove both roles first and keep the mapping if that fails, so no account keeps roles that no webhook can revoke.
- **Pending-code invalidation.** See [Tier status freshness](#tier-status-freshness).
- **KV write budget.** One live code per member (reuse costs reads only); optional `CODE_RATE_LIMITER`, 5 calls per 60 s per email in the sample, answering `429`. Only verified members reach this path.
- **Admin input validation.** Emails checked by `isValidEmail` (RFC 5322-style regex, ≤ 254 characters) on all three admin routes; `discord_user_id` must be a 17–20 digit snowflake; malformed percent-encoding is a `400`; stale reverse entries are deleted on re-link.
- **No `discord:undefined`.** An interaction without a user ID gets a polite reply and touches nothing.
- **CORS** on `/code` is locked to `GHOST_URL`; no other route sends CORS headers.
- **No enumeration.** `/link` answers the same message for every invalid code; `POST /code` requires a member token; only the admin `GET /link/:email` reveals a mapping.
- **No leaks.** Discord and JWKS error bodies go to `console.error`, never to end users (except the admin-only `502 details`). No secret is ever logged.

## Tier status freshness

`/link` does not ask Ghost for the member's status. It uses the `paid` flag from the entitlement token, captured when the code was minted: a **snapshot** at most 10 minutes old. Once the mapping exists, webhooks keep the roles current.

To keep that snapshot honest, a `member.updated` that changes `status` (including `paid` ↔ `comped`) and every `member.deleted` delete the member's pending code (`pending:<email>` and the `code:<CODE>` it names), **whether or not the member is linked**. The member just requests a new code, which carries the new status. Without this, a member could mint a `paid: true` code, cancel, then redeem it through the idempotent re-link path and regain Premium indefinitely; a deleted member could recover their roles the same way.

Remaining window: if Ghost's webhook is delayed until after the `/link`, the roles reflect the old status until the next change.

## Secrets

- Production secrets live in Cloudflare's encrypted store (`wrangler secret put`, or `./deploy.sh --secrets <file>`); locally in `.dev.vars`, which is git-ignored (as are `.env*` files).
- They are read only from the `Env` object passed to each handler; no globals.
- **Rotation:** `npx wrangler secret put <NAME>` takes effect without a redeploy. `WEBHOOK_SECRET` must change in Ghost at the same time, the bot token must be reset in the Developer Portal first, and `DISCORD_PUBLIC_KEY` is set by Discord. See [Operations → Rotate a secret](../operations.md#rotate-a-secret).

## Personal data

KV holds only `email ↔ Discord user ID` pairs, plus codes and pending pointers (email and `paid`) that expire after 10 minutes. No names, payment data or tier history are stored; Ghost remains the source of truth. Logs contain emails (`wrangler tail`, Cloudflare dashboard).

## Residual risks

- **KV eventual consistency.** Deleting the code before writing the mapping prevents double redemption within one Cloudflare location (the normal case, since Discord calls from its own infrastructure), not across locations. Only the last writer ends up in the forward key that webhooks use, so the other account could keep roles no webhook revokes; an admin can spot its leftover `discord:<id>` key. A strict guarantee would need Durable Objects. Likewise, near-simultaneous `POST /code` calls can each mint a code.
- **Webhook replay within 5 minutes.** There is no nonce store. Role operations are idempotent, so a replay only re-applies the state Ghost announced.
- **Admin re-link keeps the previous user's roles.** `POST /link` fixes KV but not Discord roles. Run `DELETE /link` first when moving an email to another account.
- **Codes are bearer tokens.** Whoever types a code first gets the link. A member who shares their code (screenshot, chat) links their email to someone else's account; the widget warns that the code is personal.
- **Multi-account KV budget.** The rate limit and code reuse are per email, and approximate per location. A member controlling many Ghost accounts can still mint one code pair per account roughly every 8 minutes.
- **Entitlement token replay.** A captured token can mint (or fetch the live) code for that member until its `exp`, about 5 minutes. It travels only between the member's browser, Ghost and the Worker over HTTPS.
- **Role failures on webhooks are not retried.** The Worker answers `200` even if Discord failed; the drift lasts until the next event or a manual fix.
