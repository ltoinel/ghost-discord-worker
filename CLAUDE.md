# Ghost → Discord Cloudflare Worker

## Commands

- `npm run dev` — Start local dev server with `wrangler dev`
- `npm run deploy` — Deploy to Cloudflare with `wrangler deploy`
- `npm run types` — Generate Cloudflare Worker types with `wrangler types`
- `npm run build` — Type-check with `tsc --noEmit`
- `npm test` — Run unit tests (Vitest, plain Node — requires Node ≥ 20 for Ed25519 in Web Crypto)
- `npm run test:watch` — Vitest watch mode

## Architecture

Cloudflare Worker (TypeScript) that receives Ghost CMS webhooks and updates Discord roles. Linking flow: a logged-in Ghost browser session calls `POST /code` (sending the member's signed JWT); the Worker verifies the JWT against Ghost's JWKS and mints a single-use code (10-min TTL in KV). The user then runs `/link <code>` in Discord; the Worker redeems the code, fetches member status from Ghost Admin API, writes the bidirectional mapping in KV, and assigns Discord roles.

```
Browser (Ghost page)   ─JWT─▶ Cloudflare Worker ─JWKS─▶  Ghost CMS
                              │
Ghost CMS ──webhook──▶ Cloudflare Worker ──Discord API──▶ Discord Server
                              │
Discord User ──/link <code>─▶ Cloudflare Worker ──Ghost Admin API──▶ Ghost CMS
                              │
                        Cloudflare KV
                  (email ↔ discord_user_id, code:CODE → email TTL)
```

### Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/discord` | POST | Ed25519 signature | Discord interactions (slash commands) |
| `/code` | POST | Ghost member JWT (RS256/RS384/RS512) | Mint a single-use linking code for `/link` |
| `/code` | OPTIONS | — | CORS preflight |
| `/webhook/added` | POST | X-Ghost-Signature (HMAC-SHA256) | Ghost webhook for member.added |
| `/webhook/updated` | POST | X-Ghost-Signature (HMAC-SHA256) | Ghost webhook for member.updated |
| `/webhook/deleted` | POST | X-Ghost-Signature (HMAC-SHA256) | Ghost webhook for member.deleted |
| `/link` | POST | `Authorization: Bearer` | Create email → discord_user_id mapping (admin) |
| `/link` | DELETE | `Authorization: Bearer` | Delete a mapping (admin) |
| `/link/:email` | GET | `Authorization: Bearer` | Get a mapping (admin) |

### Event Logic

| Ghost Event | Action |
|-------------|--------|
| member.added (free) | Add "Membre" role |
| member.added (paid/comped) | Add "Membre" + "Membre Premium" roles |
| member.deleted | Remove all roles |
| member.updated (free→paid) | Add "Membre Premium" role |
| member.updated (paid→free) | Remove "Membre Premium" role |

### Slash Commands

| Command | Action |
|---------|--------|
| `/link <code>` | Redeem a single-use code (minted via `POST /code`), store mapping, assign roles |
| `/unlink` | Remove mapping |

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
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_ROLE_MEMBER
npx wrangler secret put DISCORD_ROLE_PREMIUM
npx wrangler secret put GHOST_URL
npx wrangler secret put GHOST_ADMIN_API_KEY
```

For local development, create a `.dev.vars` file:

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

### Ghost Configuration

In Ghost Admin → Integrations → Custom Integration, create 3 webhooks (the integration's Secret must equal `WEBHOOK_SECRET`):
- **Member added** → `POST https://<worker>.workers.dev/webhook/added`
- **Member updated** → `POST https://<worker>.workers.dev/webhook/updated`
- **Member deleted** → `POST https://<worker>.workers.dev/webhook/deleted`
