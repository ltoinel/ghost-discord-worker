# Discord setup

This page walks through everything on the Discord side: the application and bot, the server roles, the interactions endpoint and the slash commands. Allow about 15 minutes.

!!! abstract "Values you will collect"
    Write these down as you go. They end up in your secrets file (see [Getting started](getting-started.md#1-deploy-the-worker)).

    | Value | What it is | Example | Step |
    |---|---|---|---|
    | `DISCORD_APPLICATION_ID` | Application ID, used to register the slash commands | `1412189819643236422` | [1.2](#12-copy-the-application-id-and-public-key) |
    | `DISCORD_PUBLIC_KEY` | Application public key, 64 hex characters | `23e755d2…bce9f` | [1.2](#12-copy-the-application-id-and-public-key) |
    | `DISCORD_BOT_TOKEN` | Secret bot token | `MTQxMjE4…` | [1.3](#13-generate-the-bot-token) |
    | `DISCORD_GUILD_ID` | Your server ID | `987654321098765432` | [2.2](#22-copy-the-server-id) |
    | `DISCORD_ROLE_MEMBER` | ID of the role every member gets | `111111111111111111` | [2.3](#23-create-the-two-roles) |
    | `DISCORD_ROLE_PREMIUM` | ID of the role paid and comped members get | `222222222222222222` | [2.3](#23-create-the-two-roles) |

!!! danger "Keep the bot token secret"
    Never commit the bot token to git or paste it in a public channel. Anyone holding it can act as your bot.

## 1. Create the Discord application

### 1.1 Create the application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** (top right), name it (your blog's name works well), accept the terms and confirm.

### 1.2 Copy the application ID and public key

In the left menu, open **General Information**:

- Copy the **Application ID** → `DISCORD_APPLICATION_ID`.
- Copy the **Public Key** → `DISCORD_PUBLIC_KEY`.

You can also set an icon and a description here; they appear on the bot's profile. Leave **Interactions Endpoint URL** empty for now: you fill it in [step 3](#3-connect-discord-to-the-worker), once the Worker is deployed.

### 1.3 Generate the bot token

1. Open the **Bot** tab.
2. Click **Reset Token**, confirm, and copy the value → `DISCORD_BOT_TOKEN`. Discord shows it only once.
3. Leave every **Privileged Gateway Intent** disabled. The Worker receives commands over HTTP and never connects to the Gateway.

### 1.4 Set the installation permissions

Open the **Installation** tab:

1. Under **Installation Contexts**, tick **Guild Install**. **User Install** is not needed (roles only exist on your server), so you can untick it.
2. Under **Default Install Settings → Guild Install**:
    - **Scopes**: `applications.commands` and `bot`.
    - **Permissions**: **Manage Roles** only. The Worker needs nothing else.
3. Click **Save Changes**.

### 1.5 Invite the bot to your server

Still in **Installation**, copy the **Install Link** Discord generates:

```text
https://discord.com/oauth2/authorize?client_id=<DISCORD_APPLICATION_ID>
```

Open it in your browser, choose **Add to Server**, pick your server and confirm.

### 1.6 Make the bot private (optional)

Once the bot is installed, you can stop others from adding it to their servers: in **Installation**, set **Install Link** to **None**, then in **Bot**, turn off **Public Bot**.

!!! note
    Discord only lets you turn off **Public Bot** when no default install link is set. To re-invite the bot later, re-enable the link temporarily.

## 2. Prepare your Discord server

### 2.1 Enable Developer Mode

Developer Mode adds **Copy ID** to Discord's context menus.

**User Settings** (gear icon, bottom left) → **Advanced** → turn on **Developer Mode**.

### 2.2 Copy the server ID

Right-click your server icon in the left column → **Copy Server ID** → `DISCORD_GUILD_ID`.

### 2.3 Create the two roles

1. **Server Settings → Roles → Create Role**.
2. Create one role for every member (for example **Member**) and one for paying members (for example **Premium Member**). The names are up to you: the Worker only uses the IDs. Set colours and permissions as you like, such as access to a members-only channel.
3. Right-click each role in the list → **Copy Role ID**:
    - the member role → `DISCORD_ROLE_MEMBER`
    - the premium role → `DISCORD_ROLE_PREMIUM`

### 2.4 Put the bot's role above them

!!! warning "The most common mistake"
    Discord does not let a bot manage a role that sits above its own in the hierarchy.

In **Server Settings → Roles**, drag the role named after your bot **above** both roles from step 2.3. Otherwise role assignment fails with HTTP `403` and members see *"roles could not be assigned"*.

## 3. Connect Discord to the Worker

Do this once the Worker is deployed ([Getting started, step 1](getting-started.md#1-deploy-the-worker)).

### 3.1 Set the Interactions Endpoint URL

1. Go back to the Developer Portal → your application → **General Information**.
2. In **Interactions Endpoint URL**, enter:

    ```text
    https://<worker>.workers.dev/discord
    ```

    Make sure no space slipped in before or after the URL.

3. Click **Save Changes**.

Discord immediately sends a signed test request (`PING`) to the Worker. If the URL is accepted, signature verification works. If it is rejected, check that the `DISCORD_PUBLIC_KEY` secret exactly matches the public key on this page.

### 3.2 Register the slash commands

The Worker does not declare `/link` and `/unlink` itself; they must be registered once with the Discord API. Registering them on your server (guild commands) takes effect immediately.

=== "With deploy.sh"

    Add `DISCORD_APPLICATION_ID` to your secrets file, then:

    ```sh
    ./deploy.sh --secrets .env.prod --register-commands
    ```

    `DISCORD_APPLICATION_ID` is only used locally; it is not uploaded as a Worker secret.

=== "With curl"

    ```sh
    curl -X PUT \
      "https://discord.com/api/v10/applications/<DISCORD_APPLICATION_ID>/guilds/<DISCORD_GUILD_ID>/commands" \
      -H "Authorization: Bot <DISCORD_BOT_TOKEN>" \
      -H "Content-Type: application/json" \
      -d '[
        {
          "name": "link",
          "description": "Redeem your Ghost-issued linking code",
          "options": [
            { "name": "code", "description": "The code displayed on your Ghost site", "type": 3, "required": true }
          ]
        },
        { "name": "unlink", "description": "Unlink your Ghost email from your Discord account" }
      ]'
    ```

    The response is a JSON array containing both commands.

Descriptions are free text and can be translated. The names `link`, `unlink` and `code` must stay exactly as they are: the Worker relies on them.

To check, type `/` in a channel of your server: your bot's commands appear.

## 4. Test the full flow

1. Sign in to your blog with a test member account.
2. Open your Discord page on the blog (for example `/discord/`) and click the button. An 8-character code appears with a 10-minute countdown.
3. In a channel of your Discord server, type `/link` and paste the code.
4. The bot replies with a message only you can see: *"Your email … has been linked to your Discord account."*
5. Check that the member role appears on your profile.
6. In Ghost Admin, give this member a complimentary (comped) subscription: the premium role appears a few seconds later.
7. Type `/unlink` to remove the link: the bot confirms that your roles have been removed, and both roles disappear from your profile.

!!! info "`/unlink` removes the roles"
    `/unlink` first removes the member and premium roles, then deletes the email ↔ Discord mapping. Once unlinked, Ghost webhooks can no longer reach the account, so roles left behind could never be revoked. If Discord refuses the removal, the link is kept and the bot replies *"Your roles could not be removed, so your account is still linked…"*: fix the cause (usually the role hierarchy, [step 2.4](#24-put-the-bots-role-above-them)) and run `/unlink` again.

Follow the Worker's activity live while testing:

```sh
npx wrangler tail
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Discord rejects the Interactions Endpoint URL | Wrong public key, Worker not deployed, or a stray space in the URL | Check `DISCORD_PUBLIC_KEY`, redeploy with `./deploy.sh`, clean up the field |
| `/link` and `/unlink` do not show up | Commands not registered, or bot installed without `applications.commands` | Redo [step 3.2](#32-register-the-slash-commands); re-invite the bot with both scopes |
| *"Invalid or expired code"* | Code expired (10 min), already used or mistyped | Generate a new code |
| *"Unable to retrieve your membership details"* on the blog page | Ghost version without `/members/api/entitlements` | Update Ghost to a recent 6.x |
| *"Expected an entitlement token…"* on the blog page | Old widget still calling `/members/api/session` | Paste the [current widget](spec/08-configuration.md#get-my-discord-code-page-theme-js) |
| Linked, but *"roles could not be assigned"* | Bot role below the managed roles, or **Manage Roles** permission missing | Redo [step 2.4](#24-put-the-bots-role-above-them) and check the bot's permissions |
| `/unlink` replies *"Your roles could not be removed, so your account is still linked…"* | Same causes: bot role below the managed roles, or **Manage Roles** missing | Redo [step 2.4](#24-put-the-bots-role-above-them), then run `/unlink` again |
| *"Too many requests, please wait a minute"* on the blog page | The optional `CODE_RATE_LIMITER` caps code requests per member | Wait a minute, then click again: the same code comes back as long as it has at least 2 minutes left |
| Network error on the blog page | Wrong `CODE_URL`, missing nginx proxy, or `GHOST_URL` different from the real origin | Check [the linking page setup](getting-started.md#4-add-the-linking-page-to-ghost); `GHOST_URL` has no trailing slash and the right `www` |
| `502` on `/code` after a few hours | nginx proxy without `resolver` | Use the exact block from [nginx reverse proxy](spec/08-configuration.md#nginx-reverse-proxy-recommended) |
| Subscription changes are not reflected | Webhook missing, wrong URL, or secret different from `WEBHOOK_SECRET` | Check [the Ghost webhooks](getting-started.md#3-configure-ghost-webhooks) and `npx wrangler tail` |

## Manual linking

The [admin API](getting-started.md#admin-api) can link a member without the self-service flow, for example for a long-time subscriber. To find someone's Discord user ID, right-click their name with Developer Mode on → **Copy User ID**.

## Developer Portal checklist

| Portal screen | Field | Value |
|---|---|---|
| General Information | Interactions Endpoint URL | `https://<worker>.workers.dev/discord` |
| General Information | Linked Roles Verification URL | empty |
| Installation | Installation Contexts | Guild Install |
| Installation | Scopes (Guild Install) | `applications.commands`, `bot` |
| Installation | Permissions (Guild Install) | Manage Roles |
| Bot | Privileged Gateway Intents | all disabled |
| Bot | Public Bot | off once the bot is installed (optional) |
