# Ghost → Discord Role Sync

A Cloudflare Worker that syncs Ghost CMS member events to Discord roles. When members are added, upgraded, downgraded, or deleted in Ghost, their Discord roles are automatically updated.

## Architecture

```
Ghost CMS ──webhook──▶ Cloudflare Worker ──Discord API──▶ Discord Server
                              │
                        Cloudflare KV
                     (email ↔ discord_user_id)
```

The worker uses a Cloudflare KV store to maintain a bidirectional mapping between Ghost member emails and Discord user IDs. When a Ghost webhook fires, the worker looks up the corresponding Discord user and updates their roles accordingly.

## Event Mapping

| Ghost Event | Discord Action |
|---|---|
| Member added (free) | Add **Member** role |
| Member added (paid/comped) | Add **Member** + **Premium Member** roles |
| Member deleted | Remove all roles (Member, Premium Member) |
| Member updated (free → paid) | Add **Premium Member** role |
| Member updated (paid → free) | Remove **Premium Member** role |

## Discord Slash Commands

| Command | Description |
|---|---|
| `/link <email>` | Link your Discord account to your Ghost email. The email must belong to an existing Ghost member. Roles are assigned automatically based on membership level. |
| `/unlink` | Unlink your Discord account from your Ghost email. |

Each email can only be linked to one Discord account, and each Discord account can only be linked to one email.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A [Cloudflare](https://cloudflare.com/) account
- A [Discord bot](https://discord.com/developers/applications) with the **Manage Roles** permission
- A [Ghost CMS](https://ghost.org/) instance with an Admin API key

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create GHOST_DISCORD_MAPPING
```

Copy the output `id` and replace `REPLACE_WITH_KV_NAMESPACE_ID` in `wrangler.toml`.

### 3. Configure secrets

```sh
npx wrangler secret put WEBHOOK_SECRET       # Shared secret for Ghost webhook URLs
npx wrangler secret put ADMIN_SECRET         # Bearer token for /link admin endpoints
npx wrangler secret put DISCORD_BOT_TOKEN    # Discord bot token
npx wrangler secret put DISCORD_GUILD_ID     # Discord server ID
npx wrangler secret put DISCORD_PUBLIC_KEY   # Discord app public key (for interaction verification)
npx wrangler secret put DISCORD_ROLE_MEMBER  # Role ID for "Member"
npx wrangler secret put DISCORD_ROLE_PREMIUM # Role ID for "Premium Member"
npx wrangler secret put GHOST_URL            # Ghost site URL (e.g. https://mysite.com)
npx wrangler secret put GHOST_ADMIN_API_KEY  # Ghost Admin API key (format: {id}:{secret})
```

### 4. Deploy

```sh
npm run deploy
```

### 5. Configure Ghost webhooks

In **Ghost Admin → Settings → Integrations → Custom Integration**, create three webhooks:

| Event | URL |
|---|---|
| Member added | `https://<worker>.workers.dev/webhook?secret=<WEBHOOK_SECRET>` |
| Member updated | `https://<worker>.workers.dev/webhook?secret=<WEBHOOK_SECRET>` |
| Member deleted | `https://<worker>.workers.dev/webhook/deleted?secret=<WEBHOOK_SECRET>` |

### 6. Register Discord slash commands

Register the `/link` and `/unlink` commands with the Discord API for your application. Set the **Interactions Endpoint URL** to `https://<worker>.workers.dev/discord` in the Discord Developer Portal.

### 7. Discord bot permissions

The bot's role must be **higher** in the server's role hierarchy than the "Member" and "Premium Member" roles it manages.

## API Reference

### Webhook Endpoints

#### `POST /webhook`

Handles `member.added` and `member.updated` events from Ghost.

- **Auth**: `?secret=<WEBHOOK_SECRET>` query parameter
- **Body**: Ghost webhook payload

#### `POST /webhook/deleted`

Handles `member.deleted` events from Ghost.

- **Auth**: `?secret=<WEBHOOK_SECRET>` query parameter
- **Body**: Ghost webhook payload

### Discord Interactions

#### `POST /discord`

Handles Discord slash command interactions (`/link`, `/unlink`). Requests are verified using Ed25519 signature validation.

### Admin Endpoints

All admin endpoints require the `Authorization: Bearer <ADMIN_SECRET>` header.

#### `POST /link`

Create an email → Discord user mapping.

```sh
curl -X POST https://<worker>.workers.dev/link \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "discord_user_id": "123456789"}'
```

#### `GET /link/:email`

Look up a Discord user ID by email.

```sh
curl https://<worker>.workers.dev/link/user@example.com \
  -H "Authorization: Bearer <ADMIN_SECRET>"
```

#### `DELETE /link`

Remove an email → Discord user mapping.

```sh
curl -X DELETE https://<worker>.workers.dev/link \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'
```

## Local Development

Create a `.dev.vars` file at the project root:

```
WEBHOOK_SECRET=test
ADMIN_SECRET=admin-secret
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_GUILD_ID=your-guild-id
DISCORD_PUBLIC_KEY=your-public-key
DISCORD_ROLE_MEMBER=your-member-role-id
DISCORD_ROLE_PREMIUM=your-premium-role-id
GHOST_URL=https://your-ghost-site.com
GHOST_ADMIN_API_KEY=your-id:your-secret
```

Start the dev server:

```sh
npm run dev
```

## Security

- **Webhook authentication**: Ghost webhooks are validated via a shared secret passed as a query parameter, compared using a constant-time algorithm.
- **Admin authentication**: The `/link` endpoints are protected by a Bearer token checked with constant-time comparison.
- **Discord signature verification**: Slash command interactions are verified using Ed25519 signature validation with Discord's public key.
- **Ghost email verification**: The `/link` slash command verifies that the email exists as a Ghost member via the Admin API before creating the mapping.
- **Email validation**: All email inputs are validated against RFC 5322 format before processing to prevent injection attacks.
- **No sensitive data exposure**: Discord API errors are logged server-side only; users receive generic error messages.
- **Graceful skipping**: If a Ghost member email has no corresponding Discord mapping, webhooks return `200 OK` with `skipped: true` to prevent Ghost from retrying.
