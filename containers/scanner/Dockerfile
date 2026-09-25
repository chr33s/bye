# Isolated antivirus scanner (spec §3.1, §10). Stateless: request bodies are streamed to clamd and
# never written to disk; signatures live in the image (baked) or on ephemeral disk (mirror).
#
# SCANNER_SIGNATURES selects where signatures come from:
#   mirror (default) — freshclam refreshes from our private mirror (SIGNATURE_MIRROR_URL, served by
#                      workers/sigmirror through an intercepted binding); the container needs no
#                      internet egress at runtime.
#   baked            — signatures are downloaded at build time (CI, daily) and never refreshed at
#                      runtime; no runtime egress at all, freshness = image rebuild cadence.
# Base image pinned by multi-arch index digest (resolved 2026-09-26 from registry-1.docker.io);
# Dependabot (docker ecosystem) proposes digest bumps. Keep the tag for readability.
FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

ARG DEBIAN_FRONTEND=noninteractive
ARG SCANNER_SIGNATURES=mirror
RUN apt-get update \
 && apt-get install -y --no-install-recommends clamav-daemon clamav-freshclam ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/run/clamav /var/lib/clamav \
 && chown -R clamav:clamav /var/run/clamav /var/lib/clamav

COPY config/clamd.conf config/freshclam.conf /etc/clamav/
RUN case "$SCANNER_SIGNATURES" in \
      baked) freshclam --config-file=/etc/clamav/freshclam.conf --stdout ;; \
      mirror) echo "signatures will be fetched from the private mirror at startup" ;; \
      *) echo "SCANNER_SIGNATURES must be baked or mirror" >&2; exit 1 ;; \
    esac

WORKDIR /app
COPY src ./src
COPY entrypoint.sh /app/entrypoint.sh

ENV NODE_ENV=production PORT=8080 CLAMD_SOCKET=/tmp/clamd.sock SCAN_TIMEOUT_MS=60000 SCAN_MAX_BYTES=104857600 \
    SCANNER_SIGNATURES=${SCANNER_SIGNATURES}
USER clamav
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
