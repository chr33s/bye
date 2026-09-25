#!/bin/sh
# End-to-end mirror smoke with Apple's `container` CLI (or CONTAINER_CLI=docker):
#   1. run the real SigMirror handler in workerd (Miniflare) on the container network
#   2. run the cvdupdate job image once: database.clamav.net → our mirror (R2)
#   3. run the scanner in SCANNER_SIGNATURES=mirror mode: freshclam syncs ONLY from our mirror
#   4. verify clean → clean, EICAR → infected, and that freshclam's source was the mirror
set -eu
CLI="${CONTAINER_CLI:-container}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${SIGMIRROR_PORT:-18091}"
SCAN_PORT="${SCANNER_SMOKE_PORT:-18092}"
HOST_IP="${CONTAINER_HOST_IP:-192.168.64.1}"
WRITE_TOKEN="$(openssl rand -hex 24)"
TMP="$(mktemp -d)"
R2_DIR="${SIGMIRROR_R2_DIR:-$TMP/r2}"
SERVER_PID=""
cleanup() {
  "$CLI" rm -f bye-sigmirror-job bye-scanner-mirror >/dev/null 2>&1 || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ "$CLI" = "container" ]; then container system status >/dev/null 2>&1 || container system start --enable-kernel-install; fi

echo "== 1. mirror Worker (workerd) on $HOST_IP:$PORT"
(cd "$ROOT" && WRITE_TOKEN="$WRITE_TOKEN" SIGMIRROR_PORT="$PORT" SIGMIRROR_R2_DIR="$R2_DIR" exec node --experimental-strip-types containers/sigmirror/test/smoke-server.ts) &
SERVER_PID=$!
i=0; until curl -fs -o /dev/null -w '' "http://127.0.0.1:$PORT/w/_manifest" -H "authorization: Bearer $WRITE_TOKEN"; do i=$((i+1)); [ $i -gt 60 ] && { echo "mirror did not start"; exit 1; }; sleep 1; done

echo "== 2. mirror job (cvdupdate → mirror)"
"$CLI" build -t bye-sigmirror:smoke "$ROOT/containers/sigmirror" >/dev/null
"$CLI" rm -f bye-sigmirror-job >/dev/null 2>&1 || true
"$CLI" run --name bye-sigmirror-job -m 2048M -e MIRROR_URL="http://$HOST_IP:$PORT" -e WRITE_TOKEN="$WRITE_TOKEN" bye-sigmirror:smoke
curl -fs "http://127.0.0.1:$PORT/w/_manifest" -H "authorization: Bearer $WRITE_TOKEN" > "$TMP/manifest.json"
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1])).files; const n=Object.keys(m); console.log("mirror files:", n.length, n.filter(x=>x.endsWith(".cvd")).join(" ")); for (const db of ["main.cvd","daily.cvd","bytecode.cvd"]) if(!m[db]) { console.error("missing " + db); process.exit(1) }' "$TMP/manifest.json"

echo "== 3. scanner in mirror mode"
"$CLI" build --build-arg SCANNER_SIGNATURES=mirror -t bye-scanner:mirror-smoke "$ROOT/containers/scanner" >/dev/null
"$CLI" rm -f bye-scanner-mirror >/dev/null 2>&1 || true
"$CLI" run -d --name bye-scanner-mirror --read-only --tmpfs /tmp -m 4096M -p "$SCAN_PORT:8080" \
  -e SIGNATURE_MIRROR_URL="http://$HOST_IP:$PORT" bye-scanner:mirror-smoke >/dev/null
i=0
until curl -fs -m 3 "http://127.0.0.1:$SCAN_PORT/health" | grep -q true; do
  i=$((i + 1)); [ "$i" -gt 100 ] && { echo "scanner did not become healthy"; "$CLI" logs bye-scanner-mirror || true; exit 1; }
  sleep 3
done
"$CLI" logs bye-scanner-mirror > "$TMP/scanner.log" 2>&1 || true
grep -E "downloaded|up-to-date|Testing database|database available" "$TMP/scanner.log" | head -8
if grep -q "database.clamav.net" "$TMP/scanner.log"; then echo "FAIL: scanner contacted database.clamav.net"; exit 1; fi
grep -q "$HOST_IP:$PORT" "$TMP/scanner.log" && echo "freshclam source: private mirror http://$HOST_IP:$PORT"

echo "== 4. verdicts"
printf 'Hello, this is a clean invoice.\n' > "$TMP/clean.txt"
printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > "$TMP/eicar.txt"
check() {
  out="$(curl -s -X POST --data-binary "@$TMP/$1" "http://127.0.0.1:$SCAN_PORT/scan")"
  echo "$1 -> $out"
  echo "$out" | grep -q "\"verdict\":\"$2\"" || { echo "FAIL: expected $2"; exit 1; }
}
check clean.txt clean
check eicar.txt infected
echo "mirror smoke: PASS"
