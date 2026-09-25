# Bounded MIME-processing container (spec §3.1 Containers, §5.1 step 5). Stateless: messages are
# parsed in memory with strict limits and streamed back as NDJSON; nothing is written to disk.
# Build context expects dist/server.mjs from `pnpm build:mime` (bundles @bye/mail-codec from the
# workspace, which is outside this build context, so the bundle cannot be built in a stage here).
# `pnpm deploy`, `pnpm deploy:plan`, `pnpm drift` and every CI plan/deploy job run it first via
# `pnpm build:deploy`; a missing bundle fails the image build at the COPY below.
# Base image pinned by multi-arch index digest (resolved 2026-09-26 from registry-1.docker.io);
# Dependabot (docker ecosystem) proposes digest bumps. Keep the tag for readability.
FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
WORKDIR /app
COPY dist/server.mjs /app/server.mjs
ENV NODE_ENV=production PORT=8080 MIME_TIMEOUT_MS=60000 NODE_OPTIONS=--max-old-space-size=768
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
