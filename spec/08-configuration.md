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
| `GHOST_URL` | URL (no trailing slash) | Base URL of the Ghost site (e.g., `https://blog.example.com`) |
| `GHOST_ADMIN_API_KEY` | string (`id:hex_secret`) | Ghost Admin API key for member lookups |

The `Env` interface in `src/types.ts` is the authoritative list of required bindings.

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
GHOST_ADMIN_API_KEY=your-id:your-secret
```

## NPM Scripts

| Script | Action |
|--------|--------|
| `npm run dev` | `wrangler dev` — local Workers runtime with `.dev.vars` |
| `npm run build` | `tsc --noEmit` — type-check only |
| `npm run deploy` | `wrangler deploy` — push to Cloudflare |
| `npm run types` | `wrangler types` — regenerate `Env`/binding types |

## Ghost CMS Setup

### Webhooks

Three webhooks must be registered in **Ghost Admin → Settings → Integrations → Custom Integration**, one per event with a dedicated URL:

| Event | URL |
|-------|-----|
| Member added | `https://<worker-domain>/webhook/added` |
| Member updated | `https://<worker-domain>/webhook/updated` |
| Member deleted | `https://<worker-domain>/webhook/deleted` |

The integration's **Secret** must equal `WEBHOOK_SECRET`. Ghost will then send `X-Ghost-Signature` headers signed with this secret.

The same Ghost integration also exposes the **Admin API Key** (format `id:secret`) used for member status lookups during code redemption. Set it as `GHOST_ADMIN_API_KEY`.

### nginx reverse proxy (recommended)

Ghost is typically served behind nginx. Add a `/code` location to your Ghost site's nginx server block so the browser calls `https://<ghost-site>/code` instead of the Cloudflare Worker URL directly. This hides the Worker hostname from end users and turns the browser request into a same-origin call — no CORS preflight is performed.

```nginx
# In your existing Ghost site server { } block:

location = /code {
    # Re-resolve workers.dev DNS at runtime — Cloudflare edge IPs are dynamic
    # and nginx caches the boot-time resolution forever without an explicit resolver,
    # which eventually surfaces as `502 "no live upstreams"`.
    resolver 1.1.1.1 8.8.8.8 valid=60s ipv6=off;

    # Using a variable in proxy_pass forces per-request DNS resolution via the
    # resolver above (the hostname becomes "dynamic" to nginx).
    set $worker_upstream "<worker-subdomain>.workers.dev";
    proxy_pass https://$worker_upstream$request_uri;

    # Preserve the upstream Host + SNI so Cloudflare routes to the right Worker.
    proxy_set_header Host $worker_upstream;
    proxy_ssl_server_name on;
    proxy_ssl_name        $worker_upstream;
    proxy_ssl_verify      on;

    # Forward client info (useful for Worker logs / abuse detection).
    proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP        $remote_addr;

    # Tight timeouts: the Worker should answer in well under a second.
    proxy_connect_timeout 5s;
    proxy_send_timeout    10s;
    proxy_read_timeout    10s;

    proxy_http_version 1.1;
    proxy_buffering    off;
}
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

Create a Ghost page (e.g., "Discord access") and paste the following snippet into an **HTML card** in the Ghost editor. Optionally set the page visibility to members-only.

The script:
1. Calls `/members/api/session` with cookies — Ghost returns the member's identity JWT as plain text (or 401/204 when no session).
2. POSTs the JWT to `/code` on the **same origin** (proxied to the Worker by nginx).
3. Displays the code with a copy button and a live countdown until expiry.

```html
<div id="discord-link" class="discord-link">
  <button id="dl-btn" type="button">Get my Discord code</button>
  <div id="dl-result" hidden>
    <p class="dl-instructions">Here is your linking code:</p>
    <div class="dl-code-row">
      <code id="dl-code" class="dl-code"></code>
      <button id="dl-copy" type="button" aria-label="Copy code">Copy</button>
    </div>
    <p class="dl-instructions">
      In Discord, type <code>/link <span id="dl-code-inline"></span></code>.
      Code expires in <span id="dl-countdown"></span>.
    </p>
  </div>
  <p id="dl-error" class="dl-error" hidden></p>
</div>

<style>
  .discord-link { max-width: 32rem; margin: 2rem auto; font-family: inherit; }
  .discord-link button {
    padding: 0.6rem 1.2rem; border: 0; border-radius: 6px;
    background: #5865F2; color: #fff; font-weight: 600; cursor: pointer;
  }
  .discord-link button:disabled { opacity: 0.6; cursor: progress; }
  .dl-code-row { display: flex; gap: 0.5rem; align-items: center; margin: 0.5rem 0; }
  .dl-code {
    font-size: 1.4rem; font-weight: 700; letter-spacing: 0.15em;
    padding: 0.4rem 0.8rem; background: #f4f4f5; border-radius: 6px;
  }
  .dl-instructions { color: #555; font-size: 0.95rem; }
  .dl-error { color: #b91c1c; }
</style>

<script>
(() => {
  // Same-origin path proxied to the Cloudflare Worker by nginx.
  // The Worker URL is never exposed to the browser.
  const CODE_URL = "/code";

  const btn       = document.getElementById("dl-btn");
  const result    = document.getElementById("dl-result");
  const codeEl    = document.getElementById("dl-code");
  const inlineEl  = document.getElementById("dl-code-inline");
  const countdown = document.getElementById("dl-countdown");
  const copyBtn   = document.getElementById("dl-copy");
  const errorEl   = document.getElementById("dl-error");

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    result.hidden = true;
  }

  function formatRemaining(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m} min ${s.toString().padStart(2, "0")}s` : `${s}s`;
  }

  let countdownTimer = null;
  function startCountdown(expiresIn) {
    let remaining = expiresIn;
    countdown.textContent = formatRemaining(remaining);
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdown.textContent = "expired — click again to generate a new one";
        return;
      }
      countdown.textContent = formatRemaining(remaining);
    }, 1000);
  }

  btn.addEventListener("click", async () => {
    errorEl.hidden = true;
    result.hidden = true;
    btn.disabled = true;
    btn.textContent = "Generating…";

    try {
      const sessionRes = await fetch("/members/api/session", { credentials: "include" });
      if (sessionRes.status === 401 || sessionRes.status === 204) {
        showError("Please sign in to your account before generating a code.");
        return;
      }
      if (!sessionRes.ok) {
        showError("Unable to retrieve your Ghost session. Please try again later.");
        return;
      }
      const token = (await sessionRes.text()).trim();
      if (!token) {
        showError("Please sign in to your account before generating a code.");
        return;
      }

      const codeRes = await fetch(CODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!codeRes.ok) {
        const body = await codeRes.json().catch(() => ({}));
        showError(body.error || `Error ${codeRes.status} while generating the code.`);
        return;
      }
      const { code, expires_in } = await codeRes.json();

      codeEl.textContent = code;
      inlineEl.textContent = code;
      result.hidden = false;
      startCountdown(expires_in);
    } catch (err) {
      showError("Network error. Check your connection and try again.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate a new code";
    }
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(codeEl.textContent);
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    } catch {
      const range = document.createRange();
      range.selectNode(codeEl);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  });
})();
</script>
```

**Before pasting:**

- Set up the nginx `location = /code` block above and reload nginx first.
- `/members/api/session` is the standard endpoint on Ghost 5.x. If your version exposes the member JWT elsewhere, change the URL in the script.
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
