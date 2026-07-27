# Build context is the REPO ROOT (see docker-compose.yaml) — the poller
# imports ../../convex/_generated at runtime, and npm workspaces need the
# root package.json + lockfile. Runs under tsx (same as dev/start scripts);
# there is no emitted dist build — see apps/poller/tsconfig.json.
FROM node:22-alpine
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/poller/package.json apps/poller/
COPY apps/mqtt-ingest/package.json apps/mqtt-ingest/
RUN npm ci --workspace=safety-planner-poller --include-workspace-root

COPY convex ./convex
# Named source paths, not `COPY apps/poller ./apps/poller` — see
# apps/web/Dockerfile's comment on this same line: a wholesale directory
# copy can pick up a stray node_modules (or other build artifact) from
# whatever's on disk in the build context, silently shadowing what npm ci
# just installed. Don't rely on .dockerignore alone surviving every
# possible way a repo might get onto a build host.
COPY apps/poller/src ./apps/poller/src
COPY apps/poller/tsconfig.json ./apps/poller/

WORKDIR /repo/apps/poller
# Storage lives on a shared volume (mounted by compose) — the same disk
# mqtt-ingest writes to and the control server serves /files/* from.
ENV STORAGE_PATH=/data/storage
EXPOSE 4100
CMD ["npx", "tsx", "src/index.ts"]
