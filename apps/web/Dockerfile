# Build context is the REPO ROOT (see docker-compose.yaml) — the web app
# imports ../../convex/_generated at build time, and npm workspaces need the
# root package.json + lockfile.
# Debian (glibc), NOT alpine: npm's libc detection fails on musl, so on
# alpine it installs rolldown-vite's -gnu native binding instead of -musl
# and the Vite build dies with "Cannot find native binding".
FROM node:22-bookworm-slim AS build
WORKDIR /repo

# Workspace manifests first so `npm ci` stays cached across source edits.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/poller/package.json apps/poller/
COPY apps/mqtt-ingest/package.json apps/mqtt-ingest/
# Plain `npm ci` (not --workspace=...): the workspace-filtered install
# skips platform-specific optionalDependencies (npm/cli#4828), which drops
# rolldown-vite's @rolldown/binding-linux-* native module and breaks the
# build. Installing every workspace's deps is the price of a working one.
RUN npm ci

COPY convex ./convex
# Named source paths, not `COPY apps/web ./apps/web` — a wholesale
# directory copy would also pick up anything else present in the *build
# context's* apps/web on disk (a stray node_modules, .env, dist/ from a
# previous local build, etc.), which can silently shadow what npm ci just
# installed. Concretely: on a build context copied/synced onto a NAS from a
# Mac rather than a fresh git checkout, apps/web/node_modules/.bin/tsc
# turned into an "XSym..." placeholder file (a non-native-symlink artifact
# of the sync tool) instead of a real symlink, and overwrote the working
# one from this Dockerfile's own npm ci, breaking `tsc -b` below.
# .dockerignore should also exclude these, but don't rely on a dotfile
# surviving every possible way a repo might get onto a build host.
COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public
COPY apps/web/index.html apps/web/vite.config.ts ./apps/web/
COPY apps/web/tsconfig.json apps/web/tsconfig.app.json apps/web/tsconfig.node.json ./apps/web/

# Vite inlines VITE_* values into the bundle AT BUILD TIME — these are build
# args, not runtime env. Changing them requires a rebuild of this image.
ARG VITE_CONVEX_URL
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_POLLER_URL
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL \
    VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY \
    VITE_POLLER_URL=$VITE_POLLER_URL

RUN npm run build --workspace=safety-planner-web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
