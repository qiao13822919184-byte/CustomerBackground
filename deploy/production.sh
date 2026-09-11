#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

compose() {
  docker compose -f compose.yaml -f compose.production.yaml "$@"
}

# Quiet validation checks required variables without printing resolved API keys.
compose config --quiet
compose up -d --build --wait --wait-timeout 180
# A changed bind-mounted Caddyfile alone does not recreate the running container.
compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
compose exec -T app node deploy/verify-https.mjs
