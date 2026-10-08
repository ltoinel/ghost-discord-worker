# Specification

The Ghost → Discord Worker is a Cloudflare Worker that keeps Discord roles in step with Ghost CMS memberships. Members link their Discord account once, with a single-use code proving they own their Ghost email; from then on Ghost webhooks add or remove their roles as their membership changes.

This specification describes the current code in `src/` for maintainers and reviewers. When it and the code disagree, the code is right and this page is a bug.

## Goals and non-goals

**Goals**

- Discord roles follow Ghost member status with no manual step.
- Self-service linking, with proof that the Discord user owns the Ghost email.
- Serverless: one Worker, one KV namespace, no servers to run.
- Every entry point authenticated; nothing trusted on the strength of its shape alone.

**Non-goals**

- Creating Ghost members, Discord accounts or Discord roles.
- Syncing anything other than membership status (no names, avatars or tier IDs).
- Polling Ghost or Discord: the Worker only reacts to webhooks, interactions and admin calls.
- An admin UI: the admin endpoints are meant for `curl` or scripts.

## Roles managed

The Worker touches exactly two Discord roles, identified by ID. No other role is ever modified.

| Role | Secret | Held by |
|---|---|---|
| Member | `DISCORD_ROLE_MEMBER` | Every linked Ghost member (`free`, `paid` or `comped`) |
| Premium | `DISCORD_ROLE_PREMIUM` | Linked members whose status is `paid` or `comped` |

`paid` and `comped` are treated identically everywhere (`isPaid()` in `src/utils.ts`, and Ghost's own `paid` claim in the entitlement token).

## Architecture

![Architecture](../architecture.svg)

The browser talks to the Worker only through `POST /code`, usually proxied by the Ghost site's nginx so the call is same-origin. Ghost (webhooks), Discord (interactions) and operators (admin API) call the Worker domain directly.

| File | Responsibility |
|---|---|
| `src/index.ts` | Router: dispatches on path and method, `404` for anything else |
| `src/code.ts` | `POST /code` and its CORS preflight: verifies the entitlement token, reuses or mints a code |
| `src/jwt.ts` | Ghost member JWT verification against the site JWKS, with a per-isolate JWKS cache |
| `src/commands.ts` | `POST /discord`: `/link <code>` and `/unlink` slash commands |
| `src/webhooks.ts` | `POST /webhook/*`: Ghost signature check, pending-code invalidation, role sync |
| `src/admin.ts` | Admin `/link` endpoints (Bearer auth) |
| `src/discord.ts` | Discord Ed25519 signature check; add/remove role REST calls |
| `src/utils.ts` | `json()`, `timingSafeEqual()`, `isValidEmail()`, `hexToBytes()`, `isPaid()` |
| `src/types.ts` | Shared types (`Env`, `PendingLink`, Ghost payloads) |

## Glossary

| Term | Meaning |
|---|---|
| **Mapping** | The bidirectional link between a Ghost email and a Discord user ID, stored as two KV keys. |
| **Entitlement token** | Short-lived (5 min) JWT that Ghost's `GET /members/api/entitlements` returns to a logged-in member. Carries `sub` (email), `scope: "members:entitlements:read"` and `paid`. |
| **Linking code** | 8-character, single-use code minted by `POST /code`, valid 10 minutes, redeemed with `/link <code>`. Carries the email and the `paid` flag of the token it was minted from. |
| **Pending code** | The member's current unredeemed linking code, tracked under `pending:<email>`. |

## Runtime

- Cloudflare Workers (V8 isolate, Web standard APIs, Web Crypto for every signature).
- State in a single Cloudflare KV namespace, `GHOST_DISCORD_MAPPING`; optional Workers rate-limit binding.
- TypeScript, no runtime dependencies (only dev dependencies: Wrangler, TypeScript, Vitest).
- No queues, Durable Objects, `waitUntil` or retries: every request completes its work synchronously.

## Pages

| Page | Contents |
|---|---|
| [How it works](flows.md) | Linking, role sync, unlinking and admin flows, step by step |
| [API reference](api.md) | Every route and slash command: auth, request, responses, reply strings, errors |
| [Data model](data-model.md) | KV keys and invariants, TypeScript types, Ghost payload conventions |
| [Security](security.md) | Authentication schemes, threat model, mitigations, residual risks |
| [Configuration](configuration.md) | Secrets, bindings, local development, npm scripts |
