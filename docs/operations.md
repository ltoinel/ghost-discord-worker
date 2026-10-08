# Operations

Day-to-day administration once the [installation](setup/index.md) is done.

## Watch the logs

```sh
npx wrangler tail
```

Each request appears with its status, plus the Worker's own log lines (codes issued, webhooks received, Discord errors).

## Link a member manually

The admin API links, reads or removes a mapping without the self-service flow, for example for a long-time subscriber. To find someone's Discord user ID, right-click their name with Developer Mode on → **Copy User ID**.

```sh
# Create (discord_user_id must be a Discord snowflake: 17 to 20 digits)
curl -X POST https://<worker-url>/link \
  -H "Authorization: Bearer <ADMIN_SECRET>" -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "discord_user_id": "987654321098765432"}'

# Read
curl https://<worker-url>/link/user@example.com \
  -H "Authorization: Bearer <ADMIN_SECRET>"

# Delete (also removes the member's roles; 502 and mapping kept if that fails)
curl -X DELETE https://<worker-url>/link \
  -H "Authorization: Bearer <ADMIN_SECRET>" -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'
```

`POST /link` does not assign roles by itself: they follow at the member's next Ghost change. The full contract is in the [API reference](spec/04-api-reference.md).

## Upgrading

```sh
git pull
npm ci
./deploy.sh
```

Your secrets and KV data stay in Cloudflare; `deploy.sh` runs the tests before publishing. Check [the KV namespace ID](setup/2-deploy.md#24-deploy) in `wrangler.toml` first if you work from a fresh clone.

!!! warning "Upgrading to 2.0.1 or later"
    1. **Replace the widget** on your Ghost page with the [current version](setup/5-ghost-widget.md#53-widget-code). The Worker now only accepts the entitlement token (`/members/api/entitlements`); the old widget gets a `401`.
    2. Make sure Ghost exposes `/members/api/entitlements` (recent Ghost 6.x).
    3. Remove the secret that is no longer used: `npx wrangler secret delete GHOST_ADMIN_API_KEY`.
    4. Add the `[[ratelimits]]` block from `wrangler.toml.sample` to your `wrangler.toml`.

## Rotate a secret

```sh
npx wrangler secret put <NAME>
```

- **`WEBHOOK_SECRET`**: update the Secret of the three webhooks in Ghost at the same time, or webhooks fail with `401` in between.
- **`DISCORD_BOT_TOKEN`**: click **Reset Token** in the Developer Portal first, then update the secret.
- **`ADMIN_SECRET`**: only your admin scripts use it.
