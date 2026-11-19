# Multi-stage production image for Bob.
# Serves the API + Cardputer WebSocket + Supabase-backed store + the built ui-v2 web
# client on one host. The repo runs TypeScript directly with tsx (no compile step), so
# the runtime keeps node_modules and runs apps/api/src/server.ts through tsx. The
# runtime needs Node >= 22, hence node:24-slim.
#
# Every stage pins the image by digest, so a rebuild of the same commit gets the
# same base, and a changed base arrives as a reviewable PR (.github/dependabot.yml)
# rather than silently on whichever build runs next.

# npm's download cache lives in a BuildKit cache mount, so it survives between
# builds and a lockfile change refetches only what changed.

# ---- deps stage ------------------------------------------------------------
# The production dependencies of the API and the agent layer, nothing else: the
# runtime never loads the web client's packages (react, mermaid, recharts, ...)
# or any dev tool. Installed directly, so there is no `npm prune` pass and the runtime node_modules is a fraction of the full tree.
#
# Every workspace manifest is copied because the root lockfile references them
# all; `npm ci` refuses a tree that disagrees with it. `npm ci` runs the root
# `prepare` (scripts/install-hooks.mjs), which no-ops without a .git dir but
# must exist for node to load.
FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json      apps/api/package.json
COPY apps/ai/package.json       apps/ai/package.json
COPY apps/ui-v2/package.json    apps/ui-v2/package.json
COPY apps/cardputer/package.json apps/cardputer/package.json
COPY apps/mobile/package.json   apps/mobile/package.json
COPY scripts/install-hooks.mjs  scripts/install-hooks.mjs
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @bob/api --workspace @bob/ai --no-audit --no-fund

# ---- web stage -------------------------------------------------------------
# Builds the ui-v2 client into apps/ui-v2/dist, in parallel with deps, from the
# web workspace's packages only. The bundle is built with vite alone: CI already
# typechecked this tree (`npm run typecheck`, the web half), and the typecheck
# needs the root's @types/node, which this stage leaves out. The client imports
# nothing from apps/api or apps/ai, so they are not copied here: they change on
# nearly every commit and would rebuild the client each time.
FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json      apps/api/package.json
COPY apps/ai/package.json       apps/ai/package.json
COPY apps/ui-v2/package.json    apps/ui-v2/package.json
COPY apps/cardputer/package.json apps/cardputer/package.json
COPY apps/mobile/package.json   apps/mobile/package.json
COPY scripts/install-hooks.mjs  scripts/install-hooks.mjs
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace @bob/ui-v2 --no-audit --no-fund
# apps/ui-v2/tsconfig.json extends ../../tsconfig.base.json.
COPY tsconfig.json       tsconfig.json
COPY tsconfig.base.json  tsconfig.base.json
COPY apps/ui-v2 apps/ui-v2
# prebuild copies the VAD assets from node_modules into public/vad.
RUN npm run prebuild --workspace @bob/ui-v2 \
    && npm exec --workspace @bob/ui-v2 -- vite build

# ---- tools stage -----------------------------------------------------------
# A static tini, a pinned release file checked against its sha256 by
# scripts/fetch-verified.mjs with node's own fetch. No apt-get. tini's hashes
# are the tini-static-<arch>.sha256sum files (github.com/krallin/tini/releases).
FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS tools
ARG TINI_VERSION=0.19.0
ARG TINI_SHA256_AMD64=c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee
ARG TINI_SHA256_ARM64=eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9
COPY scripts/fetch-verified.mjs /tmp/fetch-verified.mjs
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) tini_sha="$TINI_SHA256_AMD64" ;; \
         arm64) tini_sha="$TINI_SHA256_ARM64" ;; \
         *) echo "no pinned checksums for $arch" >&2; exit 1 ;; \
       esac \
    && mkdir -p /out \
    && node /tmp/fetch-verified.mjs \
         "https://github.com/krallin/tini/releases/download/v${TINI_VERSION}/tini-static-${arch}" \
         "$tini_sha" /out/tini \
    && chmod 0755 /out/tini \
    && /out/tini --version

# ---- migrations stage ------------------------------------------------------
# /health derives the schema this code expects from the newest file name under
# supabase/migrations (apps/api/src/web-health.ts). Only the names matter, so the
# runtime gets an empty file per migration, never the SQL. .dockerignore lets
# nothing else from supabase/ into the context.
FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS migrations
COPY supabase/migrations /tmp/migrations
RUN mkdir -p /out \
    && for f in /tmp/migrations/*.sql; do : > "/out/$(basename "$f")"; done

# ---- runtime stage ---------------------------------------------------------
# Only what the API needs at runtime, as a non-root user.
FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    BOB_PRODUCTION=1 \
    BOB_V2_HOST=0.0.0.0 \
    BOB_V2_PORT=7444 \
    BOB_V2_JOURNAL=/data/v2-journal.log

# Non-root runtime user. /data is created and chowned here, BEFORE `USER bob`,
# so the journal is writable without a volume (/data is then ephemeral). The conversation
# store lives in Supabase and needs no local disk.
RUN groupadd --system --gid 1001 bob \
    && useradd --system --uid 1001 --gid bob bob \
    && mkdir -p /data \
    && chown -R bob:bob /app /data

# tini (PID 1). It changes rarely, so it sits above everything else.
COPY --from=tools /out/tini /usr/bin/tini
# Production node_modules of the API and the agent layer: tsx plus the @bob/ai
# workspace symlink the API needs to resolve its import. Keep the root manifest
# so npm/npx resolve.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=web /app/apps/ui-v2/dist ./apps/ui-v2/dist
COPY scripts/start-server.sh ./scripts/start-server.sh
# Empty files named like the migrations: /health reads the newest name as the
# schema it expects (no folder: schema_status "unknown").
COPY --from=migrations /out ./supabase/migrations
# The API runs as raw TypeScript through tsx, so its sources need no build and
# come straight from the context. Last, because they change most often: an
# api-only change reuses every layer above.
COPY apps/ai  ./apps/ai
COPY apps/api ./apps/api

USER bob
EXPOSE 7444

ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7444/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# scripts/start-server.sh execs the entry the root `start` script runs: `tsx
# src/server.ts` from apps/api, expressed from /app. It runs through `sh`, so the
# file needs no exec bit. The server binds
# 0.0.0.0:7444 and serves /health, /api/*, /v2/cardputer, and the built ui-v2
# client (apps/ui-v2/dist), resolved from cwd.
CMD ["sh", "scripts/start-server.sh"]
