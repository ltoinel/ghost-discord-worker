# 06 — Event Handling

This document defines the worker's behavior for each Ghost webhook event. The three webhook endpoints are dispatched directly by event type. The two roles managed are `DISCORD_ROLE_MEMBER` (M) and `DISCORD_ROLE_PREMIUM` (P).

## Endpoint-to-Event Mapping

| Endpoint | Ghost event | Email source |
|----------|-------------|--------------|
| `POST /webhook/added` | `member.added` | `member.current.email` |
| `POST /webhook/updated` | `member.updated` | `member.current.email` |
| `POST /webhook/deleted` | `member.deleted` | `member.previous.email` |

## Event-to-Action Matrix

| Endpoint | Status Transition | M role | P role |
|----------|-------------------|--------|--------|
| `/webhook/added` | n/a → `free` | **+M** | — |
| `/webhook/added` | n/a → `paid` or `comped` | **+M** | **+P** |
| `/webhook/updated` | `free` → `paid` or `comped` | — | **+P** |
| `/webhook/updated` | `paid`/`comped` → `free` | — | **−P** |
| `/webhook/updated` | `free` → `free`, `paid` → `paid`, etc. (no transition) | — | — |
| `/webhook/updated` | `paid` ↔ `comped` (both paid) | — | — |
| `/webhook/updated` | `previous.status` missing | — | — |
| `/webhook/deleted` | any → deleted | **−M** | **−P** |

Symbols: **+X** = role assigned, **−X** = role removed, **—** = no change.

## Handler: `handleMemberAdded` (POST `/webhook/added`)

```
addRole(DISCORD_ROLE_MEMBER)
if (isPaid(current.status)) addRole(DISCORD_ROLE_PREMIUM)
```

The `member.previous` block, if any, is ignored.

## Handler: `handleMemberUpdated` (POST `/webhook/updated`)

```
if (!previous?.status || previous.status === current.status) {
    return 200 { ok: true };  // no-op
}
if (!isPaid(previous.status) && isPaid(current.status)) {
    addRole(DISCORD_ROLE_PREMIUM)
} else if (isPaid(previous.status) && !isPaid(current.status)) {
    removeRole(DISCORD_ROLE_PREMIUM)
}
// paid ↔ comped falls through silently
```

### Why no `removeRole(M)` on updates?

The Member role is added on `member.added` and removed on `member.deleted`. It represents "is currently a Ghost member" — tier changes don't affect membership existence.

### `isPaid()` definition

```ts
isPaid("free")   === false
isPaid("paid")   === true
isPaid("comped") === true
```

Treating `paid` and `comped` identically means the Premium role transitions are driven only by paid-vs-free, not paid-vs-comped distinctions.

## Handler: `handleMemberDeleted` (POST `/webhook/deleted`)

Reads the email from `member.previous.email` (since `member.current` is empty for deletions) and removes both roles unconditionally:

```
removeRole(DISCORD_ROLE_MEMBER)
removeRole(DISCORD_ROLE_PREMIUM)
```

The KV mapping is **not** deleted. If the user re-subscribes in Ghost, their existing Discord link is reused.

## Common Pre-Processing (`parseWebhookRequest`)

Both webhook handlers share the same validation pipeline:

1. **Signature verification** (`verifyGhostSignature`). On failure → `401 Unauthorized`.
2. **JSON parse**. On failure → `400 Invalid JSON`.
3. **Email extraction** — `current.email` (added/updated) or `previous.email` (deleted). If missing → `400 Invalid payload: missing member email`.
4. **Email lowercasing** — emails are always normalized to lowercase before any KV operation.
5. **KV lookup** — `email → discord_user_id`. If no mapping exists → `200 { ok: true, skipped: true, reason: "no_mapping" }`.

The "skip when unlinked" behavior is deliberate: it prevents Ghost from retrying webhooks for members who never linked their Discord, while still returning `200` so Ghost considers delivery successful.

## Role API Calls (`addRole` / `removeRole`)

Implemented in `src/discord.ts`:

```ts
PUT    /api/v10/guilds/<GUILD_ID>/members/<USER_ID>/roles/<ROLE_ID>
DELETE /api/v10/guilds/<GUILD_ID>/members/<USER_ID>/roles/<ROLE_ID>
```

- Headers: `Authorization: Bot <DISCORD_BOT_TOKEN>`.
- Both calls are **idempotent**: assigning an already-assigned role or removing an already-removed role returns 204 from Discord.
- The handler does not check role state before mutating; it always issues the operation.
- On non-2xx response, an error description is logged and **returned** (not thrown). Webhook handlers don't currently bubble these errors to the response — they return `200 { ok: true }` regardless of Discord API success. Slash command handlers **do** surface role errors to the user.

## Ordering & Atomicity

- For `member.added` (paid), the M role is added before the P role. If the second call fails, the user ends up with M but not P. There is no retry or compensating action.
- For `member.deleted`, M is removed before P. Same caveat applies.
- The worker does **not** queue, retry, or buffer role operations.

## Logging

Each event logs a single console.log line for traceability:

```
member.added: <email> (<status>)
member.updated (free->paid): <email>
member.updated (paid->free): <email>
member.deleted: <email>
```

Skipped events log a warning:

```
No Discord mapping found for email: <email>
```
