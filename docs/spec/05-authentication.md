# 05 — Authentication

The worker has four distinct authentication mechanisms, one per trust boundary. All comparisons of secret material use **constant-time** byte comparison (`timingSafeEqual` in `src/utils.ts`).

## Summary

| Endpoint | Mechanism | Secret Used |
|----------|-----------|-------------|
| `POST /code` | Ghost-signed member JWT (RS256/RS384/RS512), verified against Ghost JWKS | `GHOST_URL` (for JWKS endpoint) |
| `POST /webhook/added`, `POST /webhook/updated`, `POST /webhook/deleted` | HMAC-SHA256 signature, 5-min replay window | `WEBHOOK_SECRET` |
| `POST /discord` | Ed25519 signature (Discord public key) | `DISCORD_PUBLIC_KEY` |
| `POST/DELETE /link`, `GET /link/:email` | HTTP Bearer token | `ADMIN_SECRET` |

The worker is **also** an authenticated client of two external APIs:

| Outbound | Mechanism | Credential |
|----------|-----------|------------|
| Discord REST API | `Authorization: Bot <token>` | `DISCORD_BOT_TOKEN` |
| Ghost Admin API | `Authorization: Ghost <jwt>` (HS256, 5-min TTL) | `GHOST_ADMIN_API_KEY` (format `id:hex_secret`) |
| Ghost JWKS endpoint | None (public) | n/a |

---

## Ghost Member JWT (`POST /code`)

### Purpose

Establishes that the caller controls a specific Ghost member email. Ghost-issued member JWTs are signed with the site's private key, so only an authenticated Ghost browser session can mint one. The Worker uses this as proof-of-ownership before issuing a redemption code.

### Request shape

```json
{ "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ii4uLiJ9.<payload>.<sig>" }
```

### Verification algorithm (`verifyGhostMemberJWT` in `src/jwt.ts`)

1. Split into three base64url segments. Reject if structure is malformed.
2. Decode and parse the header. Require `alg` to be one of `RS256`, `RS384`, `RS512` (Ghost uses `RS512` by default).
3. Require `header.kid` to be non-empty.
4. Fetch JWKS from `<GHOST_URL>/members/.well-known/jwks.json`. Result cached per-isolate for 1 hour.
5. Select the JWK whose `kid` matches `header.kid`. No fallback to "first key".
6. Import the JWK as an `RSASSA-PKCS1-v1_5` public key with the hash matching `alg` (`SHA-256` / `SHA-384` / `SHA-512`).
7. Verify the signature over `${headerB64}.${payloadB64}`.
8. Validate `exp` (must be in the future). If `iss` is present, require its URL **origin** to equal `GHOST_URL`'s origin (parsed via `new URL()`, not `startsWith`).
9. Extract email from `payload.email ?? payload.sub`, lowercase it.

Failure at any step returns `null` → handler responds `401 Invalid token`.

### Code generation

After successful verification, the Worker generates an 8-character Crockford-base32 code from `crypto.getRandomValues` and writes it to KV with `expirationTtl: 600`. The code is returned in the response body.

### JWKS caching

A module-level cache (per V8 isolate) holds the JWKS for up to 1 hour. Isolate eviction naturally clears stale entries; no manual invalidation is implemented. If Ghost rotates keys, brief verification failures (≤1h) are possible until the cache refreshes — acceptable for this use case.

---

## Ghost Webhook Signature (`X-Ghost-Signature`)

### Header format

```
X-Ghost-Signature: sha256=<hex_digest>, t=<unix_milliseconds>
```

### Verification algorithm (`verifyGhostSignature` in `src/webhooks.ts`)

1. Parse header into `{ sha256, t }`. Reject if either is missing.
2. Parse `t` as integer milliseconds. Reject if `|now - t| > 5 * 60 * 1000` (5 minutes).
3. Read the raw request body as text.
4. Compute `HMAC-SHA256(body + t, WEBHOOK_SECRET)` and hex-encode.
5. `timingSafeEqual` against the received hex.
6. On success, return the body string for downstream parsing; on any failure, return null → handler responds `401`.

### Replay protection

The ±5-minute timestamp window is the sole replay defense. There is no nonce store or per-request deduplication.

---

## Discord Interaction Signature (Ed25519)

### Headers

```
X-Signature-Ed25519:    <hex_signature>
X-Signature-Timestamp:  <unix_seconds>
```

### Verification algorithm (`verifyDiscordSignature` in `src/discord.ts`)

1. Read both headers; reject if either is missing.
2. Read the raw body as text.
3. Import `DISCORD_PUBLIC_KEY` (hex-decoded) as an Ed25519 public key via `crypto.subtle.importKey`.
4. Verify the signature over the message `timestamp + body`.
5. On success, return the body string; on failure, return null → handler responds `401`.

There is no timestamp staleness check on Discord interactions — Discord's signature already binds the timestamp, and Discord clients send near-real-time.

### PING contract

After verification, if `interaction.type === 1`, the handler responds `{ "type": 1 }`. This is Discord's endpoint-health validation during application setup.

---

## Admin Bearer Token

### Header

```
Authorization: Bearer <ADMIN_SECRET>
```

### Verification (`checkAdmin` in `src/admin.ts`)

```ts
function checkAdmin(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return false;
  return timingSafeEqual(auth.slice(7), env.ADMIN_SECRET);
}
```

- The secret must match exactly (no truncation, no prefix tolerance).
- Constant-time comparison prevents timing-based brute force.
- There is no rotation mechanism beyond updating the secret via `wrangler secret put` and redeploying clients.

---

## Outbound: Discord Bot Token

Used on every Discord REST API call:

```
Authorization: Bot <DISCORD_BOT_TOKEN>
```

Required Discord application scope: bot must have **Manage Roles** permission in the guild. The bot's highest role must be **above** the two managed roles in the guild's role hierarchy (Discord rule, not enforced by the worker).

---

## Outbound: Ghost Admin JWT (`generateGhostJWT` in `src/ghost.ts`)

The `GHOST_ADMIN_API_KEY` has the format `<id>:<hex_secret>`. The worker mints a short-lived JWT per request:

| Field | Value |
|-------|-------|
| Header | `{ alg: "HS256", typ: "JWT", kid: <id> }` |
| Payload | `{ iss: <id>, aud: "/admin/", iat: now, exp: now + 300 }` |
| Signature | HMAC-SHA256 over `base64url(header).base64url(payload)`, key = `hexToBytes(secret)` |

Token TTL is **5 minutes**. Tokens are not cached — a new one is minted per Ghost API call. This is acceptable because `getGhostMember` is called only during code redemption, which is low-frequency.

The token is sent as:

```
Authorization: Ghost <jwt>
```

### Why is the Admin API still needed?

The member JWT verified at `POST /code` proves email ownership but does **not** include the member's current paid/free/comped status (Ghost's member JWT payload is identity-only). To assign the premium role at link time, the Worker still needs to look up status via the Admin API after redemption. If immediate premium-role assignment were dropped (deferring it to the next `member.updated` webhook), the Admin API dependency could be removed entirely.

---

## Constant-Time Comparison (`timingSafeEqual` in `src/utils.ts`)

Used for both `WEBHOOK_SECRET` (signature hex) and `ADMIN_SECRET` (bearer token) comparisons.

```ts
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const maxLen = Math.max(bufA.length, bufB.length);
  let result = bufA.length ^ bufB.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return result === 0;
}
```

- Compares over `max(len(a), len(b))` to avoid early termination based on length.
- XORs the lengths into the result so unequal-length inputs cannot return true.
