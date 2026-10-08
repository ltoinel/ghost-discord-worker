# 04 — API Reference

All endpoints return JSON. All responses have `Content-Type: application/json`. Any unmatched path returns `404 { "error": "Not found" }`.

---

## `POST /code`

Exchanges a Ghost-signed member entitlement JWT (proof of email ownership + `paid` flag) for a short-lived, single-use redemption code. Called from the Ghost site's browser JS — recommended via an nginx reverse-proxy on the Ghost domain (see [08 — Configuration](./08-configuration.md#nginx-reverse-proxy-recommended)) so the Worker URL stays hidden and the call is same-origin (no CORS preflight).

### Authentication

The request body must contain a Ghost-issued member **entitlement** JWT, as returned by `GET /members/api/entitlements` (RS256/RS384/RS512 — Ghost uses RS512 by default; 5-minute expiry). The Worker verifies the signature against Ghost's published JWKS at `<GHOST_URL>/members/.well-known/jwks.json`, then requires `scope === "members:entitlements:read"` and a boolean `paid` claim. Identity tokens from `/members/api/session` are rejected. Requires a recent Ghost 6.x that exposes `/members/api/entitlements`. See [05 — Authentication](./05-authentication.md).

### CORS

This is the only endpoint reachable from a browser. CORS is locked to `GHOST_URL`:

