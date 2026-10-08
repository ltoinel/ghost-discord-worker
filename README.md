<p align="center">
  <a href="https://ltoinel.github.io/ghost-discord-worker/">
    <img src="docs/social.png" alt="Ghost → Discord Role Sync: turn your Ghost members into a Discord community. Premium roles follow every subscription, automatically." width="100%">
  </a>
</p>

[![CI](https://github.com/ltoinel/ghost-discord-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/ltoinel/ghost-discord-worker/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ltoinel/ghost-discord-worker/actions/workflows/codeql.yml/badge.svg)](https://github.com/ltoinel/ghost-discord-worker/actions/workflows/codeql.yml)
[![Docs](https://github.com/ltoinel/ghost-discord-worker/actions/workflows/docs.yml/badge.svg)](https://ltoinel.github.io/ghost-discord-worker/)
[![Coverage ≥ 90%](https://img.shields.io/badge/coverage-%E2%89%A5%2090%25-brightgreen)](https://github.com/ltoinel/ghost-discord-worker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/ltoinel/ghost-discord-worker)](LICENSE)
![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)

A Cloudflare Worker that keeps Discord roles in sync with Ghost CMS memberships. Members link their Discord account in one click, and their roles follow every subscription change.

<p align="center">
  <img src="docs/architecture.svg" alt="Architecture diagram: a Cloudflare Worker bridges Ghost CMS webhooks and Discord role mutations. Members prove email ownership with a Ghost-signed entitlement JWT, exchanged for a single-use linking code redeemed via /link in Discord." width="900">
</p>

## 📖 Documentation

**The full guide lives on GitHub Pages: [ltoinel.github.io/ghost-discord-worker](https://ltoinel.github.io/ghost-discord-worker/)**

- [Installation guide](https://ltoinel.github.io/ghost-discord-worker/setup/): 6 steps, from the Discord bot to the linking page on your Ghost site
- [Operations](https://ltoinel.github.io/ghost-discord-worker/operations/): logs, manual linking, upgrading, secret rotation
- [Development](https://ltoinel.github.io/ghost-discord-worker/development/): local server, tests, CI and security checks
- [Specification](https://ltoinel.github.io/ghost-discord-worker/spec/): architecture, API, authentication, security model

## How it works

1. A signed-in member clicks **Get my Discord code** on your Ghost site. The page sends Ghost's signed entitlement token to the Worker, which returns a single-use code.
2. The member types `/link <code>` in Discord and gets **Membre**, plus **Membre Premium** if they are a paid or comped member.
3. Ghost webhooks keep the roles in sync when members upgrade, downgrade or leave.

## Quick start

```sh
npm ci
npx wrangler login
./deploy.sh --secrets .env.prod --register-commands
```

Then point Discord to the Worker, add the Ghost webhooks and publish the linking page: the [installation guide](https://ltoinel.github.io/ghost-discord-worker/setup/) walks through each step.

## Credits

The single-use code flow and the entitlements token come from the discussion on the Ghost forum: [Discord ↔ Ghost role sync](https://forum.ghost.org/t/discord-ghost-role-sync/61933/8).

## Contributing & security

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, follow [SECURITY.md](SECURITY.md) and never open a public issue.

## License

[MIT](LICENSE) © Ludovic Toinel
