# 10 — Error Handling & Observability

## HTTP Response Status Codes

| Code | Meaning | Used when |
|------|---------|-----------|
| 200 | Success | Normal completion, **also** for "skipped" webhook events with no mapping |
| 400 | Bad Request | Malformed JSON, missing required fields, invalid email format (including malformed percent-encoding in `GET /link/:email`), invalid `discord_user_id`, unknown interaction type |
| 401 | Unauthorized | Signature/bearer verification failed (Ghost, Discord, or admin), including a Discord timestamp outside the ±5-minute window |
| 404 | Not Found | Unknown route, **or** `GET /link/:email` for a non-existent mapping |
| 429 | Too Many Requests | `POST /code` over the optional `CODE_RATE_LIMITER` limit (with `Retry-After: 60`) |
| 502 | Bad Gateway | Admin `DELETE /link` could not remove the Discord roles; the mapping is kept |

The only 5xx the worker returns explicitly is the `502` above. Any other 5xx would indicate an uncaught exception bubbling out of a handler.

## Error Body Shape

All error responses use a uniform shape:

```json
{ "error": "<short human description>" }
```

No structured error codes, no stack traces, no request IDs. The one exception is the admin `DELETE /link` `502`, which adds a `details` array with the failed Discord calls (`"DELETE role <id>: <status> <body>"`) — acceptable because the endpoint is admin-only.

## Failure Modes

### Ghost webhook — signature failure

- `verifyGhostSignature` returns `null` for any of: missing header, missing `sha256=` or `t=` parts, expired timestamp, body tampering.
- Handler responds `401 { "error": "Unauthorized" }`.
- No log line is written by the verification function itself.

### Ghost webhook — no mapping for email

- Returns `200 { "ok": true, "skipped": true, "reason": "no_mapping" }`.
- Logs `No Discord mapping found for email: <email>` at warn level.
- **Why 200, not 404?** A non-2xx would cause Ghost to retry indefinitely. The user simply hasn't linked their Discord — this is a valid, expected state.

### Ghost webhook — malformed payload

- `400 { "error": "Invalid JSON" }` for JSON parse failures.
- `400 { "error": "Invalid payload: missing member email" }` if neither `current.email` (add/update) nor `previous.email` (delete) is present.

### Ghost webhook — Discord API failure during role mutation

- `modifyMemberRole` logs `Discord <METHOD> role <ID> failed: <status> <body>`.
- The error is **returned** from `modifyMemberRole`, but `handleMemberAdded` / `handleMemberUpdated` / `handleMemberDeleted` ignore the return value.
- The handler still responds `200 { "ok": true }`.
- **Consequence:** transient Discord outages can produce role drift that is not retried or reported.

### Discord interaction — signature failure

