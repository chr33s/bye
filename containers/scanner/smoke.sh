#!/bin/sh
# Build and run the scanner image with Apple's `container` CLI (or Docker via CONTAINER_CLI=docker),
# then verify POST /scan against real clamd: clean text, EICAR, zipped EICAR, oversize refusal.
# Runs with a read-only root filesystem, as the non-root clamav user.
set -eu
CLI="${CONTAINER_CLI:-container}"
NAME="bye-scanner-smoke"
PORT="${SCANNER_SMOKE_PORT:-18090}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
cleanup() { "$CLI" rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

if [ "$CLI" = "container" ]; then container system status >/dev/null 2>&1 || container system start --enable-kernel-install; fi
"$CLI" build --build-arg SCANNER_SIGNATURES=baked -t bye-scanner:smoke "$DIR"
"$CLI" rm -f "$NAME" >/dev/null 2>&1 || true
"$CLI" run -d --name "$NAME" --read-only --tmpfs /tmp -m 4096M -p "$PORT:8080" bye-scanner:smoke >/dev/null

i=0
until curl -fs -m 3 "http://127.0.0.1:$PORT/health" | grep -q true; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "scanner did not become healthy"; "$CLI" logs "$NAME" || true; exit 1; }
  sleep 3
done

printf 'Hello, this is a clean invoice.\n' > "$TMP/clean.txt"
printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > "$TMP/eicar.txt"
(cd "$TMP" && zip -q eicar.zip eicar.txt)

check() {
  out="$(curl -s -X POST --data-binary "@$TMP/$1" "http://127.0.0.1:$PORT/scan")"
  echo "$1 -> $out"
  echo "$out" | grep -q "\"verdict\":\"$2\"" || { echo "FAIL: expected $2"; exit 1; }
}
check clean.txt clean
check eicar.txt infected
check eicar.zip infected
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-length: 209715200' --data-binary "@$TMP/clean.txt" --max-time 5 "http://127.0.0.1:$PORT/scan" || true)"
echo "oversize -> HTTP $code"; [ "$code" = "413" ] || { echo "FAIL: expected 413"; exit 1; }
"$CLI" exec "$NAME" id | grep -q 'uid=100(clamav)' && echo "runs as clamav (non-root)"
echo "scanner smoke: PASS"
