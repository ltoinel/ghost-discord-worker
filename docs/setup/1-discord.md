# Step 1 · Prepare Discord

!!! abstract ""
    **You need:** administrator rights on your Discord server · **You get:** 6 values for the secrets file · **Time:** 10 min

The Worker talks to Discord through an application and its bot. You create both here, plus the two roles the bot will hand out. Nothing points to the Worker yet: that comes at [step 3](3-connect-discord.md), once it is deployed.

## 1.1 Create the application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** (top right), name it (your site's name works well), accept the terms and confirm.

## 1.2 Copy the application ID and public key

In the left menu, open **General Information**:

- **Application ID** → `DISCORD_APPLICATION_ID`
- **Public Key** → `DISCORD_PUBLIC_KEY`

You can set an icon and a description here; they appear on the bot's profile. Leave **Interactions Endpoint URL** empty for now.

## 1.3 Generate the bot token

1. Open the **Bot** tab.
2. Click **Reset Token**, confirm, and copy the value → `DISCORD_BOT_TOKEN`. Discord shows it only once.
3. Leave every **Privileged Gateway Intent** disabled: the Worker receives commands over HTTP and never connects to the Gateway.

!!! danger "Keep the bot token secret"
    Never commit it or paste it in a channel. Anyone holding it can act as your bot. If it leaks, click **Reset Token** again and update the Worker secret.

## 1.4 Set the installation permissions

Open the **Installation** tab:

1. **Installation Contexts**: tick **Guild Install**. **User Install** is not needed, you can untick it.
2. **Default Install Settings → Guild Install**:
    - **Scopes**: `applications.commands` and `bot`
    - **Permissions**: **Manage Roles** only
3. Click **Save Changes**.

## 1.5 Invite the bot to your server

Still in **Installation**, open the **Install Link** in your browser (`https://discord.com/oauth2/authorize?client_id=<DISCORD_APPLICATION_ID>`), choose **Add to Server**, pick your server and confirm.

??? note "Optional: make the bot private"
    Once installed, you can stop others from adding it to their servers: in **Installation**, set **Install Link** to **None**, then in **Bot**, turn off **Public Bot**. Discord only allows this when no install link is set; re-enable the link temporarily if you need to re-invite the bot.

## 1.6 Enable Developer Mode

Developer Mode adds **Copy ID** to Discord's right-click menus: **User Settings** (gear icon) → **Advanced** → turn on **Developer Mode**.

## 1.7 Copy the server ID

Right-click your server icon → **Copy Server ID** → `DISCORD_GUILD_ID`.

## 1.8 Create the two roles

1. **Server Settings → Roles → Create Role**.
2. Create one role for every member (for example **Member**) and one for paying members (for example **Premium Member**). Names, colours and channel permissions are up to you: the Worker only uses the IDs.
3. Right-click each role → **Copy Role ID**:
    - member role → `DISCORD_ROLE_MEMBER`
    - premium role → `DISCORD_ROLE_PREMIUM`

## 1.9 Put the bot's role above them

In **Server Settings → Roles**, drag the role named after your bot **above** both roles.

!!! warning "The most common mistake"
    Discord does not let a bot manage a role placed above its own. If you skip this, linking "works" but members see *"roles could not be assigned"*.

## Check before moving on

- [ ] The bot appears in your server's member list (offline is normal: it never connects to the Gateway).
- [ ] In **Server Settings → Roles**, the bot's role sits above your two roles.
- [ ] You have 6 values: `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_ROLE_MEMBER`, `DISCORD_ROLE_PREMIUM`.

[Next: Deploy the Worker :material-arrow-right:](2-deploy.md){ .md-button .md-button--primary }
