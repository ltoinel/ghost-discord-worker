# API reference

Every response is JSON (`Content-Type: application/json`), except the `204` preflight. What each call does step by step is in [How it works](flows.md); the authentication schemes are detailed in [Security](security.md#authentication-schemes).

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/code` | Ghost entitlement JWT in the body | Get a linking code |
| `OPTIONS` | `/code` | — | CORS preflight |
| `POST` | `/discord` | Discord Ed25519 signature | Slash commands and PING |
| `POST` | `/webhook/added` | `X-Ghost-Signature` | Ghost `member.added` |
| `POST` | `/webhook/updated` | `X-Ghost-Signature` | Ghost `member.updated` |
| `POST` | `/webhook/deleted` | `X-Ghost-Signature` | Ghost `member.deleted` |
| `POST` | `/link` | `Authorization: Bearer` | Create a mapping (admin) |
| `GET` | `/link/:email` | `Authorization: Bearer` | Read a mapping (admin) |
| `DELETE` | `/link` | `Authorization: Bearer` | Remove roles and mapping (admin) |

Any other method or path returns `404 { "error": "Not found" }`.

## `POST /code`

**Auth:** an entitlement JWT from `GET /members/api/entitlements` (RS256/384/512), with `scope: "members:entitlements:read"` and a boolean `paid` claim. Identity tokens from `/members/api/session` are rejected.

```json
{ "token": "<entitlement JWT>" }
```

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "code": "G7K9MN2X", "expires_in": 600 }` | New code, or the member's live code with its remaining seconds (≥ 120) |
| 400 | `{ "error": "Invalid JSON" }` | Body is not JSON |
| 400 | `{ "error": "Missing token" }` | No `token` field |
| 400 | `{ "error": "Token missing email claim" }` | Verified token without `sub` |
| 401 | `{ "error": "Invalid token" }` | Bad signature, unknown `kid`, wrong `alg`, expired, `iss` / `aud` mismatch, JWKS unreachable |
| 401 | `{ "error": "Expected an entitlement token from /members/api/entitlements" }` | Valid token, wrong `scope` or no boolean `paid` (e.g. an identity token) |
| 429 | `{ "error": "Too many requests, please wait a minute" }` | Over the optional `CODE_RATE_LIMITER`; adds `Retry-After: 60` |

### CORS

`/code` is the only route meant for a browser. Every `/code` response, errors included, carries:

```
Access-Control-Allow-Origin: <GHOST_URL>
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
Vary: Origin
```

`OPTIONS /code` returns `204` with the same headers. Behind the nginx proxy the call is same-origin and these headers are inert.

## `POST /discord`

**Auth:** `X-Signature-Ed25519` (hex) over `X-Signature-Timestamp + body`, verified with `DISCORD_PUBLIC_KEY`; the timestamp (seconds) must be within ±5 minutes.

| Interaction | Response |
|---|---|
| PING (`type: 1`) | `200 { "type": 1 }` |
| Command (`type: 2`) | `200 { "type": 4, "data": { "content": "<reply>", "flags": 64 } }` (ephemeral) |
| Any other type | `400 { "error": "Unknown interaction type" }` |
| Bad or stale signature | `401 { "error": "Invalid signature" }` |

### Slash commands

| Command | Option | Effect |
|---|---|---|
| `/link` | `code` (string, required) | Redeem a linking code ([flow](flows.md#2-redeeming-it-link-code)) |
| `/unlink` | — | Remove roles, then the mapping ([flow](flows.md#unlinking-unlink)) |

The Worker does not register them; `./deploy.sh --register-commands` or the [manual call](../setup/3-connect-discord.md#32-check-the-slash-commands) does. Replies, verbatim from `src/commands.ts` (`<email>` is the linked email, rendered in bold by Discord):

| When | Reply |
|---|---|
| No user ID in the interaction | `Unable to identify your Discord account. Please try again from a server channel.` |
| Command other than `link` / `unlink` | `Unknown command.` |
| `/link` without a code | `Please provide your linking code. Visit your Ghost site to generate one.` |
| `/link`: code unknown, expired, used or malformed | `Invalid or expired code. Visit your Ghost site to generate a new one.` |
| `/link`: email linked to another account | `This email is already linked to another Discord account.` |
| `/link`: Discord account linked to another email | ``Your Discord account is already linked to **<email>**. Use `/unlink` first.`` |
| `/link`: linked, a role call failed | `Your email **<email>** has been linked, but roles could not be assigned. Please contact an administrator.` |
| `/link`: success | `Your email **<email>** has been linked to your Discord account.` |
| `/unlink`: nothing linked | `No email is linked to your Discord account.` |
| `/unlink`: role removal failed, mapping kept | `Your roles could not be removed, so your account is still linked. Please try again later or contact an administrator.` |
| `/unlink`: success | `Your email **<email>** has been unlinked from your Discord account and your roles have been removed.` |

## `POST /webhook/added`, `/webhook/updated`, `/webhook/deleted`

**Auth:** `X-Ghost-Signature: sha256=<hex>, t=<unix ms>`, HMAC-SHA256 with `WEBHOOK_SECRET`; `t` within ±5 minutes.

The body is Ghost's standard member payload ([conventions](data-model.md#ghost-webhook-payload)); the email comes from `member.current` (`added`, `updated`) or `member.previous` (`deleted`).

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "ok": true }` | Processed (including no-op transitions and failed Discord calls) |
| 200 | `{ "ok": true, "skipped": true, "reason": "no_mapping" }` | Email not linked |
| 400 | `{ "error": "Invalid JSON" }` | Body is not JSON |
| 400 | `{ "error": "Invalid payload: missing member email" }` | No email where expected |
| 401 | `{ "error": "Unauthorized" }` | Missing, invalid or stale signature |

## `POST /link` (admin)

**Auth:** `Authorization: Bearer <ADMIN_SECRET>`.

```json
{ "email": "user@example.com", "discord_user_id": "987654321098765432" }
```

| Status | Body |
|---|---|
| 200 | `{ "ok": true, "email": "<lowercased>", "discord_user_id": "..." }` |
| 400 | `{ "error": "Invalid JSON" }` |
| 400 | `{ "error": "Missing email or discord_user_id" }` |
| 400 | `{ "error": "Invalid email format" }` |
| 400 | `{ "error": "Invalid discord_user_id format" }` (must match `^\d{17,20}$`) |
| 401 | `{ "error": "Unauthorized" }` |

## `GET /link/:email` (admin)

**Auth:** Bearer, as above. The email is percent-encoded in the path, e.g. `GET /link/user%40example.com`.

| Status | Body |
|---|---|
| 200 | `{ "email": "<lowercased>", "discord_user_id": "..." }` |
| 400 | `{ "error": "Invalid email format" }` (also for malformed percent-encoding) |
| 401 | `{ "error": "Unauthorized" }` |
| 404 | `{ "error": "Not found" }` |

## `DELETE /link` (admin)

**Auth:** Bearer, as above.

```json
{ "email": "user@example.com" }
```

| Status | Body |
|---|---|
| 200 | `{ "ok": true, "email": "<lowercased>" }` (also when nothing was linked) |
| 400 | `{ "error": "Invalid JSON" }` |
| 400 | `{ "error": "Missing email" }` |
| 400 | `{ "error": "Invalid email format" }` |
| 401 | `{ "error": "Unauthorized" }` |
| 502 | `{ "error": "Role removal failed; mapping kept", "details": ["DELETE role <id>: <status> <body>"] }` |

## Errors

Every error body has the same shape, with no code, stack trace or request ID:

```json
{ "error": "<short description>" }
```

The only exception is the admin `DELETE /link` `502`, which adds a `details` array with the failed Discord calls (admin-only, so exposing Discord's answer is acceptable). Slash commands never fail at HTTP level once the signature is valid: problems are reported in the ephemeral reply.

| Status | Used for |
|---|---|
| 200 | Success, including webhooks skipped for an unlinked email |
| 204 | `OPTIONS /code` |
| 400 | Malformed JSON, missing or invalid field, unknown interaction type |
| 401 | Failed authentication: entitlement token, Ghost signature, Discord signature, admin Bearer |
| 404 | Unknown route, or `GET /link/:email` with no mapping |
| 429 | `POST /code` over the optional rate limit |
| 502 | Admin `DELETE /link` could not remove the roles |

Any other `5xx` is an uncaught exception (for example a KV failure), which the runtime turns into a `500`. Discord and JWKS errors are logged with `console.error` (`wrangler tail`) and never returned to end users.
