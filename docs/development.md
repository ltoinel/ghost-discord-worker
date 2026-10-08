# Development

## Local server

Create a `.dev.vars` file at the project root (it is git-ignored):

```ini title=".dev.vars"
WEBHOOK_SECRET=test
ADMIN_SECRET=admin-secret
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_GUILD_ID=your-guild-id
DISCORD_PUBLIC_KEY=your-public-key
DISCORD_ROLE_MEMBER=your-member-role-id
DISCORD_ROLE_PREMIUM=your-premium-role-id
GHOST_URL=https://your-ghost-site.com
```

```sh
npm run dev
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server (`wrangler dev`) |
| `npm run build` | Type-check (`tsc --noEmit`) |
| `npm test` | Unit tests (Vitest, plain Node ≥ 20) |
| `npm run test:coverage` | Tests + coverage report; **fails under 90%** on lines, statements, branches or functions |
| `npm run test:watch` | Vitest watch mode |
| `npm run deploy` | Runs [`./deploy.sh`](getting-started.md#1-deploy-the-worker) |
| `npm run types` | Generate Worker types (`wrangler types`) |

## Continuous integration

Every push and pull request runs:

| Workflow | Checks |
|---|---|
| **CI** | Type-check and tests with the coverage gate on Node 20, 22 and 24 · `npm audit` (fails on moderate or worse, dev dependencies included) · `npm audit signatures` · ShellCheck on `deploy.sh` · gitleaks secret scan over the full history · dependency review on pull requests |
| **CodeQL** | `security-extended` queries for TypeScript and the GitHub Actions workflows, also weekly |
| **Docs** | Builds this site with `mkdocs build --strict` and publishes it to GitHub Pages from `main` |

Dependabot opens weekly updates for npm and GitHub Actions.

Documentation placeholders that look like secrets (example Discord IDs, the local `admin-secret`) are allowlisted in `.gitleaks.toml`.

## Documentation

This site is built with [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/):

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-docs.txt
mkdocs serve
```
