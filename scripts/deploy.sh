#!/usr/bin/env bash
# Blue-green deploy: build the current code into the IDLE color, migrate, wait until
# it's healthy, then flip traffic to it. The live color is never stopped or rebuilt,
# so rolling back is just: scripts/flip.sh <previous color>
#
# Usage: scripts/deploy.sh blue|green [version-label]
#   e.g. scripts/deploy.sh green v2
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
VERSION="${2:-}"
if [[ "$TARGET" != "blue" && "$TARGET" != "green" ]]; then
  echo "usage: $0 blue|green [version-label]" >&2
  exit 2
fi
PROXY_URL="${PROXY_URL:-http://localhost:8088}"

# 1. Who is live? Ask the proxy, not the config file: the file is what we asked
#    for, the response is what nginx is actually doing.
LIVE=$(curl -fsS "$PROXY_URL/api/version" | sed -E 's/.*"color":"([a-z]+)".*/\1/') || {
  echo "Proxy at $PROXY_URL is not answering. Is the stack up?" >&2
  exit 1
}
if [[ "$LIVE" == "$TARGET" ]]; then
  echo "$TARGET is serving traffic right now. Deploy to the idle color instead." >&2
  exit 1
fi
echo "==> live: $LIVE   deploying to: $TARGET"

# 2. Version label for this color. Exported for this run only (shell variables win
#    over .env in docker compose); it's written to .env after a successful flip.
VAR="$(echo "$TARGET" | tr '[:lower:]' '[:upper:]')_VERSION"
if [[ -n "$VERSION" ]]; then
  export "$VAR=$VERSION"
  echo "==> $VAR=$VERSION"
fi

# 3. Migrations run BEFORE the new code starts, while $LIVE keeps serving on the
#    same database. That's why they must be expand-only (add, never remove/rename).
echo "==> migrating"
docker compose run --rm --build migrate

# 4. Build and (re)start only the idle color. --no-deps leaves db and $LIVE alone;
#    --wait blocks until its healthcheck passes, and fails the deploy if it never does.
echo "==> building and starting app-$TARGET"
docker compose up -d --build --no-deps --wait "app-$TARGET"

# 5. Switch traffic (flip.sh runs its own health gate and verifies the result).
./scripts/flip.sh "$TARGET"

# 6. Remember the label, so a later plain `docker compose up -d` keeps it.
if [[ -n "$VERSION" ]]; then
  touch .env
  grep -v "^$VAR=" .env > .env.tmp || true
  echo "$VAR=$VERSION" >> .env.tmp
  mv .env.tmp .env
fi

echo "==> deployed. Roll back with: scripts/flip.sh $LIVE"