```
Access-Control-Allow-Origin: <GHOST_URL>
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

Preflight is handled by `OPTIONS /code` returning `204` with the same headers.

### Request

```json
{ "token": "<ghost_entitlement_jwt>" }
```

### Responses

| Status | Body |
|--------|------|
| 200 | `{ "code": "G7K9MN2X", "expires_in": 600 }` (`expires_in` < 600 when an existing code is returned) |
| 400 | `{ "error": "Invalid JSON" }` |
| 400 | `{ "error": "Missing token" }` |
| 400 | `{ "error": "Token missing email claim" }` |
| 401 | `{ "error": "Invalid token" }` |
| 401 | `{ "error": "Expected an entitlement token from /members/api/entitlements" }` |
| 429 | `{ "error": "Too many requests, please wait a minute" }` with `Retry-After: 60` — only when the optional `CODE_RATE_LIMITER` binding is configured |

The returned `code` is 8 Crockford-base32 characters (~40 bits of entropy), single-use, with a 10-minute TTL enforced by KV `expirationTtl`. It is stored as `code:<CODE>` → `{ "email", "paid" }`, and the member's live code is tracked under `pending:<email>` (see [03 — Data Model](./03-data-model.md)).

### Code reuse and rate limiting

Each member has at most one live code. If `pending:<email>` points to a code that still has **at least 120 seconds** left, was minted with the same `paid` value, and whose `code:<CODE>` entry still holds this email, that same code is returned with its remaining `expires_in` and **nothing is written to KV**. Otherwise a new code is minted (two KV writes: `code:<CODE>` and `pending:<email>`). A code is therefore not reused once it has been redeemed, is about to expire, or the member's paid status changed.

If the `CODE_RATE_LIMITER` [rate-limit binding](./08-configuration.md#rate-limiting-optional) is configured, it is called with the member email as key after the JWT is verified, before any KV access. A rejection returns `429`. Without the binding, no rate limiting is applied (code reuse still bounds KV writes to one pair per member per ~8 minutes).

---

## `POST /webhook/added`

Receives Ghost `member.added` events.

### Authentication

`X-Ghost-Signature: sha256=<hex>, t=<unix_ms>` header (HMAC-SHA256 over `body + timestamp`). See [05 — Authentication](./05-authentication.md).

### Request

```json
{
  "member": {
    "current": { "email": "user@example.com", "status": "free|paid|comped", ... }
  }
}
```

### Responses

| Status | Body | When |
|--------|------|------|
| 200 | `{ "ok": true }` | Roles assigned |
| 200 | `{ "ok": true, "skipped": true, "reason": "no_mapping" }` | No Discord mapping found for this email |
| 400 | `{ "error": "Invalid JSON" }` | Body is not valid JSON |
| 400 | `{ "error": "Invalid payload: missing member email" }` | `member.current.email` is missing |
| 401 | `{ "error": "Unauthorized" }` | Missing/invalid/expired signature |

### Behavior

Always adds `DISCORD_ROLE_MEMBER`. Also adds `DISCORD_ROLE_PREMIUM` if the member's `status` is `paid` or `comped`.

---

## `POST /webhook/updated`

Receives Ghost `member.updated` events.

### Authentication

Same as `/webhook/added` — `X-Ghost-Signature` header.

### Request

```json
{
  "member": {
    "current":  { "email": "user@example.com", "status": "paid", ... },
    "previous": { "status": "free", ... }
  }
}
```

### Responses

| Status | Body | When |
|--------|------|------|
| 200 | `{ "ok": true }` | Transition applied, or no-op (paid↔comped, same-status, missing `previous.status`) |
| 200 | `{ "ok": true, "skipped": true, "reason": "no_mapping" }` | No Discord mapping found |
| 400 | `{ "error": "Invalid JSON" }` | Body is not valid JSON |
| 400 | `{ "error": "Invalid payload: missing member email" }` | `member.current.email` is missing |
| 401 | `{ "error": "Unauthorized" }` | Missing/invalid/expired signature |

### Behavior

- `free → paid|comped` → adds `DISCORD_ROLE_PREMIUM`.
- `paid|comped → free` → removes `DISCORD_ROLE_PREMIUM`.
- Any other transition (paid↔comped, same status, missing `previous.status`) is a no-op.
- `DISCORD_ROLE_MEMBER` is never touched here.

---

## `POST /webhook/deleted`

Receives Ghost `member.deleted` events.

### Authentication

Same as `/webhook/added` — `X-Ghost-Signature` header.

### Request

```json
{
  "member": {
    "previous": { "email": "user@example.com", "status": "paid", ... }
  }
}
```

Note: email is read from `member.previous` for delete events.

### Responses

| Status | Body | When |
|--------|------|------|
| 200 | `{ "ok": true }` | Roles removed from linked Discord user |
| 200 | `{ "ok": true, "skipped": true, "reason": "no_mapping" }` | No Discord mapping found |
| 400 | `{ "error": "Invalid JSON" }` | Body is not valid JSON |
| 400 | `{ "error": "Invalid payload: missing member email" }` | `member.previous.email` is missing |
| 401 | `{ "error": "Unauthorized" }` | Missing/invalid/expired signature |

### Behavior

Removes both `DISCORD_ROLE_MEMBER` and `DISCORD_ROLE_PREMIUM` from the Discord user. The KV mapping itself is **not** deleted.

---

## `POST /discord`

Handles Discord slash command interactions and Discord PING health checks.

### Authentication

Ed25519 signature over `timestamp + body`, with headers:
- `X-Signature-Ed25519: <hex>`
- `X-Signature-Timestamp: <unix_seconds>`

Verified against `DISCORD_PUBLIC_KEY`. `X-Signature-Timestamp` must be within ±5 minutes of the Worker's clock, otherwise the request is rejected (replay protection).

### Request

A standard Discord interaction object. Supported types:
- `1` (PING) — Discord's endpoint health probe
- `2` (APPLICATION_COMMAND) — Slash command invocation

Supported commands: `link <code>`, `unlink` (see [07 — Slash Commands](./07-slash-commands.md)).

### Responses

PING response:
```json
{ "type": 1 }
```

Command response (ephemeral, type 4 + flags 64):
```json
{ "type": 4, "data": { "content": "<message>", "flags": 64 } }
```

Other:

| Status | Body | When |
|--------|------|------|
| 400 | `{ "error": "Unknown interaction type" }` | `interaction.type` not 1 or 2 |
| 401 | `{ "error": "Invalid signature" }` | Ed25519 verification failed, or timestamp outside the ±5-minute window |

---

## `POST /link` (admin)

Creates a bidirectional email ↔ Discord user mapping. **Does not** assign Discord roles or verify the email against Ghost. Operator escape hatch — bypasses the code redemption flow.

### Authentication

`Authorization: Bearer <ADMIN_SECRET>`. Compared via `timingSafeEqual`.

### Request

```json
{
  "email": "user@example.com",
  "discord_user_id": "987654321098765432"
}
```

### Responses

| Status | Body |
|--------|------|
| 200 | `{ "ok": true, "email": "user@example.com", "discord_user_id": "..." }` |
| 400 | `{ "error": "Invalid JSON" }` |
| 400 | `{ "error": "Missing email or discord_user_id" }` |
| 400 | `{ "error": "Invalid email format" }` |
| 400 | `{ "error": "Invalid discord_user_id format" }` |
| 401 | `{ "error": "Unauthorized" }` |

Email is lowercased before storage. `discord_user_id` must be a Discord snowflake: 17 to 20 decimal digits (`/^\d{17,20}$/`).

If the email was already linked to a different Discord user, the stale `discord:<previous_user_id>` key is deleted; if the Discord user was already linked to a different email, the stale `<previous_email>` key is deleted. The mapping therefore stays 1:1. Roles held by the previous Discord user are **not** removed.

---

## `DELETE /link` (admin)

Removes the Member and Premium roles from the linked Discord user, then the bidirectional mapping — same reasoning as [`/unlink`](./07-slash-commands.md#why-unlink-removes-roles): once unlinked, webhooks can no longer revoke the roles. A `404` from Discord (member left the guild) counts as success.

### Authentication

Same as `POST /link`.

### Request

```json
{ "email": "user@example.com" }
```

### Responses

| Status | Body |
|--------|------|
| 200 | `{ "ok": true, "email": "user@example.com" }` |
| 400 | `{ "error": "Invalid JSON" }` |
| 400 | `{ "error": "Missing email" }` |
| 400 | `{ "error": "Invalid email format" }` |
| 401 | `{ "error": "Unauthorized" }` |
| 502 | `{ "error": "Role removal failed; mapping kept", "details": ["DELETE role <id>: <status> <body>", ...] }` |

A 200 is returned even if no mapping exists (idempotent delete; no Discord call is made). On `502` nothing is deleted from KV; fix the cause (usually the bot's role hierarchy) and retry.

---

## `GET /link/:email` (admin)

Looks up the Discord user ID mapped to a given email.

### Authentication

Same as `POST /link`.

### Request

URL-encoded email in path. Example:

```
GET /link/user%40example.com
Authorization: Bearer <ADMIN_SECRET>
```

### Responses

| Status | Body |
|--------|------|
| 200 | `{ "email": "user@example.com", "discord_user_id": "987654321098765432" }` |
| 400 | `{ "error": "Invalid email format" }` (also for malformed percent-encoding in the path, e.g. `%E0%A4%A`) |
| 401 | `{ "error": "Unauthorized" }` |
| 404 | `{ "error": "Not found" }` |

---

## Method/Path Matrix

| Path | GET | POST | DELETE | OPTIONS | Other |
|------|-----|------|--------|---------|-------|
| `/discord` | 404 | ✅ | 404 | 404 | 404 |
| `/code` | 404 | ✅ | 404 | ✅ | 404 |
| `/webhook/added` | 404 | ✅ | 404 | 404 | 404 |
| `/webhook/updated` | 404 | ✅ | 404 | 404 | 404 |
| `/webhook/deleted` | 404 | ✅ | 404 | 404 | 404 |
| `/link` | 404 | ✅ | ✅ | 404 | 404 |
| `/link/<email>` | ✅ | 404 | 404 | 404 | 404 |
| any other | 404 | 404 | 404 | 404 | 404 |
