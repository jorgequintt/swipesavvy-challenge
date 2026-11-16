#!/usr/bin/env bash
# Point the proxy at blue or green, gracefully. Created with help of AI.
# Usage: scripts/flip.sh blue|green
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
if [[ "$TARGET" != "blue" && "$TARGET" != "green" ]]; then
  echo "usage: $0 blue|green" >&2
  exit 2
fi

CONF=proxy/active/upstream.conf
PROXY_URL="${PROXY_URL:-http://localhost:8088}"

# What nginx is actually serving (the file only says what was last requested).
echo "Currently serving: $(curl -fsS "$PROXY_URL/api/version" || echo 'unknown (proxy not answering)')"

# 1. Health gate: never send traffic to a stack that isn't ready.
echo "Checking app-$TARGET /healthz..."
if ! docker compose exec -T "app-$TARGET" wget -qO- http://127.0.0.1:3000/healthz >/dev/null; then
  echo "app-$TARGET is not healthy. Traffic NOT moved." >&2
  exit 1
fi

# 2. Swap the upstream file (write a temp file, then rename over the old one).
cp "$CONF" "$CONF.bak"
# "resolve": keep following the container if it is recreated with a new IP.
echo "server app-$TARGET:3000 resolve;" > "$CONF.tmp"
mv "$CONF.tmp" "$CONF"

# 3. Validate the config before applying it; roll the file back if it's bad.
if ! docker compose exec -T proxy nginx -t -q; then
  echo "nginx config test failed. Restoring previous upstream." >&2
  mv "$CONF.bak" "$CONF"
  exit 1
fi

# 4. Graceful reload: new workers take new requests, old workers finish theirs.
docker compose exec -T proxy nginx -s reload
rm -f "$CONF.bak"

# 5. Verify: the reload is asynchronous, so poll until the proxy answers as TARGET.
for _ in $(seq 1 20); do
  NOW=$(curl -fsS "$PROXY_URL/api/version" || true)
  if [[ "$NOW" == *"\"color\":\"$TARGET\""* ]]; then
    echo "Now serving: $NOW"
    exit 0
  fi
  sleep 0.25
done
echo "Proxy still not serving $TARGET after 5s (last answer: ${NOW:-none})" >&2
exit 1