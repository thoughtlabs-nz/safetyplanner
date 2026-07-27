# Build context is the REPO ROOT (see docker-compose.yaml) — mqtt-ingest
# imports ../../convex/_generated at runtime, and npm workspaces need the
# root package.json + lockfile. Runs under tsx (same as dev/start scripts);
# there is no emitted dist build — see apps/mqtt-ingest/tsconfig.json.
FROM node:22-alpine
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/poller/package.json apps/poller/
COPY apps/mqtt-ingest/package.json apps/mqtt-ingest/
RUN npm ci --workspace=safety-planner-mqtt-ingest --include-workspace-root

COPY convex ./convex
# Named source paths, not `COPY apps/mqtt-ingest ./apps/mqtt-ingest` — see
# apps/web/Dockerfile's comment on this same line: a wholesale directory
# copy can pick up a stray node_modules (or other build artifact) from
# whatever's on disk in the build context, silently shadowing what npm ci
# just installed. Don't rely on .dockerignore alone surviving every
# possible way a repo might get onto a build host.
COPY apps/mqtt-ingest/src ./apps/mqtt-ingest/src
COPY apps/mqtt-ingest/scripts ./apps/mqtt-ingest/scripts
COPY apps/mqtt-ingest/tsconfig.json ./apps/mqtt-ingest/

WORKDIR /repo/apps/mqtt-ingest
# Same shared storage volume as the poller — the control server there
# serves what this app saves (see src/storage.ts's layout note).
ENV STORAGE_PATH=/data/storage
CMD ["npx", "tsx", "src/index.ts"]
