# How it works

Each flow below is described once. Status codes, bodies and reply strings are in the [API reference](api.md); KV keys in the [data model](data-model.md).

## Linking

Linking binds a Ghost email to the Discord account that runs `/link`. The member never types their email: a code minted from a Ghost-signed token proves they own it.

### 1. Getting a code (browser → `POST /code`)

1. The member, logged in on the Ghost site, clicks the widget button.
2. The widget calls `GET /members/api/entitlements` on the Ghost site (same origin, session cookie). Ghost answers `200` with the entitlement JWT as plain text, or `204` when there is no session.
3. The widget sends `POST /code` with `{ "token": "<jwt>" }`, normally same-origin through the nginx proxy (otherwise cross-origin, with an `OPTIONS` preflight).
4. The Worker verifies the token ([Security → Entitlement token](security.md#entitlement-token-post-code)), then requires `scope === "members:entitlements:read"` and a boolean `paid` claim. The email is `sub`, lowercased.
5. **Rate limit.** If the `CODE_RATE_LIMITER` binding exists, it is called with the email as key; over the limit, the request ends with `429`.
6. **Reuse.** If `pending:<email>` names a code that still has at least 120 seconds to live, and `code:<CODE>` still holds this email with the same `paid` value, that code is returned with its remaining lifetime. Nothing is written.
7. **Mint.** Otherwise the Worker draws 8 random characters from the Crockford base32 alphabet (`0-9A-Z` without `I L O U`, ~40 bits), writes `code:<CODE>` → `{ email, paid }` and `pending:<email>` → `<CODE>` (both with a 600 s TTL), and returns `{ code, expires_in: 600 }`.
8. The widget shows the code with a copy button and a countdown.

So each member has at most one live code, a code is never reused once redeemed, near expiry or minted under another `paid` value, and repeated clicks cost KV reads, not writes.

### 2. Redeeming it (`/link <code>`)

1. Discord sends the signed interaction to `POST /discord`; the user ID is `member.user.id` (guild) or `user.id` (DM / user app).
2. The code option is trimmed and uppercased, then `code:<CODE>` is read. Missing, expired, already used or not a valid `{ email: string, paid: boolean }` value: *invalid or expired code*.
3. **Email side.** If `<email>` is already mapped to another Discord user: rejected.
4. **Discord side.** If `discord:<userId>` already maps to another email: rejected, the user must `/unlink` first.
5. These checks do not consume the code: a rejected attempt leaves it usable until its TTL.
6. The code is deleted **before** the mapping is written, so a concurrent redemption of the same code fails its lookup.
7. The Worker writes `<email>` → `userId` and `discord:<userId>` → `email`.
8. It adds the Member role, plus Premium if the code's `paid` is `true`. No Ghost API call is made: `paid` is the snapshot taken at mint time ([Security → Tier status freshness](security.md#tier-status-freshness)).
9. If a role call failed, the mapping is kept (the code is already gone) and the reply says so; the user can mint a new code and run `/link` again.

Re-linking the same email to the same Discord account passes both checks and simply rewrites the mapping and re-applies the roles.

## Role sync (Ghost webhooks)

Ghost calls one endpoint per event. Every request goes through the same pipeline:

1. Verify `X-Ghost-Signature` ([Security](security.md#authentication-schemes)); failure → `401`.
2. Parse the JSON body; failure → `400`.
3. Read the email from `member.current.email` (`added`, `updated`) or `member.previous.email` (`deleted`); missing → `400`. Lowercase it.
4. **Invalidate the pending code** on `member.deleted`, or on `member.updated` when `previous.status` is present and differs from `current.status`: delete the `code:<CODE>` named by `pending:<email>`, then `pending:<email>`. This runs whether or not the member is linked, and also on a `paid` ↔ `comped` change.
5. Look up `<email>`. No mapping → `200 { ok: true, skipped: true, reason: "no_mapping" }` (a `2xx` stops Ghost from retrying for members who never linked).
6. Apply the matrix below and return `200 { ok: true }`.

| Event | Transition | Member | Premium |
|---|---|---|---|
| `member.added` | → `free` | add | — |
| `member.added` | → `paid` / `comped` | add | add |
| `member.updated` | `free` → `paid` / `comped` | — | add |
| `member.updated` | `paid` / `comped` → `free` | — | remove |
| `member.updated` | `paid` ↔ `comped`, same status, or no `previous.status` | — | — |
| `member.deleted` | any | remove | remove |

- The Member role is never touched by `member.updated`: it tracks membership, not tier.
- `member.deleted` keeps the KV mapping, so a member who signs up again with the same email gets their roles back from the next `member.added`.
- Role call failures are logged but do not change the response (`200`): Ghost is not asked to retry, and the drift is fixed by the next event or by hand.

## Unlinking (`/unlink`)

1. Read `discord:<userId>`. No email → *no email is linked*.
2. Remove the Member role, then the Premium role. A Discord `404` (member already left the server) counts as success.
3. If any removal failed: the mapping is **kept** and the user is asked to retry. Webhooks keep governing the roles meanwhile.
4. Otherwise delete `<email>`, then `discord:<userId>`.

Roles go first because, once the mapping is gone, no webhook can find the account to revoke them: keeping them would let one membership grant roles to any number of Discord accounts (link, unlink, link again). `/unlink` does not call Ghost; the member stays a Ghost member and can link again with a new code.

## Admin operations

All three endpoints require the admin Bearer token and never call Ghost.

- **`POST /link`** validates the email and the `discord_user_id` (snowflake, 17–20 digits), lowercases the email, then keeps the mapping 1:1: if the email was mapped to another user, that user's `discord:<old>` key is deleted; if the user was mapped to another email, that `<old email>` key is deleted. It writes both directions and assigns **no** roles: they follow at the member's next Ghost event. The previous Discord user's roles are not removed.
- **`GET /link/:email`** percent-decodes and lowercases the email, validates it and returns the mapped user ID, or `404`.
- **`DELETE /link`** looks up the email. If it is linked, it removes both roles first (same rule and same `404` tolerance as `/unlink`); on failure it returns `502` and deletes nothing. Then it deletes `discord:<id>` and `<email>`. An unlinked email returns `200` without any Discord call. Pending codes are left alone.

## Ordering and idempotency

- Discord role `PUT` and `DELETE` are idempotent, and the Worker never checks current roles before calling them. Duplicate or replayed webhooks only re-apply the announced state.
- Calls are sequential with no rollback: Member is handled before Premium, the forward key before the reverse key. A failure in between leaves a partial state that the next event or an admin call repairs.
- KV is eventually consistent across Cloudflare locations, so "delete before write" and "reuse before mint" are best-effort, not transactions ([residual risks](security.md#residual-risks)).
- `/link` does at most three KV reads, one delete, two writes and two Discord calls; `/unlink` one read, two Discord calls, two deletes. Both stay well inside Discord's 3-second interaction deadline.
