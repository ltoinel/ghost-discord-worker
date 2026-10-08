# 03 — Data Model

## KV Schema

A single KV namespace, `GHOST_DISCORD_MAPPING`, stores all worker state. Keys are flat strings; values are flat strings (code values are a small JSON string). There are four key shapes: a bidirectional mapping (two keys), ephemeral redemption codes, and a per-member pointer to the member's live code.

| Key | Value | TTL | Meaning |
|-----|-------|-----|---------|
| `<email-lowercased>` | `<discord_user_id>` | none | Forward: Ghost email → Discord user ID |
| `discord:<discord_user_id>` | `<email-lowercased>` | none | Reverse: Discord user ID → Ghost email |
| `code:<CODE>` | `{"email":"<email-lowercased>","paid":true\|false}` (JSON `PendingLink`) | 600s | Single-use redemption code minted by `POST /code`; `paid` is captured from the entitlement JWT at mint time |
| `pending:<email-lowercased>` | `<CODE>` (KV metadata `{"expiresAt": <unix_ms>}`) | 600s | The member's current live code, so repeated `POST /code` calls return it instead of minting (and writing) a new one |

### Invariants

- Emails are **always lowercased** before being used as a key or value.
- The forward and reverse keys are written together by `/link` (admin and slash command) and deleted together by `/unlink` and `DELETE /link` (after the Discord roles were removed successfully).
- Admin `POST /link` also deletes stale reverse entries: the old `discord:<previous_user_id>` key if the email was linked to another Discord user, and the old `<previous_email>` key if the Discord user was linked to another email.
- Reverse keys are namespaced with the literal prefix `discord:`; code keys with `code:`; code pointers with `pending:`. Validated emails never contain `:` (`isValidEmail` does not allow it), while every other key carries a `prefix:`, so the spaces are disjoint.
- Code keys have `expirationTtl: 600` (10 minutes) at write time. They are also explicitly deleted on successful `/link` redemption (single-use) — **before** the mapping is written.
- `pending:<email>` keys are written alongside the code with the same 600 s TTL; their `expiresAt` metadata lets `POST /code` compute the code's remaining lifetime without another write. They are not deleted on redemption: a pointer to an already-redeemed code is ignored because `code:<CODE>` no longer exists. They are deleted, together with their `code:<CODE>`, when a `member.updated` webhook changes the member's status or a `member.deleted` webhook arrives (see [09 — Security](./09-security.md#tier-status-freshness-entitlement-snapshot)).
- A code value that is not valid `PendingLink` JSON (e.g. a legacy bare-email value) is treated as "Invalid or expired code".

### Examples

```
"user@example.com"            → "987654321098765432"
"discord:987654321098765432"  → "user@example.com"
"code:G7K9MN2X"               → '{"email":"user@example.com","paid":true}'   (expires in ≤ 10 min)
"pending:user@example.com"    → "G7K9MN2X"   metadata {"expiresAt": 1767225600000}   (expires in ≤ 10 min)
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
  /** Optional Workers rate-limit binding applied per member email on POST /code. */
  CODE_RATE_LIMITER?: RateLimit;
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

/** Value stored under `code:<CODE>` in KV, captured from the entitlement JWT at mint time. */
export interface PendingLink {
  email: string;
  paid: boolean;
}
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

`isPaid()` is the single source of truth for premium eligibility in webhook handling. At link time, the entitlement JWT's `paid` claim is used instead; Ghost computes it as `status !== "free"`, which matches `isPaid()` (comped counts as paid):

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
    options?: [{ value: string }]       // /link's code argument
  },
  member?: {
    user?: { id: string }               // Invoking Discord user
  }
}
```

The worker does not parse, store, or rely on any other fields.
