# Contributing

Thanks for your interest in Ghost → Discord Role Sync! Bug reports, documentation fixes and pull requests are welcome.

> **Found a security issue?** Do not open a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Before you start

- **Bugs**: open an issue with your Ghost version, what you did, what you expected and what happened. Output from `npx wrangler tail` helps; remove emails, tokens and secrets first.
- **Features**: open an issue to discuss the idea before writing code, so effort is not wasted on something out of scope.

## Development setup

Requirements: Node.js **20 or newer** and Git.

```sh
git clone https://github.com/ltoinel/ghost-discord-worker.git
cd ghost-discord-worker
npm ci
```

To run the Worker locally, create a `.dev.vars` file (it is git-ignored) as described in the [Development guide](https://ltoinel.github.io/ghost-discord-worker/development/), then:

```sh
npm run dev
```

## Checks to run before opening a pull request

CI runs the same checks and blocks the merge if one fails.

```sh
npm run build          # type-check (tsc --noEmit)
npm run test:coverage  # unit tests; fails under 90% coverage
npm audit              # no moderate or worse vulnerability
```

If you changed `deploy.sh`, also run `shellcheck deploy.sh`.

If you changed the documentation, preview it with `mkdocs serve` and make sure `mkdocs build --strict` passes:

```sh
pip install -r requirements-docs.txt
mkdocs serve
```

## Guidelines

- **No runtime dependencies.** The Worker relies only on Web standard APIs (Web Crypto, `fetch`) and Cloudflare bindings. Dev dependencies are fine.
- **Test every change.** Add or update tests under `tests/` for each behaviour you change, including the failure paths. Tests mock `fetch` and KV; they never call Discord, Ghost or Cloudflare.
- **Keep security checks strict.** Never weaken signature, token or secret validation. Compare secrets in constant time (`timingSafeEqual`), and fail closed when a check cannot run.
- **Never log secrets or tokens.** Never show one member's data (email, Discord ID) to another user.
- **Match the existing style**: tabs, TypeScript `strict` mode, a short JSDoc comment on each exported function or handler.
- **Keep the docs in sync.** The specification lives in `docs/spec/`. Update it when you change an endpoint, a KV key, a reply message or a security property.
- **Use placeholders in examples.** For instance use `987654321098765432` for Discord IDs, never real tokens or IDs. gitleaks scans every commit.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request focused on one change.
3. Describe what changed and why, and link the related issue.
4. Make sure the CI is green.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
