#!/usr/bin/env bash
#
# Deploys the Ghost → Discord Worker to Cloudflare.
#
#   ./deploy.sh                          type-check, test (≥ 90% coverage), deploy
#   ./deploy.sh --secrets .env.prod      also upload secrets from a KEY=VALUE file
#   ./deploy.sh --register-commands      also register /link and /unlink with Discord
#   ./deploy.sh --dry-run                build the bundle without publishing it
#
# First run: if wrangler.toml is missing, it is created from wrangler.toml.sample
# and the GHOST_DISCORD_MAPPING KV namespace is created automatically.
#
# Authentication: `npx wrangler login`, or export CLOUDFLARE_API_TOKEN (CI).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

SECRETS_FILE=""
REGISTER_COMMANDS=false
SKIP_TESTS=false
DRY_RUN=false

# Keys read from the secrets file that configure this script, not the Worker.
LOCAL_ONLY_KEYS="DISCORD_APPLICATION_ID"

if [[ -t 1 ]]; then
	BOLD=$'\e[1m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' RESET=$'\e[0m'
else
	BOLD="" GREEN="" YELLOW="" RED="" RESET=""
fi
step() { printf '\n%s▸ %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { printf '%s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn() { printf '%s! %s%s\n' "$YELLOW" "$1" "$RESET"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

usage() {
	sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
	cat <<'EOF'

Options:
  --secrets FILE        Upload every KEY=VALUE in FILE as a Worker secret
                        (DISCORD_APPLICATION_ID is used locally, not uploaded)
  --register-commands   Register the slash commands on DISCORD_GUILD_ID
                        (needs DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID
                        from --secrets FILE or the environment)
  --skip-tests          Skip type-check and tests
  --dry-run             Run `wrangler deploy --dry-run` (nothing is published)
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--secrets) [[ $# -ge 2 ]] || die "--secrets needs a file"; SECRETS_FILE="$2"; shift 2 ;;
		--register-commands) REGISTER_COMMANDS=true; shift ;;
		--skip-tests) SKIP_TESTS=true; shift ;;
		--dry-run) DRY_RUN=true; shift ;;
		-h|--help) usage; exit 0 ;;
		*) usage; die "Unknown option: $1" ;;
	esac
done

wrangler() { npx --no-install wrangler "$@"; }

# ── Prerequisites ────────────────────────────────────────────────────────────
step "Checking prerequisites"
command -v node >/dev/null || die "Node.js is required (≥ 20)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 )) || die "Node.js ≥ 20 is required (found $(node -v))"
ok "Node $(node -v)"

if [[ -n "$SECRETS_FILE" && ! -f "$SECRETS_FILE" ]]; then
	die "Secrets file not found: $SECRETS_FILE"
fi

if [[ ! -d node_modules ]] || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
	step "Installing dependencies"
	npm ci
fi

if ! $DRY_RUN && [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] && wrangler whoami 2>&1 | grep -qi "not authenticated"; then
	die "Not logged in to Cloudflare. Run \`npx wrangler login\` or export CLOUDFLARE_API_TOKEN."
fi
ok "Cloudflare authentication"

# ── wrangler.toml / KV namespace ─────────────────────────────────────────────
if [[ ! -f wrangler.toml ]]; then
	step "Creating wrangler.toml from wrangler.toml.sample"
	cp wrangler.toml.sample wrangler.toml
fi

if grep -qE '^id = "x+"' wrangler.toml; then
	if $DRY_RUN; then
		warn "KV namespace id is still a placeholder (not created in --dry-run)"
	else
		step "Creating KV namespace GHOST_DISCORD_MAPPING"
		KV_OUTPUT=$(wrangler kv namespace create GHOST_DISCORD_MAPPING 2>&1) || { echo "$KV_OUTPUT"; die "KV namespace creation failed"; }
		KV_ID=$(grep -oE '[0-9a-f]{32}' <<<"$KV_OUTPUT" | head -1)
		[[ -n "$KV_ID" ]] || { echo "$KV_OUTPUT"; die "Could not read the KV namespace id"; }
		sed -i.bak -E "s/^id = \"x+\"/id = \"$KV_ID\"/" wrangler.toml && rm -f wrangler.toml.bak
		ok "KV namespace $KV_ID written to wrangler.toml"
	fi
fi

# ── Quality gate ─────────────────────────────────────────────────────────────
if $SKIP_TESTS; then
	warn "Skipping type-check and tests"
else
	step "Type-checking"
	npm run --silent build
	ok "Types OK"

	step "Running tests (coverage ≥ 90%)"
	npm run --silent test:coverage
	ok "Tests passed"
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
if $DRY_RUN; then
	step "Building bundle (dry run)"
	wrangler deploy --dry-run --outdir dist
	ok "Dry run complete — nothing was published"
	exit 0
fi

step "Deploying Worker"
wrangler deploy
ok "Worker deployed"

# ── Secrets ──────────────────────────────────────────────────────────────────
read_var() {
	# Reads KEY from the environment first, then from the secrets file.
	local key="$1" value="${!1:-}"
	if [[ -z "$value" && -n "$SECRETS_FILE" ]]; then
		value=$(grep -E "^${key}=" "$SECRETS_FILE" | tail -1 | cut -d= -f2- | sed -E 's/^["'\'']|["'\'']$//g')
	fi
	printf '%s' "$value"
}

if [[ -n "$SECRETS_FILE" ]]; then
	step "Uploading secrets from $SECRETS_FILE"
	FILTERED=$(mktemp)
	trap 'rm -f "$FILTERED"' EXIT
	grep -E '^[A-Z_][A-Z0-9_]*=' "$SECRETS_FILE" | grep -vE "^(${LOCAL_ONLY_KEYS// /|})=" > "$FILTERED" || true
	[[ -s "$FILTERED" ]] || die "No KEY=VALUE lines found in $SECRETS_FILE"
	wrangler secret bulk "$FILTERED"
	ok "$(wc -l < "$FILTERED" | tr -d ' ') secrets uploaded"
fi

# ── Discord slash commands ───────────────────────────────────────────────────
if $REGISTER_COMMANDS; then
	step "Registering Discord slash commands"
	APP_ID=$(read_var DISCORD_APPLICATION_ID)
	BOT_TOKEN=$(read_var DISCORD_BOT_TOKEN)
	GUILD_ID=$(read_var DISCORD_GUILD_ID)
	[[ -n "$APP_ID" && -n "$BOT_TOKEN" && -n "$GUILD_ID" ]] \
		|| die "DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are required"

	HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
		"https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands" \
		-H "Authorization: Bot ${BOT_TOKEN}" \
		-H "Content-Type: application/json" \
		--data @- <<'JSON'
[
  {
    "name": "link",
    "description": "Redeem your Ghost-issued linking code",
    "options": [
      { "name": "code", "description": "The code displayed on your Ghost site", "type": 3, "required": true }
    ]
  },
  { "name": "unlink", "description": "Unlink your Ghost email from your Discord account" }
]
JSON
	)
	[[ "$HTTP_CODE" == 2* ]] || die "Discord API returned HTTP $HTTP_CODE"
	ok "/link and /unlink registered on guild $GUILD_ID"
fi

printf '\n%sDone.%s Set the Discord Interactions Endpoint URL to https://<worker>.workers.dev/discord if not already done.\n' "$GREEN" "$RESET"
