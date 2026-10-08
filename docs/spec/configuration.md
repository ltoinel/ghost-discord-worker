# Configuration

Reference only. For a first installation, follow the [installation guide](../setup/index.md).

## Secrets

Set with `npx wrangler secret put <NAME>`, or all at once with `./deploy.sh --secrets <file>`. All are required; `Env` in `src/types.ts` is the authoritative list.

| Secret | Purpose | Read by |
|---|---|---|
| `GHOST_URL` | Ghost site origin, scheme + host, no trailing slash (e.g. `https://www.example.com`). JWKS location, expected JWT `iss` / `aud` origin, CORS origin. | `jwt.ts`, `code.ts` |
| `WEBHOOK_SECRET` | HMAC key of Ghost webhooks; must equal the Secret of the Ghost custom integration | `webhooks.ts` |
| `ADMIN_SECRET` | Bearer token of the admin `/link` endpoints | `admin.ts` |
| `DISCORD_PUBLIC_KEY` | Discord application public key (hex), verifies interactions | `commands.ts` → `discord.ts` |
| `DISCORD_BOT_TOKEN` | Bot token for role calls | `discord.ts` |
| `DISCORD_GUILD_ID` | Discord server ID | `discord.ts` |
| `DISCORD_ROLE_MEMBER` | ID of the role every linked member gets | `commands.ts`, `webhooks.ts`, `admin.ts` |
| `DISCORD_ROLE_PREMIUM` | ID of the role paid and comped members get | `commands.ts`, `webhooks.ts`, `admin.ts` |

No Ghost Admin API key is used: the member's status comes from the entitlement token. `DISCORD_APPLICATION_ID`, if present in the secrets file, is used only by `deploy.sh --register-commands` and is not uploaded.

## Bindings (`wrangler.toml`)

`wrangler.toml` is git-ignored; `deploy.sh` creates it from `wrangler.toml.sample` on first run and creates the KV namespace. An existing `wrangler.toml` is never rewritten, so new blocks from the sample must be copied by hand.

| Binding | Type | Required | Use |
|---|---|---|---|
| `GHOST_DISCORD_MAPPING` | KV namespace | yes | All state ([data model](data-model.md)) |
| `CODE_RATE_LIMITER` | Workers rate limit | no | Caps `POST /code` per member email |

```toml
[[kv_namespaces]]
binding = "GHOST_DISCORD_MAPPING"
id = "xxxxxx"

# Caps POST /code at 5 calls per minute per member email (optional but recommended).
# namespace_id is any positive integer unique to this rate limiter in your account.
[[ratelimits]]
name = "CODE_RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 5, period = 60 }
```

Without the `[[ratelimits]]` block, `POST /code` is not rate-limited (code reuse still bounds KV writes). Cloudflare accepts a `period` of 10 or 60 seconds and counts per location, approximately.

## Local development

`npm run dev` reads secrets from `.dev.vars` at the project root (git-ignored):

```ini title=".dev.vars"
WEBHOOK_SECRET=test
ADMIN_SECRET=admin-secret
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_GUILD_ID=your-guild-id
DISCORD_PUBLIC_KEY=your-public-key
DISCORD_ROLE_MEMBER=your-member-role-id
DISCORD_ROLE_PREMIUM=your-premium-role-id
GHOST_URL=https://your-ghost-site.com
```

## npm scripts

| Script | Runs | Notes |
|---|---|---|
| `npm run dev` | `wrangler dev` | Local Workers runtime with `.dev.vars` and a local KV |
| `npm run lint` | `biome lint --error-on-warnings` | Lint (`biome.json`); warnings fail |
| `npm run build` | `tsc --noEmit` | Type-check only |
| `npm test` | `vitest run` | Node ≥ 20 (Ed25519 in Web Crypto) |
| `npm run test:coverage` | `vitest run --coverage` | Fails under 90% coverage |
| `npm run test:watch` | `vitest` | Watch mode |
| `npm run deploy` | `./deploy.sh` | Type-check, tests, then `wrangler deploy`; see `./deploy.sh --help` |
| `npm run types` | `wrangler types` | Regenerates `worker-configuration.d.ts` |
| `prepare` (automatic) | `git config core.hooksPath .githooks` | Runs on `npm install`; enables the [git hooks](../development.md#git-hooks) |

## External requirements

- **Ghost:** a recent Ghost 6.x exposing `GET /members/api/entitlements`. Older versions only offer the identity token (`/members/api/session`), which `POST /code` rejects. Three webhooks (member added, updated, deleted) point to `/webhook/added`, `/webhook/updated` and `/webhook/deleted` ([step 4](../setup/4-ghost-webhooks.md)).
- **Linking page:** the widget and the optional nginx `location = /code` proxy are documented in [step 5](../setup/5-ghost-widget.md).
- **Discord:** Interactions Endpoint URL set to `/discord`, `/link` and `/unlink` registered, bot with **Manage Roles** and its role above both managed roles ([steps 1 and 3](../setup/1-discord.md)).
