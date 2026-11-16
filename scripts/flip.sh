# Flip script created with help of AI
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
if [[ "$TARGET" != "blue" && "$TARGET" != "green" ]]; then
  echo "usage: $0 blue|green" >&2
  exit 2
fi

CONF=proxy/active/upstream.conf
PROXY_URL="${PROXY_URL:-http://localhost:8088}"

echo "Currently: $(cat "$CONF")"

echo "Checking app-$TARGET /healthz..."

if ! docker compose exec -T "app-$TARGET" wget -qO- http://127.0.0.1:3000/healthz >/dev/null; then
  echo "app-$TARGET is not healthy. Traffic NOT moved." >&2
  exit 1
fi

cp "$CONF" "$CONF.bak"
# "resolve": keep following the container if it is recreated with a new IP.
echo "server app-$TARGET:3000 resolve;" > "$CONF.tmp"
mv "$CONF.tmp" "$CONF"

if ! docker compose exec -T proxy nginx -t -q; then
  echo "nginx config test failed. Restoring previous upstream" >&2
  mv "$CONF.bak" "$CONF"
  exit 1
fi

docker compose exec -T proxy nginx -s reload
rm -f "$CONF.bak"

sleep 1
echo  "Now serving $(curl -s "$PROXY_URL/api/version")"