# Isolated antivirus scanner (spec §3.1, §10). Stateless: request bodies are streamed to clamd and
# never written to disk; signatures live in the image (baked) or on ephemeral disk (mirror).
#
# SCANNER_SIGNATURES selects where signatures come from:
#   mirror (default) — freshclam refreshes from our private mirror (SIGNATURE_MIRROR_URL, served by
#                      workers/sigmirror through an intercepted binding); the container needs no
#                      internet egress at runtime.
#   baked            — signatures are downloaded at build time (CI, daily) and never refreshed at
#                      runtime; no runtime egress at all, freshness = image rebuild cadence.
# Base image pinned by multi-arch index digest (resolved 2026-11-03 from registry-1.docker.io);
# Dependabot (docker ecosystem) proposes digest bumps. Keep the tag for readability.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

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
