# 08 — Configuration

## Required Secrets

All values are set via `wrangler secret put <NAME>` (production) or `.dev.vars` (local).

| Secret | Type | Purpose |
|--------|------|---------|
| `WEBHOOK_SECRET` | string | HMAC key for verifying Ghost webhook signatures |
| `ADMIN_SECRET` | string | Bearer token expected by admin `/link` endpoints |
| `DISCORD_BOT_TOKEN` | string | Discord bot token (`OTk5...` format) |
| `DISCORD_GUILD_ID` | string (numeric) | Discord server ID |
| `DISCORD_PUBLIC_KEY` | hex string | Discord application's Ed25519 public key (interactions) |
| `DISCORD_ROLE_MEMBER` | string (numeric) | Snowflake ID of the "Member" role |
| `DISCORD_ROLE_PREMIUM` | string (numeric) | Snowflake ID of the "Premium Member" role |
| `GHOST_URL` | URL (no trailing slash) | Base URL of the Ghost site (e.g., `https://blog.example.com`) — used for the JWKS endpoint, the JWT `iss` / `aud` checks, and as the CORS origin |

The `Env` interface in `src/types.ts` is the authoritative list of required bindings. No Ghost Admin API key is needed: the member's paid status comes from the entitlement JWT presented to `POST /code`.

## KV Namespace

A single KV namespace bound as `GHOST_DISCORD_MAPPING`. Create with:

```sh
npx wrangler kv namespace create GHOST_DISCORD_MAPPING
```

The output `id` must be copied into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "GHOST_DISCORD_MAPPING"
id = "<namespace-id>"
```

No preview namespace is required by the worker (none is referenced).

## `wrangler.toml`

Authoritative configuration shape:

```toml
name = "ghost-discord-worker"
main = "src/index.ts"
compatibility_date = "2024-12-02"

[[kv_namespaces]]
binding = "GHOST_DISCORD_MAPPING"
id = "<namespace-id>"
```

The `compatibility_date` of `2024-12-02` is required for Web Crypto `Ed25519` support (used by Discord signature verification).

### Rate limiting (optional)

`POST /code` can be throttled per member with a [Workers rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) named `CODE_RATE_LIMITER`. `wrangler.toml.sample` includes it (recommended); keep this block in your `wrangler.toml` to enable it, or remove it to disable rate limiting:

```toml
# Caps POST /code at 5 calls per minute per member email (optional but recommended).
# namespace_id is any positive integer unique to this rate limiter in your account.
[[ratelimits]]
name = "CODE_RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 5, period = 60 }   # period in seconds: Cloudflare accepts 10 or 60
```

`deploy.sh` only creates `wrangler.toml` from the sample on first run, so an existing `wrangler.toml` must be updated by hand.

The Worker calls it with the member email as key, after the JWT is verified. Over the limit, `POST /code` returns `429 { "error": "Too many requests, please wait a minute" }` with `Retry-After: 60`. The binding is optional (`CODE_RATE_LIMITER?: RateLimit` in `Env`): without it, no rate limit is applied.

Why it matters: the KV free tier allows **1,000 writes per day**. Each newly minted code costs two writes (`code:<CODE>` and `pending:<email>`). Code reuse already limits a member to roughly one new code per 8 minutes, and repeated clicks while a code is live cost reads only; the rate limiter additionally caps the reads and JWKS-backed verifications a single logged-in member can trigger. Cloudflare rate limits are counted per location and are approximate, so treat them as abuse damping, not an exact quota.

## Local Development (`.dev.vars`)

A `.dev.vars` file at the project root provides secrets for `wrangler dev`. It must **not** be committed (it appears in `.gitignore`).

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

## NPM Scripts

| Script | Action |
|--------|--------|
| `npm run dev` | `wrangler dev` — local Workers runtime with `.dev.vars` |
| `npm run build` | `tsc --noEmit` — type-check only |
| `npm run deploy` | `wrangler deploy` — push to Cloudflare |
| `npm run types` | `wrangler types` — regenerate `Env`/binding types |
| `npm test` | `vitest run` — single test run (requires Node ≥ 20 for Ed25519 in Web Crypto) |
| `npm run test:watch` | `vitest` — watch mode |

## Ghost CMS Setup

### Webhooks

Three webhooks must be registered in **Ghost Admin → Settings → Integrations → Custom Integration**, one per event with a dedicated URL:

| Event | URL |
|-------|-----|
| Member added | `https://<worker-domain>/webhook/added` |
| Member updated | `https://<worker-domain>/webhook/updated` |
| Member deleted | `https://<worker-domain>/webhook/deleted` |

