# Ghost → Discord Cloudflare Worker

## Commands

- `npm run dev` — Start local dev server with `wrangler dev`
- `npm run deploy` — Deploy to Cloudflare with `wrangler deploy`
- `npm run types` — Generate Cloudflare Worker types with `wrangler types`

## Architecture

Cloudflare Worker (TypeScript) that receives Ghost CMS webhooks and updates Discord roles.

```
Ghost CMS ──webhook──▶ Cloudflare Worker ──Discord API──▶ Discord Server
                              │
                        Cloudflare KV
                     (email → discord_user_id)
```

### Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/webhook` | POST | `?secret=` query param | Ghost webhook for member.added / member.updated |
| `/webhook/deleted` | POST | `?secret=` query param | Ghost webhook for member.deleted |
| `/link` | POST | `Authorization: Bearer` | Create email → discord_user_id mapping |
| `/link` | DELETE | `Authorization: Bearer` | Delete a mapping |
| `/link/:email` | GET | `Authorization: Bearer` | Get a mapping |

### Event Logic

| Ghost Event | Action |
|-------------|--------|
| member.added (free) | Add "Membre" role |
| member.added (paid/comped) | Add "Membre" + "Membre Premium" roles |
| member.deleted | Remove all roles |
| member.updated (free→paid) | Add "Membre Premium" role |
| member.updated (paid→free) | Remove "Membre Premium" role |

## Configuration

### KV Namespace

Create a KV namespace and update the `id` in `wrangler.toml`:

```sh
npx wrangler kv namespace create GHOST_DISCORD_MAPPING
```

### Secrets

Set all secrets via Wrangler:

```sh
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_GUILD_ID
npx wrangler secret put DISCORD_ROLE_MEMBER
npx wrangler secret put DISCORD_ROLE_PREMIUM
```

For local development, create a `.dev.vars` file:

```
WEBHOOK_SECRET=test
ADMIN_SECRET=admin-secret
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_GUILD_ID=your-guild-id
DISCORD_ROLE_MEMBER=your-member-role-id
DISCORD_ROLE_PREMIUM=your-premium-role-id
```

### Ghost Configuration

In Ghost Admin → Integrations → Custom Integration, create 3 webhooks:
- **Member added** → `POST https://<worker>.workers.dev/webhook?secret=<WEBHOOK_SECRET>`
- **Member updated** → `POST https://<worker>.workers.dev/webhook?secret=<WEBHOOK_SECRET>`
- **Member deleted** → `POST https://<worker>.workers.dev/webhook/deleted?secret=<WEBHOOK_SECRET>`
