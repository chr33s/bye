#!/bin/sh
# Prepare signatures according to SCANNER_SIGNATURES, start clamd, wait for its socket, serve HTTP.
set -eu
MODE="${SCANNER_SIGNATURES:-mirror}"

case "$MODE" in
  baked)
    # Signatures are in the image; no runtime refresh and no egress.
    DB=/var/lib/clamav
    ;;
  mirror)
    : "${SIGNATURE_MIRROR_URL:?SIGNATURE_MIRROR_URL is required in mirror mode}"
    DB=/tmp/clamav
    mkdir -p "$DB"
    # PrivateMirror disables DNS version lookups and the official CDN; CVD/CDIFF digital signatures
    # are still verified by freshclam/clamd, so a tampered mirror is rejected.
    cat > /tmp/freshclam.conf <<CONF
DatabaseDirectory $DB
PrivateMirror $SIGNATURE_MIRROR_URL
ScriptedUpdates yes
Checks 12
ConnectTimeout 30
ReceiveTimeout 300
NotifyClamd /tmp/clamd.conf
CONF
    ;;
  *) echo "SCANNER_SIGNATURES must be baked or mirror" >&2; exit 1 ;;
esac

# clamd reads its database directory from config; the mirror mode uses ephemeral /tmp.
sed "s#^DatabaseDirectory .*#DatabaseDirectory $DB#" /etc/clamav/clamd.conf > /tmp/clamd.conf

if [ "$MODE" = "mirror" ]; then
  # First sync must succeed before clamd can load; retry a few times, then fail the container.
  i=0
  until freshclam --config-file=/tmp/freshclam.conf --stdout; do
    i=$((i + 1)); [ "$i" -ge 5 ] && { echo "initial signature sync from mirror failed" >&2; exit 1; }
    sleep $((i * 5))
  done
  freshclam --config-file=/tmp/freshclam.conf --daemon --checks=12 --stdout || echo "freshclam daemon failed; serving current signatures" >&2
fi

clamd --config-file=/tmp/clamd.conf
i=0
while [ ! -S /tmp/clamd.sock ] && [ "$i" -lt 120 ]; do i=$((i + 1)); sleep 1; done
exec node --experimental-strip-types /app/src/server.ts
