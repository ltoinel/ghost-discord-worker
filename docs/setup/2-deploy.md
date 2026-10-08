# Step 2 · Deploy the Worker

!!! abstract ""
    **You need:** the 6 Discord values from [step 1](1-discord.md), a Cloudflare account · **You get:** the Worker URL · **Time:** 10 min

## 2.1 Get the code and log in to Cloudflare

```sh
git clone https://github.com/ltoinel/ghost-discord-worker.git
cd ghost-discord-worker
npm ci
npx wrangler login
```

`wrangler login` opens your browser to authorise the CLI. In CI, export `CLOUDFLARE_API_TOKEN` instead.

## 2.2 Generate the two shared secrets

```sh
openssl rand -hex 32   # → WEBHOOK_SECRET (you will paste it into Ghost at step 4)
openssl rand -hex 32   # → ADMIN_SECRET   (protects the admin API)
```

## 2.3 Create the secrets file

Create `.env.prod` at the project root. It is git-ignored (`.env*`), never commit it.

```ini title=".env.prod"
# From step 1
DISCORD_APPLICATION_ID=<application ID>
DISCORD_PUBLIC_KEY=<application public key>
DISCORD_BOT_TOKEN=<bot token>
DISCORD_GUILD_ID=<server ID>
DISCORD_ROLE_MEMBER=<member role ID>
DISCORD_ROLE_PREMIUM=<premium role ID>

# Your Ghost site origin: scheme + host, no trailing slash, exact www or not
GHOST_URL=https://www.example.com

# From 2.2
WEBHOOK_SECRET=<first random string>
ADMIN_SECRET=<second random string>
```

!!! warning "`GHOST_URL` must match your site exactly"
    It is used to verify the member tokens (`iss`, `aud`) and as the CORS origin. `https://example.com` and `https://www.example.com` are different origins.

## 2.4 Deploy

```sh
./deploy.sh --secrets .env.prod --register-commands
```

The script:

1. checks Node ≥ 20 and your Cloudflare login;
2. on first run, creates `wrangler.toml` from `wrangler.toml.sample` and the `GHOST_DISCORD_MAPPING` KV namespace;
3. type-checks and runs the tests (fails under 90% coverage);
4. deploys with `wrangler deploy` and prints the **Worker URL**;
5. uploads the secrets (`DISCORD_APPLICATION_ID` stays local);
6. registers `/link` and `/unlink` on your server.

Write down the Worker URL it prints, for example `https://ghost-discord-worker.<account>.workers.dev`.

!!! info "Already have a KV namespace?"
    If you are reinstalling, do **not** let the script create a new namespace, or you lose the existing links. Find the ID with `npx wrangler kv namespace list` and put it in `wrangler.toml` (`id = "<32 hex characters>"`) before running `./deploy.sh`.

## Check before moving on

```sh
curl -s https://<worker-url>/          # → {"error":"Not found"}  (the Worker answers)
npx wrangler secret list               # → 8 secrets
```

- [ ] The Worker answers with `{"error":"Not found"}` on `/`.
- [ ] `wrangler secret list` shows `ADMIN_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_ROLE_MEMBER`, `DISCORD_ROLE_PREMIUM`, `GHOST_URL`, `WEBHOOK_SECRET`.
- [ ] The deploy output lists the `GHOST_DISCORD_MAPPING` KV namespace and the `CODE_RATE_LIMITER` rate limit.

[Next: Connect Discord :material-arrow-right:](3-connect-discord.md){ .md-button .md-button--primary }
