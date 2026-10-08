# 01 — Overview

## Purpose

The Ghost → Discord Worker is a stateless Cloudflare Worker that bridges two systems:

1. **Ghost CMS** — a publishing platform with paid/free membership tiers.
2. **Discord** — a community chat platform with role-based access control.

When a member's state changes in Ghost (signup, upgrade, downgrade, deletion), the worker translates that event into a corresponding Discord role change (assignment or removal) for the linked Discord account.

## Goals

- **Automatic role sync.** Ghost member status determines Discord roles without manual intervention.
- **Self-service linking.** End users link their own Ghost email to their Discord account via slash commands.
- **Stateless, serverless.** All state lives in Cloudflare KV; no servers to operate.
- **Defense in depth.** Every entry point is authenticated and signature-verified.

## Non-Goals

- The worker does **not** create Discord accounts, Ghost members, or roles.
- The worker does **not** sync member metadata other than membership tier (no profile, avatar, name sync).
- The worker does **not** poll Ghost or Discord; it reacts only to incoming webhooks and interactions.
- The worker does **not** implement administrative UIs; the `/link` admin endpoints are CLI/script-driven.

## Roles Managed

The worker manages exactly **two** Discord roles, both configured by ID via secrets:

| Role | Secret | Granted to |
|------|--------|------------|
| Member | `DISCORD_ROLE_MEMBER` | Any active Ghost member (free, paid, or comped) |
| Premium Member | `DISCORD_ROLE_PREMIUM` | Members with `status = "paid"` or `status = "comped"` |

Roles outside these two are not touched.

## Glossary

| Term | Meaning |
|------|---------|
| **Member** | A Ghost CMS subscriber, regardless of tier. |
| **Paid member** | A Ghost member with `status = "paid"` (active paying subscriber). |
| **Comped member** | A Ghost member with `status = "comped"` (gifted premium access). |
| **Free member** | A Ghost member with `status = "free"` (signed up, no payment). |
| **Mapping** | A bidirectional association between a Ghost email and a Discord user ID, stored in KV. |
| **Linking** | The act of creating a mapping, either by user (`/link <code>` slash command) or admin (`POST /link`). |
| **Linking code** | A short-lived (10 min), single-use, 8-character code minted by `POST /code` after Ghost entitlement JWT verification. Carries the member's email and `paid` flag; used by the Discord user to prove email ownership when redeeming via `/link`. |
| **Entitlement token** | A short-lived (5 min) RS512 JWT returned by Ghost's `GET /members/api/entitlements` for the logged-in member. Contains `sub` (email), `scope: "members:entitlements:read"`, `paid` and `active_tier_ids`. |
| **Interaction** | A Discord slash command invocation, delivered as a signed POST to `/discord`. |
| **Webhook** | A Ghost-originated POST notifying the worker of a member event. |

## Runtime

- **Platform:** Cloudflare Workers (V8 isolate, Web standard APIs).
- **Language:** TypeScript (compiled by Wrangler/esbuild).
- **State store:** Cloudflare KV (`GHOST_DISCORD_MAPPING` namespace).
- **Compatibility date:** `2024-12-02` (see `wrangler.toml`).
