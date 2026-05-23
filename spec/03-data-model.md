# 03 — Data Model

## KV Schema

A single KV namespace, `GHOST_DISCORD_MAPPING`, stores all worker state. Keys are flat strings; values are flat strings. There are three key shapes: a bidirectional mapping (two keys) and ephemeral redemption codes (one key).

| Key | Value | TTL | Meaning |
|-----|-------|-----|---------|
| `<email-lowercased>` | `<discord_user_id>` | none | Forward: Ghost email → Discord user ID |
| `discord:<discord_user_id>` | `<email-lowercased>` | none | Reverse: Discord user ID → Ghost email |
| `code:<CODE>` | `<email-lowercased>` | 600s | Single-use redemption code minted by `POST /code` |

### Invariants

- Emails are **always lowercased** before being used as a key or value.
- The forward and reverse keys are written together by `/link` (admin and slash command) and deleted together by `/unlink` and `DELETE /link`.
- Reverse keys are namespaced with the literal prefix `discord:`; code keys with `code:`. Email keys always contain `@`, so all three spaces are disjoint.
- Code keys have `expirationTtl: 600` (10 minutes) at write time. They are also explicitly deleted on successful `/link` redemption (single-use).

### Examples

```
"user@example.com"            → "987654321098765432"
"discord:987654321098765432"  → "user@example.com"
"code:G7K9MN2X"               → "user@example.com"   (expires in ≤ 10 min)
```

### Consistency Notes

- The two-key write is **not atomic**. If the second `put` or `delete` fails, the store is briefly inconsistent. Cloudflare KV write failures are rare but possible; the worker does not implement rollback.
- The forward direction is the source of truth for **webhook** lookups (Ghost knows email).
- The reverse direction is the source of truth for **slash command** lookups (Discord knows user ID).

## TypeScript Types (`src/types.ts`)

```ts
export interface Env {
  GHOST_DISCORD_MAPPING: KVNamespace;
  WEBHOOK_SECRET: string;
  ADMIN_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  DISCORD_ROLE_MEMBER: string;
  DISCORD_ROLE_PREMIUM: string;
  DISCORD_PUBLIC_KEY: string;
  GHOST_URL: string;
  GHOST_ADMIN_API_KEY: string;
}

export type MemberStatus = "free" | "paid" | "comped";

export interface GhostMemberData {
  id?: string;
  email: string;
  name?: string;
  status: MemberStatus;
}

export interface GhostWebhookPayload {
  member: {
    current: GhostMemberData;
    previous?: Partial<GhostMemberData>;
  };
}

export type GhostLookupResult =
  | { status: "found"; member: GhostMemberData }
  | { status: "not_found" }
  | { status: "error"; message: string };
```

## Ghost Webhook Payload Conventions

The Ghost CMS sends webhook payloads with the following shape:

```json
{
  "member": {
    "current":  { "id": "...", "email": "...", "name": "...", "status": "free|paid|comped" },
    "previous": { "status": "free|paid|comped", ... }  // optional
  }
}
```

| Event | `current` populated? | `previous` populated? |
|-------|----------------------|------------------------|
| `member.added` | Yes (new member) | No (or empty `{}`) |
| `member.updated` | Yes (post-change) | Yes (pre-change subset) |
| `member.deleted` | Empty/minimal | Yes (last-known member state) |

The three endpoints `/webhook/added`, `/webhook/updated`, `/webhook/deleted` are dispatched directly — the worker no longer infers the event type from the payload shape.

For `member.deleted`, the worker reads the email from `member.previous` because `member.current` is no longer meaningful.

## Status Semantics

| `MemberStatus` | Premium? (via `isPaid()`) | Source |
|----------------|---------------------------|--------|
| `"free"`       | ❌ | Default signup |
| `"paid"`       | ✅ | Active paying subscriber |
| `"comped"`     | ✅ | Gifted/complimentary paid access |

`isPaid()` is the single source of truth for premium eligibility:

```ts
export function isPaid(status: MemberStatus): boolean {
  return status === "paid" || status === "comped";
}
```

## Discord Interaction Payload (subset used)

The worker only inspects a narrow subset of the Discord interaction object:

```ts
{
  type: 1 | 2,                          // PING or APPLICATION_COMMAND
  data?: {
    name: "link" | "unlink",
    options?: [{ value: string }]       // /link's email argument
  },
  member?: {
    user?: { id: string }               // Invoking Discord user
  }
}
```

The worker does not parse, store, or rely on any other fields.
