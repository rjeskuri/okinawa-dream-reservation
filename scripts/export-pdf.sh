#!/bin/sh
# Prints the mock's pages to PDF through headless Chrome, in English and Japanese, into mock-pdfs/, for sending to the
# customer. Needs the demo site running (scripts/demo.sh) and Chrome. docs/local-dev.md says how to use it.
#
# EXPORT_BASE_URL is the site to print (default http://localhost:8787), CHROME the browser binary.
set -eu
cd "$(dirname "$0")/.."

BASE=${EXPORT_BASE_URL:-http://localhost:8787}
BASE=${BASE%/}
CHROME=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
OUT=mock-pdfs
# Longest a single page may take in Chrome before it is killed, in seconds.
PAGE_TIMEOUT=90

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at $CHROME. Install it or set CHROME to the browser binary." >&2
  exit 1
fi
if ! curl -fsS --max-time 5 "$BASE/api/health" 2>/dev/null | grep -q '"ok":true'; then
  echo "The site is not running at $BASE. Start it with scripts/demo.sh, or set EXPORT_BASE_URL if it runs elsewhere." >&2
  exit 1
fi

mkdir -p "$OUT"
WORK=$(mktemp -d)
# Chrome gets its own profile, so that it never collides with the Chrome that is open on this machine.
trap 'rm -rf "$WORK"' EXIT INT TERM

# A date two weeks out, so that the search is never in the past. The demo's closed dates are at the turn of the year.
SEARCH="date=$(date -v+14d +%F)&time=09:00&package=bike-same-day"
MODEL=honda-pcx125
# #57's rates page. The group, class and duration filter names come from its outline: check them when it lands.
RATE_CLASS=r-125cc

FAILED=""
SKIPPED=""
DONE=0

# print_page NAME LOCALE PATH [optional]
# Prints BASE/LOCALE/PATH to OUT/LOCALE-NAME.pdf. A page marked optional that answers 404 is skipped, not failed.
print_page() {
  name=$1 locale=$2 path=$3 optional=${4:-}
  label="$locale-$name"
  url="$BASE/$locale$path"

  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$url") || status=000
  if [ "$status" = 404 ] && [ "$optional" = optional ]; then
    echo "warning: $label skipped, $url answers 404" >&2
    SKIPPED="$SKIPPED $label"
    return 0
  fi
  if [ "$status" != 200 ]; then
    echo "error: $label failed, $url answers $status" >&2
    FAILED="$FAILED $label"
    return 0
  fi

  tmp="$WORK/$label.pdf"
  rm -f "$tmp"
  # --virtual-time-budget lets images and scripts settle before the page is printed. The watchdog kills a Chrome that hangs.
  "$CHROME" --headless --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$WORK/profile" --no-pdf-header-footer --virtual-time-budget=10000 \
    --print-to-pdf="$tmp" "$url" >/dev/null 2>&1 &
  chrome_pid=$!
  (
    waited=0
    while [ "$waited" -lt "$PAGE_TIMEOUT" ] && kill -0 "$chrome_pid" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
    if [ "$waited" -ge "$PAGE_TIMEOUT" ]; then
      kill "$chrome_pid" 2>/dev/null || true
    fi
  ) &
  rc=0
  wait "$chrome_pid" || rc=$?

  if [ "$rc" != 0 ] || [ ! -s "$tmp" ] || [ "$(head -c 4 "$tmp")" != "%PDF" ]; then
    echo "error: $label failed, Chrome did not write a PDF for $url (exit $rc)" >&2
    FAILED="$FAILED $label"
    return 0
  fi
  mv "$tmp" "$OUT/$label.pdf"
  DONE=$((DONE + 1))
  echo "wrote $OUT/$label.pdf"
}

for locale in en ja; do
  print_page home "$locale" ""
  print_page rentals-search "$locale" "/rentals?$SEARCH"
  print_page model "$locale" "/rentals/$MODEL"
  print_page rates "$locale" "/rates" optional
  print_page rates-class "$locale" "/rates?class=$RATE_CLASS" optional
  print_page faq "$locale" "/faq"
  print_page policies "$locale" "/policies"
  print_page access "$locale" "/access"
  # Checkout joins here once it renders from a seeded hold (#29).
done

echo
echo "$DONE PDFs in $OUT/"
if [ -n "$SKIPPED" ]; then
  echo "skipped (page not built yet):$SKIPPED"
fi
if [ -n "$FAILED" ]; then
  echo "failed:$FAILED" >&2
  exit 1
fi
