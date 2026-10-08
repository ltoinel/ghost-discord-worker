# Ghost → Discord Cloudflare Worker

## Commands

- `npm run dev` — Start local dev server with `wrangler dev`
- `npm run deploy` / `./deploy.sh` — Type-check, test, then `wrangler deploy` (`--secrets FILE`, `--register-commands`, `--dry-run`, `--skip-tests`; creates `wrangler.toml` + KV namespace on first run)
- `npm run types` — Generate Cloudflare Worker types with `wrangler types`
- `npm run build` — Type-check with `tsc --noEmit`
- `npm test` — Run unit tests (Vitest, plain Node — requires Node ≥ 20 for Ed25519 in Web Crypto)
- `npm run test:coverage` — Tests with v8 coverage; fails under 90% (thresholds in `vitest.config.mts`)
- `npm run test:watch` — Vitest watch mode
- `mkdocs serve` — Preview the docs site (`pip install -r requirements-docs.txt`); specs live in `docs/spec/`, published to GitHub Pages by `.github/workflows/docs.yml`

CI (`.github/workflows/`): `ci.yml` (build + coverage on Node 20/22/24, `npm audit`, ShellCheck, gitleaks, dependency review), `codeql.yml`, `docs.yml`.

## Architecture

Cloudflare Worker (TypeScript) that receives Ghost CMS webhooks and updates Discord roles. Linking flow: a logged-in Ghost browser session fetches `/members/api/entitlements` and calls `POST /code` with the member's signed entitlement JWT (email + `paid` flag); the Worker verifies the JWT against Ghost's JWKS (and requires `scope: "members:entitlements:read"`), (`iss`/`aud` required, unknown `kid` forces a JWKS refetch at most once a minute), then mints a single-use code stored as `{email, paid}` (10-min TTL in KV; one live code per member via `pending:<email>`, reused while ≥ 120 s remain; optional `CODE_RATE_LIMITER` rate-limit binding → 429). The user then runs `/link <code>` in Discord; the Worker redeems the code (deleted before the mapping is written), writes the bidirectional mapping in KV, and assigns Discord roles from the stored `paid` flag (no Ghost Admin API call). Requires a recent Ghost 6.x exposing `/members/api/entitlements`.

```
Browser (Ghost page)   ─JWT─▶ Cloudflare Worker ─JWKS─▶  Ghost CMS
                              │
Ghost CMS ──webhook──▶ Cloudflare Worker ──Discord API──▶ Discord Server
                              │
Discord User ──/link <code>─▶ Cloudflare Worker
                              │
                        Cloudflare KV
                  (email ↔ discord_user_id, code:CODE → {email, paid} TTL,
                   pending:email → CODE TTL)
```

### Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/discord` | POST | Ed25519 signature (timestamp within ±5 min) | Discord interactions (slash commands) |
| `/code` | POST | Ghost member entitlement JWT (RS256/RS384/RS512, `scope: members:entitlements:read`) | Mint a single-use linking code for `/link` |
| `/code` | OPTIONS | — | CORS preflight |
| `/webhook/added` | POST | X-Ghost-Signature (HMAC-SHA256) | Ghost webhook for member.added |
| `/webhook/updated` | POST | X-Ghost-Signature (HMAC-SHA256) | Ghost webhook for member.updated |
| `/webhook/deleted` | POST | X-Ghost-Signature (HMAC-SHA256) | Ghost webhook for member.deleted |
| `/link` | POST | `Authorization: Bearer` | Create email → discord_user_id mapping (admin; snowflake ID required, stale reverse keys dropped) |
| `/link` | DELETE | `Authorization: Bearer` | Remove both roles, then delete the mapping (admin; 502 + mapping kept if role removal fails) |
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
| `/unlink` | Remove Member + Premium roles, then the mapping (mapping kept if role removal fails) |

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
```

### Ghost Configuration

In Ghost Admin → Integrations → Custom Integration, create 3 webhooks (the integration's Secret must equal `WEBHOOK_SECRET`):
- **Member added** → `POST https://<worker>.workers.dev/webhook/added`
- **Member updated** → `POST https://<worker>.workers.dev/webhook/updated`
- **Member deleted** → `POST https://<worker>.workers.dev/webhook/deleted`
