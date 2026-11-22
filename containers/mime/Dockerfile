# Bounded MIME-processing container (spec §3.1 Containers, §5.1 step 5). Stateless: messages are
# parsed in memory with strict limits and streamed back as NDJSON; nothing is written to disk.
# Build context expects dist/server.mjs from `pnpm build:mime` (bundles @bye/mail-codec from the
# workspace, which is outside this build context, so the bundle cannot be built in a stage here).
# `pnpm deploy`, `pnpm deploy:plan`, `pnpm drift` and every CI plan/deploy job run it first via
# `pnpm build:deploy`; a missing bundle fails the image build at the COPY below.
# Base image pinned by multi-arch index digest (resolved 2026-11-03 from registry-1.docker.io);
# Dependabot (docker ecosystem) proposes digest bumps. Keep the tag for readability.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
COPY dist/server.mjs /app/server.mjs
ENV NODE_ENV=production PORT=8080 MIME_TIMEOUT_MS=60000 NODE_OPTIONS=--max-old-space-size=768
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