- `verifyDiscordSignature` returns `null` for missing headers, a non-integer or stale `X-Signature-Timestamp` (more than 5 minutes from the Worker's clock, either direction), or an invalid signature.
- Handler responds `401 { "error": "Invalid signature" }`.

### Discord interaction — unknown command name

- Handler replies with ephemeral message: `"Unknown command."`.
- HTTP status is `200` (because the interaction itself was valid).

### `POST /code` — invalid JWT

- `verifyGhostMemberJWT` returns `null` for any of: malformed JWT, wrong algorithm, JWKS fetch failure, unknown `kid` (after the forced JWKS refetch, or when one already happened in the last minute), signature mismatch, expired `exp`, missing or mismatched `iss`, missing or mismatched `aud`.
- Handler responds `401 { "error": "Invalid token" }` with CORS headers.
- JWKS fetch errors are logged server-side as `JWKS fetch error: <err>`.

### `POST /code` — not an entitlement token

- If the verified JWT's `scope` is not `"members:entitlements:read"` or its `paid` claim is not a boolean, the handler responds `401 { "error": "Expected an entitlement token from /members/api/entitlements" }` with CORS headers.
- Typical cause: the widget still fetches `/members/api/session` (identity token), or the Ghost version predates `/members/api/entitlements`.

### `POST /code` — missing email in claims

- If `payload.sub` (the member email) is missing from the verified JWT, the handler responds `400 { "error": "Token missing email claim" }`.
- Indicates a Ghost JWT format change or a non-member token mistakenly accepted by JWKS — should be investigated.

### `POST /code` — rate limited

- Only when the optional `CODE_RATE_LIMITER` binding is configured: over the limit for this member's email, the handler responds `429 { "error": "Too many requests, please wait a minute" }` with `Retry-After: 60` and CORS headers.
- The widget shows the error message as-is. The member can click again after a minute; their still-valid code is returned unchanged.

### `/link <code>` — invalid or expired code

- KV lookup for `code:<code>` returns null, or a value that is not valid `{ email: string, paid: boolean }` JSON (e.g. a legacy bare-email value minted before the entitlement change). Could mean: never issued, already redeemed, TTL expired, or malformed value.
- Handler replies with the generic `"Invalid or expired code. Visit your Ghost site to generate a new one."` — the same message for all causes, by design (no enumeration).

### `/link` slash command — role assignment failure

- The code is **already consumed** and the KV mapping **already written** before role assignment runs.
- `addRole` failures are collected into an `errors[]` array.
- If any role failed, the handler:
  - Logs `Role assignment errors for <email>: <joined errors>`.
  - Replies: `"Your email <email> has been linked, but roles could not be assigned. Please contact an administrator."`
- The mapping is **not** rolled back. The code is gone, so the user retries by minting a new code and running `/link` again (idempotent reapplication for the same account) once Discord recovers.

### `/unlink` — role removal failure

- Roles are removed **before** the mapping is deleted. A Discord `404` (member left the guild) counts as success.
- Any other `removeRole` failure is collected; the handler logs `Role removal errors for <email>: <joined errors>`, leaves both KV keys in place, and replies: `"Your roles could not be removed, so your account is still linked. Please try again later or contact an administrator."`
- Keeping the mapping is deliberate: webhooks keep governing the roles, and the user can simply retry `/unlink`.

### Admin `DELETE /link` — role removal failure

- Same order as `/unlink`: both roles are removed first. On any non-404 failure, the handler responds `502 { "error": "Role removal failed; mapping kept", "details": [...] }` and deletes nothing.
- Fix the cause (usually the bot's role hierarchy) and retry the `DELETE`.

### Admin `/link` — KV write partial failure

- `POST /link` issues two `get`s, up to two stale-entry `delete`s, then two `put`s sequentially; `DELETE /link` issues a `get`, up to two Discord role removals, then up to two `delete`s. KV operations rarely fail but do not have transactional guarantees.
- A partial failure can leave the mapping in an inconsistent state (e.g., forward key present, reverse key absent).
- No automatic reconciliation. An operator can recover by issuing the missing operation manually via re-`POST` or `DELETE`.

## Logging

All logging uses `console.log`, `console.warn`, and `console.error`. Output is visible via `wrangler tail` and Cloudflare's dashboard.

| Level | Triggers |
|-------|----------|
| `console.log` | Code issuance (`code issued for <email> (paid=<bool>)`), successful event processing: `member.added`, `member.updated (free->paid)`, `member.updated (paid->free)`, `member.deleted` |
| `console.warn` | Webhook arrived for an unmapped email |
| `console.error` | JWKS fetch failures, Discord API failures, role assignment failures, `/unlink` role removal failures |

There is **no structured logging** (JSON) and **no correlation ID**. Adding either would be a worthwhile enhancement for production observability but is out of scope of the current implementation.

## What is NOT Implemented

- No retries on Discord API or JWKS fetch failures.
- No queue, dead-letter, or async deferral (`waitUntil` is not used).
- No metrics export (counters, timers).
- No alerting hooks.
- No request rate limiting beyond Cloudflare's defaults, except the optional per-member `CODE_RATE_LIMITER` on `POST /code`.
- No graceful handling of KV `put`/`get` exceptions (would currently surface as a 500 from the runtime).

## Recovery Playbook

| Symptom | Likely Cause | Action |
|---------|--------------|--------|
| User reports they're a paid member but lack the Premium role | Ghost webhook delivered before user linked, **or** transient Discord 5xx | Admin runs `POST /link` to set mapping, then re-trigger a Ghost member update to fire the webhook, or assign role manually in Discord |
| `/link` returns "email already linked to another Discord account" for the legitimate owner | Previous user claimed mapping (intentional or accidental) | Admin `DELETE /link` to clear, then user retries `/link` |
| Webhooks return 401 consistently | `WEBHOOK_SECRET` mismatch between Cloudflare and Ghost | Re-set the secret in both places |
| `POST /code` returns 401 `Invalid token` for valid Ghost session | `GHOST_URL` does not match the JWT `iss` / `aud` origin (scheme, `www`, trailing slash), or the JWKS endpoint is unreachable | Fix `GHOST_URL`; check `JWKS fetch error` in `wrangler tail`. Key rotation is picked up automatically (unknown `kid` forces a JWKS refetch, at most once per minute) |
| `POST /code` returns 429 | Optional `CODE_RATE_LIMITER` limit reached for this member | Wait a minute; raise `limit` in `[[ratelimits]]` if legitimate traffic hits it |
| `/unlink` says roles could not be removed, or admin `DELETE /link` returns 502 | Bot role below the managed roles, **Manage Roles** missing, or Discord outage | Fix the role hierarchy, then retry; the mapping was kept on purpose |
| `POST /code` returns 401 `Expected an entitlement token…` | Widget fetches `/members/api/session` instead of `/members/api/entitlements`, or Ghost is too old to expose entitlements | Update the widget snippet ([08 — Configuration](./08-configuration.md)); upgrade to a recent Ghost 6.x |
| User was paid but got no Premium role on `/link` (or vice versa) | Tier changed between minting and redeeming, and Ghost's webhook arrived after the `/link` (a status change normally invalidates the pending code) | Re-trigger a Ghost member update, or fix the role manually in Discord |
| *"Invalid or expired code"* right after a plan change | Expected: a status change or deletion invalidates the pending code | Generate a new code |
| `/link` says "Invalid or expired code" immediately after minting | Code TTL elapsed (>10 min between page load and Discord redemption), or KV write hadn't propagated | Mint a new code; KV is eventually consistent across regions |
| Discord interactions return 401 | `DISCORD_PUBLIC_KEY` is wrong/outdated | Copy from Discord Developer Portal → `wrangler secret put` |
| Role mutations log 403 | Bot role is below managed roles in hierarchy | Move bot role above `Member` / `Premium Member` in Discord server settings |
