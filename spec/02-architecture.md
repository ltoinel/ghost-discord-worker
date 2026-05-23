# 02 — Architecture

## System Diagram

```
                                ┌──────────────────────────────┐
                                │   Cloudflare Worker          │
                                │   (ghost-discord-worker)     │
                                │                              │
  Ghost CMS  ─────webhook───────┤ /webhook/added               │
                                │ /webhook/updated             ├──Discord API──▶  Discord Server
                                │ /webhook/deleted             │
                                │                              │
  Browser  ─▶ nginx /code ─────▶┤ /code (Ghost member JWT)     ├──Ghost JWKS──▶   Ghost CMS
  (Ghost     (same-origin       │                              │   /members/.well-known
   page)      reverse proxy)    │                              │
                                │                              │
  Discord  ─────POST────────────┤ /discord (Ed25519-signed)    ├──Ghost Admin──▶  Ghost CMS
   user                         │                              │   API
                                │                              │
  Operator ─────HTTPS──────────▶│ /link  (Bearer-auth admin)   │
   / script                     │ /link/:email                 │
                                └──────────┬───────────────────┘
                                           │
                                           ▼
                                ┌──────────────────────────────┐
                                │  Cloudflare KV               │
                                │  GHOST_DISCORD_MAPPING       │
                                │  - email ↔ user_id           │
                                │  - code:<code> → email (TTL) │
                                └──────────────────────────────┘
```

Only `/code` is reverse-proxied through the Ghost site's nginx; all other endpoints face their respective callers (Ghost, Discord, operators) directly on the Worker domain. See [08 — Configuration](./08-configuration.md#nginx-reverse-proxy-recommended) for the nginx snippet.

## Module Layout (`src/`)

| File | Responsibility |
|------|----------------|
| `index.ts` | HTTP router: dispatches by path + method to handlers. Only entry point exported. |
| `webhooks.ts` | Ghost webhook handlers (`/webhook/added`, `/webhook/updated`, `/webhook/deleted`); HMAC verification; role sync. |
| `commands.ts` | Discord interaction handler (`/discord`); routes `/link <code>` and `/unlink` slash commands. |
| `code.ts` | `POST /code` handler + CORS preflight; mints redemption codes after JWT verification. |
| `jwt.ts` | Ghost member JWT (RS256/RS384/RS512) verification via JWKS; per-isolate JWKS cache. |
| `admin.ts` | Admin endpoints (`/link` POST/DELETE, `/link/:email` GET); Bearer-auth CRUD on mappings. |
| `discord.ts` | Discord REST client (add/remove role) + Ed25519 interaction signature verification. |
| `ghost.ts` | Ghost Admin API client; HS256 JWT generation; member lookup by email. |
| `types.ts` | Shared TypeScript interfaces (`Env`, `GhostMemberData`, `GhostWebhookPayload`, ...). |
| `utils.ts` | Cross-cutting helpers: `json()`, `timingSafeEqual()`, `isValidEmail()`, `hexToBytes()`, `isPaid()`. |

## Request Routing (from `index.ts`)

The router is a flat sequence of `path === "..." && method === "..."` checks. No middleware framework, no path parameters except for `/link/:email`.

| Path | Method | Handler |
|------|--------|---------|
| `/discord` | POST | `handleDiscordInteraction` |
| `/code` | POST | `handleCodePost` |
| `/code` | OPTIONS | `handleCodeOptions` (CORS preflight) |
| `/webhook/added` | POST | `handleMemberAdded` |
| `/webhook/updated` | POST | `handleMemberUpdated` |
| `/webhook/deleted` | POST | `handleMemberDeleted` |
| `/link` | POST | `handleLinkPost` |
| `/link` | DELETE | `handleLinkDelete` |
| `/link/<email>` | GET | `handleLinkGet` |
| (anything else) | any | `404 { error: "Not found" }` |

For `/link/<email>`, the email is extracted as `decodeURIComponent(path.slice(6))`.

## Data Flow — Ghost Webhook

