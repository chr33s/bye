# Deployer image (infra/onboarding/spec.md §44): the release checkout with its dependencies, and
# the job server (server.ts) that runs plans and applies with it in the installation's account.
# The image is the release: BYE_RELEASE_COMMIT is checked against every job's approved release.
# Build from the release tag at the repository root, single-platform (Cloudflare runs amd64, and
# onboarding copies the manifest byte for byte; an index is refused):
#   docker build --platform linux/amd64 --provenance=false --sbom=false \
#     -f infra/onboarding/deployer/Dockerfile --build-arg BYE_RELEASE_COMMIT=$(git rev-parse HEAD) .
FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
ARG BYE_RELEASE_COMMIT
RUN test -n "$BYE_RELEASE_COMMIT"
# /srv/bye is DEPLOYER_RELEASE_DIR in infra/onboarding/hosted-release.ts.
ENV BYE_RELEASE_DIR=/srv/bye BYE_RELEASE_COMMIT=$BYE_RELEASE_COMMIT PORT=8080 \
    CI=true ALCHEMY_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 NO_TRACK=1
# pnpm as a plain global binary, not a corepack shim: jobs run with a fresh HOME and only an
# allowlisted environment (executor.ts childEnv), where a shim would download pnpm again.
RUN npm install --global pnpm@12.8.1 && npm cache clean --force
# The checkout belongs to the unprivileged user that installs, builds and runs it.
RUN mkdir -p /srv/bye && chown node:node /srv/bye
WORKDIR /srv/bye
COPY --chown=node:node . .
USER node
RUN pnpm install --frozen-lockfile
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "infra/onboarding/deployer/server.ts"]