The integration's **Secret** must equal `WEBHOOK_SECRET`. Ghost will then send `X-Ghost-Signature` headers signed with this secret.

### Ghost version

The linking page relies on `GET /members/api/entitlements`, which is only available on a recent Ghost 6.x. Older Ghost versions (which only expose the identity token at `/members/api/session`) are not supported for linking: the Worker rejects identity tokens.

### nginx reverse proxy (recommended)

Ghost is typically served behind nginx. Add a `/code` location to your Ghost site's nginx server block so the browser calls `https://<ghost-site>/code` instead of the Cloudflare Worker URL directly. This hides the Worker hostname from end users and turns the browser request into a same-origin call — no CORS preflight is performed.

```nginx
--8<-- "nginx-code.conf"
```

After editing, validate and reload:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

Notes:

- The `location = /code` form is an **exact match** — it will not shadow Ghost's `/members/`, posts, or any other path.
- The `resolver` + variable-in-`proxy_pass` pattern is **required**, not optional. Without it, nginx resolves `workers.dev` once at startup and never refreshes. When Cloudflare rotates the underlying IP, every subsequent request fails with `502 "no live upstreams"` in `/var/log/nginx/error.log`.
- `proxy_pass https://$worker_upstream$request_uri;` preserves the `/code` path because `$request_uri` already includes it.
- The other Worker endpoints (`/webhook/added`, `/webhook/updated`, `/webhook/deleted`, `/discord`, `/link`, `/link/:email`) are called by Ghost, Discord, and operators directly. They are **not** proxied; they remain on the Worker domain.
- CORS headers on the Worker are still emitted and remain valid, but the browser path no longer triggers preflight, so they become inert in the proxied flow. Keep them — they preserve the ability to call the Worker directly during testing.

### "Get my Discord code" page (theme JS)

!!! tip
    The [installation guide, step 5](../setup/5-ghost-widget.md) walks through publishing this page in Ghost.

Create a Ghost page (e.g., "Discord access") and paste the following snippet into an **HTML card** in the Ghost editor. Optionally set the page visibility to members-only.

The script:
1. Calls `/members/api/entitlements` with cookies — Ghost returns the member's entitlement JWT (email + `paid` flag, valid 5 minutes) as plain text (or 204 when no session).
2. POSTs the JWT to `/code` on the **same origin** (proxied to the Worker by nginx).
3. Displays the code with a copy button and a live countdown until expiry.

```html
--8<-- "discord-widget.html"
```

**Before pasting:**

- Set up the nginx `location = /code` block above and reload nginx first.
- `/members/api/entitlements` requires a recent Ghost 6.x. On older versions it does not exist (the fetch fails with a non-OK status), and the identity token from `/members/api/session` will **not** work: `POST /code` rejects it with `401 Expected an entitlement token from /members/api/entitlements`.
- If you choose **not** to use the nginx proxy, set `CODE_URL` to the absolute Worker URL (e.g., `"https://ghost-discord-worker.<account>.workers.dev/code"`) and verify the Worker's `GHOST_URL` secret exactly matches the Ghost site origin (scheme + host, no trailing slash) — that value is sent back as `Access-Control-Allow-Origin` during preflight.

## Discord Setup

### Application

- Create a Discord application in the [Developer Portal](https://discord.com/developers/applications).
- Note the **Public Key** → `DISCORD_PUBLIC_KEY`.
- Generate a **Bot Token** → `DISCORD_BOT_TOKEN`.

### Interactions Endpoint

In the Developer Portal → application settings → **Interactions Endpoint URL**, set:

```
https://<worker-domain>/discord
```

Discord will PING this endpoint during save; the worker's `type: 1` PING response satisfies the handshake.

### Bot installation

Install the bot in the target guild with the **Manage Roles** scope. The bot's primary role must sit **above** both `DISCORD_ROLE_MEMBER` and `DISCORD_ROLE_PREMIUM` in the role hierarchy (Discord enforces this; the worker does not). Otherwise, role mutations will fail with `403`.

### Slash command registration

Register `link` and `unlink` against the Discord API (see [07 — Slash Commands](./07-slash-commands.md) for definitions). This is a one-time operation and is not performed by the worker.

## Operational Properties

| Property | Value |
|----------|-------|
| Statelessness | All state in KV; no in-memory state survives invocations |
| Idle cost | $0 (Workers free tier covers most low-traffic deployments) |
| Cold start | Negligible (V8 isolate model) |
| Scaling | Automatic, per Cloudflare's edge runtime |
| Persistence guarantees | KV is eventually consistent (rare global propagation delays) |
