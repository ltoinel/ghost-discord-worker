# Data model

## KV keys

All state lives in the `GHOST_DISCORD_MAPPING` KV namespace. Emails are always lowercased before they are used as a key or value.

| Key | Value | TTL | Written by | Deleted by |
|---|---|---|---|---|
| `<email>` | Discord user ID | none | `/link`, `POST /link` | `/unlink`, `DELETE /link`, `POST /link` (stale entry) |
| `discord:<userId>` | email | none | `/link`, `POST /link` | `/unlink`, `DELETE /link`, `POST /link` (stale entry) |
| `code:<CODE>` | `PendingLink` JSON: `{"email":"…","paid":true}` | 600 s | `POST /code` | `/link` (on redemption), status-change and delete webhooks |
| `pending:<email>` | `<CODE>`, with metadata `{"expiresAt": <unix ms>}` | 600 s | `POST /code` | Status-change and delete webhooks |

```
"user@example.com"            → "987654321098765432"
"discord:987654321098765432"  → "user@example.com"
"code:G7K9MN2X"               → '{"email":"user@example.com","paid":true}'
"pending:user@example.com"    → "G7K9MN2X"   metadata {"expiresAt": 1767225600000}
```

### Invariants

- **1:1 mapping.** An email maps to at most one Discord user and a Discord user to at most one email. `/link` enforces it with its two conflict checks; `POST /link` by deleting stale reverse entries.
- **Both directions together.** The forward and reverse keys are written and deleted together, but as two separate operations (KV has no transactions). The forward key is what webhooks read (Ghost knows the email); the reverse key is what slash commands read (Discord knows the user).
- **Disjoint key spaces.** Every non-email key has a `prefix:`, and `isValidEmail` rejects `:`. Webhook emails are not regex-validated (Ghost is trusted), only lowercased.
- **Codes are single-use.** `/link` deletes `code:<CODE>` before writing the mapping. A value that is not a valid `{ email: string, paid: boolean }` object (e.g. a legacy bare-email value) is treated as an invalid code.
- **One live code per member.** `pending:<email>` names the member's last code; its `expiresAt` metadata lets `POST /code` compute the remaining lifetime without a write. It is not deleted on redemption: a pointer to a consumed code is ignored because `code:<CODE>` is gone.
- **Webhook deletes keep the mapping.** `member.deleted` removes roles and the pending code, not the mapping.

## Types (`src/types.ts`)

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
  email: string;
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

`Env` is the authoritative list of what the Worker reads; see [Configuration](configuration.md) for how each entry is set.

## Ghost webhook payload

Ghost sends the member before and after the change. The Worker reads only `email` and `status`; other fields are ignored.

```json
{
  "member": {
    "current":  { "email": "user@example.com", "status": "paid" },
    "previous": { "status": "free" }
  }
}
```

| Event | `current` | `previous` | Email read from |
|---|---|---|---|
| `member.added` | The new member | Absent or `{}` | `current.email` |
| `member.updated` | After the change | Only the changed fields | `current.email` |
| `member.deleted` | Empty | Last known member | `previous.email` |

The Worker treats a missing `previous.status` as "status unchanged": no role change and no pending-code invalidation.

| `status` | `isPaid()` | Premium |
|---|---|---|
| `free` | `false` | no |
| `paid` | `true` | yes |
| `comped` | `true` | yes |

At link time the entitlement token's `paid` claim is used instead; Ghost computes it as `status !== "free"`, which gives the same result.
