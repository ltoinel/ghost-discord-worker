# Step 3 · Connect Discord to the Worker

<nav class="gd-stepper" aria-label="Installation progress">
  <a href="../1-discord/" class="done"><b>Step 1</b>Prepare Discord</a>
  <a href="../2-deploy/" class="done"><b>Step 2</b>Deploy the Worker</a>
  <a href="../3-connect-discord/" class="current" aria-current="step"><b>Step 3</b>Connect Discord</a>
  <a href="../4-ghost-webhooks/" class=""><b>Step 4</b>Ghost webhooks</a>
  <a href="../5-ghost-widget/" class=""><b>Step 5</b>Deploy the widget on Ghost</a>
  <a href="../6-test/" class=""><b>Step 6</b>Test &amp; go live</a>
</nav>


!!! abstract ""
    **You need:** the Worker URL from [step 2](2-deploy.md) · **You get:** `/link` and `/unlink` working in your server · **Time:** 5 min

## 3.1 Set the Interactions Endpoint URL

1. In the [Developer Portal](https://discord.com/developers/applications), open your application → **General Information**.
2. In **Interactions Endpoint URL**, enter `https://<worker-url>/discord` (no space before or after).
3. Click **Save Changes**.

Discord immediately sends a signed test request to the Worker. If the URL is saved, signature verification works.

!!! failure "Discord refuses the URL"
    The `DISCORD_PUBLIC_KEY` secret does not match the **Public Key** on this page, or the Worker is not deployed. Fix the secret with `npx wrangler secret put DISCORD_PUBLIC_KEY` and save again.

## 3.2 Check the slash commands

`./deploy.sh --register-commands` registered them at step 2. Type `/` in a channel of your server: `/link` and `/unlink` from your bot should be listed.

??? info "Commands missing? Register them by hand"
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

    Descriptions can be translated; the names `link`, `unlink` and `code` must stay as they are. If they still do not appear, the bot was installed without the `applications.commands` scope: redo [step 1.4](1-discord.md#14-set-the-installation-permissions) and re-invite it.

## Check before moving on

- [ ] The Interactions Endpoint URL is saved without error.
- [ ] Typing `/` in your server lists `/link` and `/unlink`.
- [ ] `/link ABCD1234` replies *"Invalid or expired code"* (only you see it). That proves the whole Discord → Worker path works.

[Next: Configure Ghost webhooks :material-arrow-right:](4-ghost-webhooks.md){ .md-button .md-button--primary }
