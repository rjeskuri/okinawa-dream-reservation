#!/bin/sh
# Builds the site and runs it on this machine with the demo catalog: seed/demo.sql, seed/photos and, file by file,
# seed/photos-local. Only the local D1 and R2, so it needs no Cloudflare account, and it can run again over its own data.
# docs/local-dev.md says how to use it.
set -eu
cd "$(dirname "$0")/.."
export ASTRO_TELEMETRY_DISABLED=1
export WRANGLER_SEND_METRICS=false

BUCKET=okinawa-dream-media
# The one port the demo serves. Every link the Worker builds starts from SITE_URL, which wrangler.jsonc points at astro
# dev on 4321, so wrangler dev gets both URLs for this port through --var, which wins over wrangler.jsonc and .dev.vars.
PORT=8787
ORIGIN="http://localhost:$PORT"

[ -d node_modules ] || npm ci

# Before the build, which copies .dev.vars next to the Worker that wrangler dev runs. An existing file may hold real values.
[ -f .dev.vars ] || cp .dev.vars.example .dev.vars

npm run build
npx wrangler d1 migrations apply DB --local </dev/null
npx wrangler d1 execute DB --local --file seed/demo.sql

# The name, r2_key and content_type of each photos row. wrangler gets /dev/null so that it cannot read the rest of this list.
sed -n "s/^ *('\([^']*\)', '[^']*', '[^']*', '\(photos\/[^']*\)', '\([^']*\)'.*/\1 \2 \3/p" seed/demo.sql |
  while read -r name key type; do
    file="seed/photos/$name"
    if [ -f "seed/photos-local/$name" ]; then
      file="seed/photos-local/$name"
    fi
    npx wrangler r2 object put "$BUCKET/$key" --file "$file" --content-type "$type" --local </dev/null
  done

# --test-scheduled opens /cdn-cgi/handler/scheduled, which the cron curl in docs/local-dev.md calls.
exec npx wrangler dev --test-scheduled --port "$PORT" \
  --var "SITE_URL:$ORIGIN" "SQUARE_WEBHOOK_URL:$ORIGIN/api/webhooks/square"
