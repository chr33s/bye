# Signature mirror job (spec §3.1, §10). Runs one cvdupdate pass and exits. The only container with
# internet egress in the scanning path, and it only needs database.clamav.net (plus DNS for the
# version TXT record); it holds no customer data.
# Base image pinned by multi-arch index digest (resolved 2026-09-26 from registry-1.docker.io);
# Dependabot (docker ecosystem) proposes digest bumps. Keep the tag for readability.
FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /opt/requirements.txt
# Exact versions and sha256 hashes for cvdupdate and its whole dependency closure; --no-deps refuses
# anything unpinned and --require-hashes refuses any file whose hash is not in requirements.txt.
RUN python3 -m venv /opt/cvd \
 && /opt/cvd/bin/pip install --no-cache-dir --no-deps --require-hashes --only-binary=:all: -r /opt/requirements.txt \
 && /opt/cvd/bin/pip check
# cvdupdate calls requests.get() without timeouts; a stalled CDN connection would hang the job.
# urllib3 falls back to the socket default, so set one for the venv (.pth imports always run).
RUN echo "import socket; socket.setdefaulttimeout(120)" > "$(/opt/cvd/bin/python -c 'import site; print(site.getsitepackages()[0])')/zz_socket_timeout.pth"

WORKDIR /app
COPY src ./src
ENV NODE_ENV=production CVD_ROOT=/tmp/cvd CVD_BIN=/opt/cvd/bin/cvd
USER node
ENTRYPOINT ["node", "--experimental-strip-types", "/app/src/job.ts"]
