# Security Policy

This Worker handles Discord bot credentials, Ghost webhook secrets and member emails, so security reports are taken seriously.

## Supported versions

Only the latest release on `main` receives security fixes.

| Version | Supported |
|---|---|
| 2.x (latest) | ✅ |
| < 2.0 | ❌ |

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/ltoinel/ghost-discord-worker/security) of the repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected endpoint or file, the steps to reproduce, and the impact you expect.

A proof of concept helps, but never test against a site you do not own or are not authorized to test.

## What to expect

This is a personal open-source project maintained on a best-effort basis. The goals are:

- an acknowledgement within **7 days**;
- an assessment and a fix plan within **30 days** for confirmed issues;
- a GitHub Security Advisory crediting you once the fix is released, unless you prefer to stay anonymous.

Please keep the details confidential until a fix is published.

## Scope

In scope:

- the Worker code in `src/` (authentication of webhooks, Discord interactions, member tokens and the admin API; KV data handling; role assignment);
- `deploy.sh` and the GitHub Actions workflows;
- the "Get my Discord code" widget published in the documentation.

Out of scope:

- vulnerabilities in Ghost, Discord or Cloudflare themselves (report them to those vendors);
- issues that require a leaked secret (`WEBHOOK_SECRET`, `ADMIN_SECRET`, bot token, Ghost signing key) or a compromised Cloudflare account;
- misconfiguration of a particular deployment, such as a weak `ADMIN_SECRET`;
- denial of service through volumetric traffic.

## Security model

The threat model, the authentication schemes and the known residual risks are documented in the
[security specification](https://ltoinel.github.io/ghost-discord-worker/spec/security/).

Every push is checked by CodeQL, `npm audit`, dependency review, gitleaks secret scanning and ShellCheck (see [Development](https://ltoinel.github.io/ghost-discord-worker/development/#continuous-integration)).

## Hardening your deployment

- Use long random values for `WEBHOOK_SECRET` and `ADMIN_SECRET`, for example `openssl rand -hex 32`.
- Keep the `CODE_RATE_LIMITER` binding from `wrangler.toml.sample` enabled.
- Give the bot the **Manage Roles** permission only.
- Rotate the bot token and secrets if you suspect a leak: `npx wrangler secret put <NAME>`.
