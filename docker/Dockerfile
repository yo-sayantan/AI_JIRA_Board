# syntax=docker/dockerfile:1
#
# My Jira Board — self-contained image.
#   • Stage 1 builds the single-file React board (dist/index.html).
#   • Stage 2 runs the zero-dependency Node server plus the Python fetch pipeline,
#     so the board serves AND refreshes itself with no host commands.
#
# Build & run:
#   docker compose up -d --build          # easiest (see docker-compose.yml)
# or:
#   docker build -f docker/Dockerfile -t jira-board .
#   docker run -d --name JIRA-Board -p 127.0.0.1:4321:4321 \
#     -v "$PWD/setup:/app/setup" \
#     jira-board
#   (setup/ holds the API keys, setup/.env, which the board's key dialog writes. Mount the
#    DIRECTORY, not the file: a save replaces the file and a single-file bind would keep
#    pointing at the old inode — see docker-compose.yml.)
# Then open http://localhost:4321
#
# The runtime stage runs as the image's built-in unprivileged `node` user (uid 1000,
# HOME=/home/node). Anything bind-mounted read-write (./jira-intern, ./setup) must be writable by
# uid 1000 — transparent on Docker Desktop; on a Linux host chown it once.

# Where dist/index.html comes from:
#   build    (default) — npm ci + vite build inside the image. Needs registry access
#            from the Docker VM, whose network is slow/flaky here — npm then silently
#            skips OPTIONAL platform binaries (@typescript/typescript-linux-arm64,
#            lightningcss-…), and tsc dies at "Unable to resolve …-linux-arm64".
#   prebuilt — take the dist/ the HOST already built (start-jira-board.sh runs
#            `npm run build` first and passes --build-arg DIST_SOURCE=prebuilt).
#            No npm, no network, no platform-binary roulette.
ARG DIST_SOURCE=build

# ── Stage 1a: build the board in-image ─────────────────────────────────────────
FROM node:26-bookworm-slim AS dist-build
WORKDIR /app
# Install deps first so this layer is cached until the lockfile changes.
# --ignore-scripts: no dependency needs a lifecycle script (the only one in the lockfile is
# fsevents, an optional macOS-only package that is skipped on Linux anyway).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
# Bring in the source and produce dist/index.html (tsc --noEmit && vite build).
COPY . .
RUN npm run build

# ── Stage 1b: take the host-built board as-is ──────────────────────────────────
FROM node:26-bookworm-slim AS dist-prebuilt
WORKDIR /app
COPY dist ./dist

# The stage the runtime copies dist/ from, chosen by DIST_SOURCE.
FROM dist-${DIST_SOURCE} AS build

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime
# Container-friendly defaults; override any of these at `docker run`/compose time.
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=4321 \
    HOME=/home/node
# python3 = the deterministic fetch; tini = clean PID 1 (reaps the Python children
# that the Refresh button spawns); ca-certificates for TLS. bash + coreutils(timeout)
# already ship in the base image and cover the runner scripts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# App server + built board + the whole intern pipeline (scripts, config, baked data).
# --chown on every COPY (instead of a trailing chown -R) so no layer is duplicated.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node jira-intern ./jira-intern
COPY --chown=node:node config ./config
# The help guide, served at /help/ — this is what the board's help (?) button opens, so it must
# exist inside the image, not just in the repo. Its developer-doc viewer renders docs/*.md.
COPY --chown=node:node help ./help
COPY --chown=node:node docs ./docs
# The guide links to /setup/ and /docs; server/serve.mjs allows /help, /docs and /setup.
COPY --chown=node:node setup ./setup
COPY --chown=node:node ai-intern/models.json ai-intern/cursor-prices.json ai-intern/cloud-models.json ./ai-intern/
COPY --chown=node:node docker/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh \
 # Pristine copy used to seed an empty mounted volume on first boot.
 && cp -a jira-intern /opt/jira-intern-seed \
 && chown -R node:node /opt/jira-intern-seed \
 # WORKDIR created /app as root; hand the directory itself to node (contents already are).
 && chown node:node /app
USER node
EXPOSE 4321
# Docker marks the container unhealthy when the status API stops answering (the same probe
# start-jira-board.sh waits on). start-period covers the seed + data.js sync at boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4321/api/intern-status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# tini as PID 1 so `docker stop` / Ctrl+C shut down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/docker-entrypoint.sh"]
