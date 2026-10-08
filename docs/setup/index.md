# Installation guide

Six steps, in this order. Each step lists what you need, what to do, and how to check it worked before moving on. Allow about 45 minutes the first time.

| Step | What you do | Where | Time |
|---|---|---|---|
| [1. Prepare Discord](1-discord.md) | Create the application and bot, the two roles, collect the IDs | Discord | 10 min |
| [2. Deploy the Worker](2-deploy.md) | Fill in the secrets file, run `./deploy.sh` | Terminal | 10 min |
| [3. Connect Discord](3-connect-discord.md) | Point Discord to the Worker, check the slash commands | Discord | 5 min |
| [4. Configure Ghost webhooks](4-ghost-webhooks.md) | Tell Ghost to notify the Worker of member changes | Ghost Admin | 5 min |
| [5. Deploy the widget on Ghost](5-ghost-widget.md) | Paste the "Get my Discord code" widget into a Ghost page and publish it | Ghost Admin (+ nginx) | 10 min |
| [6. Test & go live](6-test.md) | Run the full member flow, then announce it | Ghost + Discord | 5 min |

## Before you start

- [x] [Node.js](https://nodejs.org/) **20 or newer** and Git on your computer
- [x] A [Cloudflare](https://dash.cloudflare.com/sign-up) account (the free plan is enough)
- [x] **Administrator** rights on your Discord server
- [x] **Administrator** rights on a Ghost site running a **recent Ghost 6.x**

!!! question "Is my Ghost recent enough?"
    Open `https://<your-site>/members/api/entitlements` in a browser. **204** (empty page) or a long token means the endpoint exists. **404** means you must update Ghost first.

    ```sh
    curl -s -o /dev/null -w '%{http_code}\n' https://<your-site>/members/api/entitlements
    ```

## Your values worksheet

You will collect these values along the way. Keep them in a scratch file; they all end up in the secrets file at step 2.

| Value | What it is | Step |
|---|---|---|
| `DISCORD_APPLICATION_ID` | Discord application ID | 1 |
| `DISCORD_PUBLIC_KEY` | Discord application public key (64 hex characters) | 1 |
| `DISCORD_BOT_TOKEN` | Bot token (**secret**) | 1 |
| `DISCORD_GUILD_ID` | Your Discord server ID | 1 |
| `DISCORD_ROLE_MEMBER` | ID of the role every member gets | 1 |
| `DISCORD_ROLE_PREMIUM` | ID of the role paid and comped members get | 1 |
| `GHOST_URL` | Your site's origin, e.g. `https://www.example.com` (no trailing slash) | 2 |
| `WEBHOOK_SECRET` | Random string shared with Ghost (**secret**) | 2 |
| `ADMIN_SECRET` | Random string protecting the admin API (**secret**) | 2 |
| Worker URL | `https://ghost-discord-worker.<account>.workers.dev` | 2 |

!!! tip "Upgrading an existing installation?"
    Skip to [Operations → Upgrading](../operations.md#upgrading). Since version 2.0.1 the linking page **must** be replaced (step 5), otherwise members get a `401` when generating a code.

[Start with step 1: Prepare Discord :material-arrow-right:](1-discord.md){ .md-button .md-button--primary }
