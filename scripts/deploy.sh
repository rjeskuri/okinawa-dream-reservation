#!/bin/sh
# Deploys the commit checked out here. The Deploy workflow runs this; until the Cloudflare credentials exist (task #48)
# it skips and passes, so main stays green. An unconfigured GitHub secret arrives empty, so empty counts as unset.
# Each step on its own line, so `set -e` stops at the first failure with that step's exit code. Never `set -x`: a trace
# would print the credentials.
set -eu

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "deploy skipped: Cloudflare credentials not set"
  exit 0
fi

cd "$(dirname "$0")/.."

npm ci
npm run build
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