```
1. Ghost POSTs to /webhook/{added|updated|deleted} with X-Ghost-Signature header.
2. verifyGhostSignature():
     - Parse "sha256=<hex>, t=<ms>" header.
     - Reject if timestamp older than 5 minutes (replay protection).
     - HMAC-SHA256(body + timestamp) using WEBHOOK_SECRET.
     - timingSafeEqual against received hex.
3. Parse JSON payload. Extract email:
     - /webhook/added, /webhook/updated → member.current.email
     - /webhook/deleted                  → member.previous.email
4. KV lookup: email → discord_user_id. If missing, return 200 { skipped: true }.
5. Per-endpoint role logic:
     - added:   PUT Member, plus PUT Premium if isPaid(current.status)
     - updated: PUT or DELETE Premium based on free↔paid transition (no-op otherwise)
     - deleted: DELETE Member, DELETE Premium
6. Return 200 { ok: true }.
```

## Data Flow — Code Mint (Browser → nginx → Worker)

```
1. User loads "Get Discord access" page on Ghost site (must be logged in).
2. Page JS calls GET /members/api/session (same-origin, session cookie sent automatically).
   Ghost returns the member's identity JWT as plain text.
3. Page POSTs { token } to /code (same-origin — no CORS preflight).
4. nginx matches `location = /code` and proxy_passes to the Cloudflare Worker,
   preserving the request body and setting Host to the Worker domain.
5. Worker.verifyGhostMemberJWT():
     - Decode header; require alg ∈ {RS256, RS384, RS512} and a non-empty kid.
     - Fetch JWKS from <GHOST_URL>/members/.well-known/jwks.json (cached 1h per isolate).
     - RSASSA-PKCS1-v1_5 verify signature with the hash matching the alg, against the JWK whose kid matches.
     - Validate exp and (if present) iss origin equals GHOST_URL origin.
6. Worker generates 8-char base32 code; KV.put("code:<code>", email, { expirationTtl: 600 }).
7. Worker returns { code, expires_in: 600 }; nginx streams the response back.
8. Page displays the code with copy button and countdown.
```

When the nginx hop is skipped (direct browser → Worker), the flow is identical except the browser issues an `OPTIONS /code` preflight that the Worker answers with CORS headers locked to `GHOST_URL`.

## Data Flow — Discord Slash Command

```
1. Discord POSTs to /discord with X-Signature-Ed25519 + X-Signature-Timestamp headers.
2. verifyDiscordSignature():
     - Ed25519.verify(timestamp + body) against DISCORD_PUBLIC_KEY.
3. If interaction.type === 1 (PING) → reply { type: 1 } (Discord health check).
4. If interaction.type === 2 (APPLICATION_COMMAND):
     - "link" → handleLinkCommand:
         - Read code; KV.get("code:<code>") → email (or "Invalid or expired").
         - Conflict checks (1:1 email ↔ user_id).
         - getGhostMember(email) for current status.
         - Write mapping (both directions), delete code (single-use).
         - Assign Member role + Premium role if isPaid(status).
     - "unlink" → handleUnlinkCommand (delete mapping).
5. Reply with type 4 + flags 64 (ephemeral message, visible to invoker only).
```

## Data Flow — Admin Link CRUD

```
1. Operator (or external system) calls /link with Authorization: Bearer <ADMIN_SECRET>.
2. checkAdmin(): timingSafeEqual of bearer vs ADMIN_SECRET.
3. POST: validate email, write email→user_id AND discord:user_id→email.
4. DELETE: read email→user_id, delete both directions.
5. GET: read email→user_id, return JSON or 404.
```

Admin endpoints do **not** verify the email exists in Ghost; they trust the caller. They also do **not** assign Discord roles — they only manage the KV mapping.

## Deployment Topology

- Single Cloudflare Worker, deployed via `wrangler deploy`.
- Single KV namespace `GHOST_DISCORD_MAPPING` bound to the worker.
- No queues, no Durable Objects, no R2.
- All secrets stored in Cloudflare's encrypted secret store (set via `wrangler secret put`).
- Local development uses `.dev.vars` and a simulated KV via `wrangler dev`.

## Concurrency & Idempotency

- **Idempotent role operations.** Discord's `PUT .../roles/:roleId` is idempotent; reapplying it on an already-assigned role is a no-op. The worker does not pre-check role membership.
- **No deduplication.** Duplicate webhook deliveries from Ghost will result in duplicate (idempotent) Discord API calls. The replay window (5 minutes) is the only deduplication boundary.
- **No transactions in KV.** The `email ↔ discord:user_id` mapping is written/deleted as two separate `put`/`delete` calls. A partial failure between them leaves the store temporarily inconsistent (see [10 — Error Handling](./10-error-handling.md)).
