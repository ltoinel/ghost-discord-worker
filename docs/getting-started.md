# Getting started

Deploy the Worker, connect Ghost and Discord, and give members a one-click linking page. Allow about 20 minutes.

## Prerequisites

- [Node.js](https://nodejs.org/) **20 or newer** (Ed25519 in Web Crypto)
- A [Cloudflare](https://cloudflare.com/) account
- A [Discord application and bot](https://discord.com/developers/applications) with the **Manage Roles** permission
- A [Ghost](https://ghost.org/) site on a **recent Ghost 6.x** release that exposes `/members/api/entitlements`

## 1. Deploy the Worker

```sh
git clone https://github.com/ltoinel/ghost-discord-worker.git
cd ghost-discord-worker
npm ci
npx wrangler login
```

Create a secrets file. The Discord values come from [Discord setup](discord-setup.md). Keep the file out of git: `.dev.vars` is already ignored, and so is any `.env*` file.

```ini title=".env.prod"
WEBHOOK_SECRET=<the Secret of your Ghost custom integration>
ADMIN_SECRET=<a long random string for the /link admin API>
DISCORD_BOT_TOKEN=<bot token>
DISCORD_GUILD_ID=<server ID>
DISCORD_PUBLIC_KEY=<application public key>
DISCORD_ROLE_MEMBER=<role ID of the member role>
DISCORD_ROLE_PREMIUM=<role ID of the premium role>
GHOST_URL=https://your-ghost-site.com
# Used by deploy.sh to register the slash commands; not uploaded as a secret.
DISCORD_APPLICATION_ID=<application ID>
```

Then deploy everything in one go:

```sh
./deploy.sh --secrets .env.prod --register-commands
```

??? info "What `deploy.sh` does"
    1. Checks Node ≥ 20 and your Cloudflare login (`wrangler login` or `CLOUDFLARE_API_TOKEN`).
    2. On first run, creates `wrangler.toml` from `wrangler.toml.sample` and the `GHOST_DISCORD_MAPPING` KV namespace.
    3. Type-checks and runs the test suite (fails under 90% coverage).
    4. Runs `wrangler deploy`.
    5. With `--secrets FILE`, uploads every `KEY=VALUE` with `wrangler secret bulk`.
    6. With `--register-commands`, registers `/link` and `/unlink` on your server.

    Other flags: `--skip-tests`, `--dry-run` (builds the bundle without publishing), `--help`.

## 2. Configure Discord

The [Discord setup](discord-setup.md) guide covers it step by step: create the application and bot, collect the IDs for your secrets file, create the roles, set the Interactions Endpoint URL and register the slash commands. In short:

1. In the [Developer Portal](https://discord.com/developers/applications), set **Interactions Endpoint URL** to `https://<worker>.workers.dev/discord`.
2. In your server settings, drag the bot's role **above** the member and premium roles so it can manage them.

!!! tip
    You need the Discord IDs and the bot token *before* step 1, so you can fill in the secrets file. Follow sections 1 and 2 of [Discord setup](discord-setup.md) first.

## 3. Configure Ghost webhooks

In **Ghost Admin → Settings → Integrations → Custom Integration**, create three webhooks. The integration's **Secret** must equal `WEBHOOK_SECRET`. The Worker checks the `X-Ghost-Signature` HMAC on every call.

| Event | URL |
|---|---|
| Member added | `https://<worker>.workers.dev/webhook/added` |
| Member updated | `https://<worker>.workers.dev/webhook/updated` |
| Member deleted | `https://<worker>.workers.dev/webhook/deleted` |

## 4. Add the linking page to Ghost

Create a Ghost page (for example `/discord/`) and paste the ready-to-use widget from
[Configuration → "Get my Discord code" page](spec/08-configuration.md#get-my-discord-code-page-theme-js) into an **HTML card**. The widget:

1. Fetches `/members/api/entitlements`, the member's Ghost-signed JWT with their email and `paid` flag.
2. POSTs it to the Worker's `/code` endpoint.
3. Shows the 8-character code with a copy button and a 10-minute countdown.

!!! tip "Recommended: proxy `/code` through nginx"
    If Ghost sits behind nginx, add a `location = /code` block so the browser calls your own domain.
    The call becomes same-origin (no CORS preflight) and the Worker hostname stays private.
    See [Configuration → nginx reverse proxy](spec/08-configuration.md#nginx-reverse-proxy-recommended).

    Without the proxy, set `CODE_URL` in the widget to the absolute Worker URL, and make sure `GHOST_URL`
    matches your site origin exactly: it is sent back as `Access-Control-Allow-Origin`.

## Member flow

Once the page is live, members:

1. Sign in to the Ghost site.
2. Open the Discord page and click **Get my Discord code**.
3. Type `/link <code>` in Discord.
4. Get their roles immediately. Later subscription changes sync automatically through the webhooks.

`/unlink` removes their roles, then the mapping (if Discord refuses the role removal, the link is kept so they can retry). Each email can be linked to one Discord account, and each Discord account to one email.

## Admin API

Operators can manage mappings directly with `Authorization: Bearer <ADMIN_SECRET>`:

```sh
# Create
curl -X POST https://<worker>.workers.dev/link \
  -H "Authorization: Bearer <ADMIN_SECRET>" -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "discord_user_id": "987654321098765432"}'

# Read
curl https://<worker>.workers.dev/link/user@example.com \
  -H "Authorization: Bearer <ADMIN_SECRET>"

# Delete (also removes the member's roles; 502 and mapping kept if that fails)
curl -X DELETE https://<worker>.workers.dev/link \
  -H "Authorization: Bearer <ADMIN_SECRET>" -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'
```

The full contract for every endpoint is in the [API reference](spec/04-api-reference.md).
