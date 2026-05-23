# 10 — Error Handling & Observability

## HTTP Response Status Codes

| Code | Meaning | Used when |
|------|---------|-----------|
| 200 | Success | Normal completion, **also** for "skipped" webhook events with no mapping |
| 400 | Bad Request | Malformed JSON, missing required fields, invalid email format, unknown interaction type |
| 401 | Unauthorized | Signature/bearer verification failed (Ghost, Discord, or admin) |
| 404 | Not Found | Unknown route, **or** `GET /link/:email` for a non-existent mapping |

The worker never returns 5xx explicitly. A 5xx would indicate an uncaught exception bubbling out of a handler.

## Error Body Shape

All error responses use a uniform shape:

```json
{ "error": "<short human description>" }
```

No structured error codes, no stack traces, no request IDs.

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

- `verifyDiscordSignature` returns `null` for missing headers or invalid signature.
- Handler responds `401 { "error": "Invalid signature" }`.

### Discord interaction — unknown command name

- Handler replies with ephemeral message: `"Unknown command."`.
- HTTP status is `200` (because the interaction itself was valid).

### `POST /code` — invalid JWT

- `verifyGhostMemberJWT` returns `null` for any of: malformed JWT, wrong algorithm, JWKS fetch failure, signature mismatch, expired `exp`, mismatched `iss`.
- Handler responds `401 { "error": "Invalid token" }` with CORS headers.
- JWKS fetch errors are logged server-side as `JWKS fetch error: <err>`.

### `POST /code` — missing email in claims

- If neither `payload.email` nor `payload.sub` is present in the verified JWT, the handler responds `400 { "error": "Token missing email claim" }`.
- Indicates a Ghost JWT format change or a non-member token mistakenly accepted by JWKS — should be investigated.

### `/link <code>` — invalid or expired code

- KV lookup for `code:<code>` returns null. Could mean: never issued, already redeemed, or TTL expired.
- Handler replies with the generic `"Invalid or expired code. Visit your Ghost site to generate a new one."` — the same message for all three causes, by design (no enumeration).

### `/link` slash command — Ghost API unreachable

- `getGhostMember` catches `fetch` exceptions, logs `Ghost API fetch error: <err>`, and returns `{ status: "error", message: "Unable to reach Ghost API." }`.
- Handler replies: `"An error occurred while verifying your email: Unable to reach Ghost API."`.
- No KV write or role assignment happens.

### `/link` slash command — Ghost API non-2xx

- Logs `Ghost API error: <status> <body>`.
- Returns `{ status: "error", message: "Ghost API returned <status>." }`.
- Handler replies with the same generic "An error occurred…" template.

### `/link` slash command — role assignment failure

- KV mapping is **already written** before role assignment runs.
- `addRole` failures are collected into an `errors[]` array.
- If any role failed, the handler:
  - Logs `Role assignment errors for <email>: <joined errors>`.
  - Replies: `"Your email <email> has been linked, but roles could not be assigned. Please contact an administrator."`
- The mapping is **not** rolled back. The user can retry `/link` later (idempotent reapplication) once Discord recovers.

### Admin `/link` — KV write partial failure

- `POST /link` issues two `put`s sequentially; `DELETE /link` issues a `get` then up to two `delete`s. KV operations rarely fail but do not have transactional guarantees.
- A partial failure can leave the mapping in an inconsistent state (e.g., forward key present, reverse key absent).
- No automatic reconciliation. An operator can recover by issuing the missing operation manually via re-`POST` or `DELETE`.

## Logging

All logging uses `console.log`, `console.warn`, and `console.error`. Output is visible via `wrangler tail` and Cloudflare's dashboard.

| Level | Triggers |
|-------|----------|
| `console.log` | Successful event processing: `member.added`, `member.updated (free->paid)`, `member.updated (paid->free)`, `member.deleted` |
| `console.warn` | Webhook arrived for an unmapped email |
| `console.error` | Ghost API failures, Discord API failures, role assignment failures |

There is **no structured logging** (JSON) and **no correlation ID**. Adding either would be a worthwhile enhancement for production observability but is out of scope of the current implementation.

## What is NOT Implemented

- No retries on Discord or Ghost API failures.
- No queue, dead-letter, or async deferral (`waitUntil` is not used).
- No metrics export (counters, timers).
- No alerting hooks.
- No request rate limiting beyond Cloudflare's defaults.
- No graceful handling of KV `put`/`get` exceptions (would currently surface as a 500 from the runtime).

## Recovery Playbook

| Symptom | Likely Cause | Action |
|---------|--------------|--------|
| User reports they're a paid member but lack the Premium role | Ghost webhook delivered before user linked, **or** transient Discord 5xx | Admin runs `POST /link` to set mapping, then re-trigger a Ghost member update to fire the webhook, or assign role manually in Discord |
| `/link` returns "email already linked to another Discord account" for the legitimate owner | Previous user claimed mapping (intentional or accidental) | Admin `DELETE /link` to clear, then user retries `/link` |
| Webhooks return 401 consistently | `WEBHOOK_SECRET` mismatch between Cloudflare and Ghost | Re-set the secret in both places |
| `POST /code` returns 401 for valid Ghost session | JWKS cache holds a rotated key, or `GHOST_URL` does not match the JWT issuer | Wait up to 1 hour for cache expiry, or redeploy the Worker to clear the per-isolate cache |
| `/link` says "Invalid or expired code" immediately after minting | Code TTL elapsed (>10 min between page load and Discord redemption), or KV write hadn't propagated | Mint a new code; KV is eventually consistent across regions |
| Discord interactions return 401 | `DISCORD_PUBLIC_KEY` is wrong/outdated | Copy from Discord Developer Portal → `wrangler secret put` |
| Role mutations log 403 | Bot role is below managed roles in hierarchy | Move bot role above `Member` / `Premium Member` in Discord server settings |
