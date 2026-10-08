# Step 6 · Test & go live

!!! abstract ""
    **You need:** a test member account on your site and a Discord account in your server · **You get:** a verified installation · **Time:** 5 min

## 6.1 Run the full member flow

Keep `npx wrangler tail` open in a terminal to watch each request.

1. Sign in to your site with the **test member** account.
2. Open `https://<your-site>/discord/` and click **Get my Discord code**.
3. In a channel of your Discord server, type `/link` and paste the code.
4. The bot replies (only you see it): *"Your email … has been linked to your Discord account."*
5. Your profile now shows the **member** role.
6. In Ghost Admin, give this member a **complimentary** subscription: the **premium** role appears a few seconds later (`member.updated` webhook).
7. Remove the complimentary subscription: the premium role disappears.
8. Type `/unlink`: the bot confirms and both roles disappear.

All 8 points pass? The installation is complete.

## 6.2 Announce it to your members

A message you can adapt for your newsletter or a post:

> **Join us on Discord!** Members get access to the community, and paying members to the premium channels.
>
> 1. Sign in on the site and open [Discord access](https://example.com/discord/).
> 2. Click **Get my Discord code**.
> 3. In our Discord server, type `/link` followed by the code.
>
> Your roles follow your subscription automatically.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Discord rejects the Interactions Endpoint URL | Wrong public key, Worker not deployed, or a stray space in the URL | [Step 3.1](3-connect-discord.md#31-set-the-interactions-endpoint-url) |
| `/link` and `/unlink` do not show up | Commands not registered, or bot installed without `applications.commands` | [Step 3.2](3-connect-discord.md#32-check-the-slash-commands) |
| *"Please sign in…"* while signed in | Ghost session not sent: the widget is on another domain than Ghost | Host the page on your Ghost site itself |
| *"Unable to retrieve your membership details"* | Ghost too old: no `/members/api/entitlements` | Update Ghost to a recent 6.x |
| *"Expected an entitlement token…"* | Old widget still calling `/members/api/session` | Replace it with the [current widget](5-ghost-widget.md#53-widget-code) |
| *"Invalid token"* | `GHOST_URL` does not match the site origin (`www`, trailing slash, `http`) | Fix the secret: `npx wrangler secret put GHOST_URL` |
| Network error on the page | Wrong `CODE_URL`, nginx block missing, or CORS origin mismatch | [Step 5.1](5-ghost-widget.md#51-choose-how-the-widget-reaches-the-worker) |
| `502` on `/code` after a few hours | nginx block without `resolver` | Use the exact block from [step 5.1](5-ghost-widget.md#51-choose-how-the-widget-reaches-the-worker) |
| *"Too many requests, please wait a minute"* | Rate limit: 5 code requests per minute per member | Wait a minute; the same code comes back while it has 2+ minutes left |
| *"Invalid or expired code"* | Code expired (10 min), already used, or mistyped | Generate a new code |
| Linked, but *"roles could not be assigned"* | Bot role below the managed roles, or **Manage Roles** missing | [Step 1.9](1-discord.md#19-put-the-bots-role-above-them), then generate a new code |
| `/unlink`: *"Your roles could not be removed…"* | Same causes as above | [Step 1.9](1-discord.md#19-put-the-bots-role-above-them), then `/unlink` again |
| Subscription changes are not reflected | Webhook missing, wrong URL, or secret different from `WEBHOOK_SECRET` | [Step 4](4-ghost-webhooks.md), and look for `401` in `npx wrangler tail` |

## Discord Developer Portal checklist

| Portal screen | Field | Value |
|---|---|---|
| General Information | Interactions Endpoint URL | `https://<worker-url>/discord` |
| General Information | Linked Roles Verification URL | empty |
| Installation | Installation Contexts | Guild Install |
| Installation | Scopes (Guild Install) | `applications.commands`, `bot` |
| Installation | Permissions (Guild Install) | Manage Roles |
| Bot | Privileged Gateway Intents | all disabled |
| Bot | Public Bot | off once the bot is installed (optional) |

Next, day-to-day administration: [Operations](../operations.md).
