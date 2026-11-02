#!/bin/sh
# The whole suite plus lint for okinawa-dream-reservation: CLAUDE_VERIFY_CMD, the stop hook and CI run this.
# Each check on its own line, so `set -e` stops at the first failure.
set -eu
cd "$(dirname "$0")/.."
export ASTRO_TELEMETRY_DISABLED=1

npm run lint
npm test
npm run build
npm run test:e2e

echo VERIFY OK
