# 07 — Slash Commands

Two Discord slash commands are supported, both invoked via `POST /discord` after Ed25519 verification. All responses are **ephemeral** (Discord flag `64`), visible only to the invoking user.

## Command Registration (out of scope of worker)

Slash commands must be registered with the Discord API for the application (not done by this worker). The expected command definitions:

```json
[
  {
    "name": "link",
    "description": "Redeem your Ghost-issued linking code",
    "options": [
      {
        "name": "code",
        "description": "The code displayed on your Ghost site",
        "type": 3,
        "required": true
      }
    ]
  },
  {
    "name": "unlink",
    "description": "Unlink your Ghost email from your Discord account"
  }
]
```

## `/link <code>`

The Discord user does **not** type their email here. They first visit the Ghost site (logged in), click "Get my Discord code", and the page fetches their entitlement JWT from `/members/api/entitlements` and calls `POST /code` with it. The Worker mints an 8-character code (stored with the member's email and `paid` flag) which the user then pastes into Discord. See [05 — Authentication](./05-authentication.md) for the JWT proof-of-ownership flow.

### Flow

```
1. Read code from interaction.data.options[0].value, trim + uppercase.
2. KV lookup: { email, paid } = JSON.parse(KV.get("code:" + code)).
   If missing/expired, or not a valid { email: string, paid: boolean } value (e.g. a legacy bare-email value)
   → "Invalid or expired code. Visit your Ghost site to generate a new one."

3. Conflict check — email side:
   existingUserId = KV.get(email)
   If existingUserId && existingUserId !== invokingUserId:
       → "This email is already linked to another Discord account."

4. Conflict check — Discord side:
   existingEmail = KV.get("discord:" + invokingUserId)
   If existingEmail && existingEmail !== email:
       → "Your Discord account is already linked to **<existingEmail>**.
          Use `/unlink` first."

5. Write the bidirectional mapping + invalidate the code:
       KV.put(email, invokingUserId)
       KV.put("discord:" + invokingUserId, email)
       KV.delete("code:" + code)         // one-time use

6. Assign Discord roles (no Ghost API call — `paid` was captured from the entitlement JWT at mint time):
       addRole(DISCORD_ROLE_MEMBER)
       if (paid) addRole(DISCORD_ROLE_PREMIUM)

7. If any role call failed → log errors server-side and reply:
       "Your email **<email>** has been linked, but roles could not be
        assigned. Please contact an administrator."

8. Otherwise reply: "Your email **<email>** has been linked to your Discord account."
```

### Conflict Semantics

The two conflict checks enforce a strict **1:1 mapping**:

- Each email maps to at most one Discord user.
- Each Discord user maps to at most one email.

Re-linking the same `(email, userId)` pair is **idempotent** — both conflict checks short-circuit on equality and the operation proceeds (overwriting the same values and re-applying roles).

### Why a code, not the email?

The previous design (`/link <email>`) let any Discord user claim any Ghost email they could guess, provided the legitimate owner hadn't linked yet. The code redemption flow closes that gap: only someone who can obtain a Ghost member entitlement JWT (i.e., who controls the Ghost session for that email) can produce a valid code. See [09 — Security](./09-security.md) for the full threat analysis.

### Replies — all messages

| Condition | Reply text |
|-----------|------------|
| Missing code | `"Please provide your linking code. Visit your Ghost site to generate one."` |
| Code not in KV (invalid, expired, or already used) or malformed code value | `"Invalid or expired code. Visit your Ghost site to generate a new one."` |
| Email taken by another Discord user | `"This email is already linked to another Discord account."` |
| Discord user already linked elsewhere | ``"Your Discord account is already linked to **<email>**. Use `/unlink` first."`` |
| Linked but role assignment failed | `"Your email **<email>** has been linked, but roles could not be assigned. Please contact an administrator."` |
| Success | `"Your email **<email>** has been linked to your Discord account."` |

## `/unlink`

### Flow

```
1. Look up the linked email for the invoking Discord user:
       email = KV.get("discord:" + invokingUserId)

2. If no email is linked → "No email is linked to your Discord account."

3. Delete both KV keys:
       KV.delete(email)
       KV.delete("discord:" + invokingUserId)

4. Reply: "Your email **<email>** has been unlinked from your Discord account."
```

### What `/unlink` does NOT do

- It does **not** remove Discord roles. The roles persist until either:
  - Ghost emits `member.deleted` for the email, **and** the mapping is restored (it isn't), or
  - A server admin removes the roles manually via Discord.
- It does **not** call Ghost (Ghost has no awareness of Discord linkage).

This behavior is intentional: a user "unlinking" only severs the Ghost→Discord webhook bridge; they remain a Ghost member.

## Unknown Commands

If `interaction.data.name` is neither `"link"` nor `"unlink"`, the worker replies:

```
"Unknown command."
```

## Reply Encoding

All slash command replies use the Discord Interaction Response shape:

```json
{
  "type": 4,
  "data": {
    "content": "<message>",
    "flags": 64
  }
}
```

- `type: 4` = `CHANNEL_MESSAGE_WITH_SOURCE`
- `flags: 64` = `EPHEMERAL` (visible only to invoking user, suppresses notifications)

Discord's 3-second deadline for an initial interaction response is the operative SLO. The `/link` command performs three KV reads, two KV writes, one KV delete, and up to two Discord API calls (no Ghost API call) — all serial. Under healthy conditions this stays well within the deadline.
