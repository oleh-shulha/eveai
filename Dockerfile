# syntax=docker/dockerfile:1

# Self-contained build of the bot service: compile TypeScript and the browser
# app in one stage, ship only the compiled output plus production dependencies
# in the next. Debian (glibc) on purpose: better-sqlite3 publishes prebuilt
# binaries for it, and the build stage can still compile from source when no
# prebuild matches the platform you build on.

FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV NODE_ENV=development

# Toolchain for a better-sqlite3 source build; dropped with this stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Dependencies first: this layer is reused until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

# tsc -> dist/, vite -> web/dist/ (the server serves it from ./web/dist).
RUN npm run build

# Keep the native module that was just built, drop everything dev-only.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    # A container port bound to loopback is unreachable from outside it.
    HOST=0.0.0.0 \
    PORT=3000

# unzip: the EVE SDE archive is extracted with it, both by `npm run setup:built`
#   and by the in-app refresh button, which shells out the same way.
# procps: the runtime lock verifies a lock owner's process start time with `ps`
#   before refusing to start; without it a stale lock needs manual clearing.
# ca-certificates: outbound TLS to ESI, CCP static data, and the model endpoint.
# tini: reaps those short-lived children and forwards SIGTERM to the app, which
#   drains in-flight turns on shutdown.
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip procps ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./

# Everything mutable lives here: SQLite database, the SDE snapshot, the ESI
# catalog cache, generated profiles. Mount a volume over it.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3000

# Same endpoint the operator's own probes use; no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/app.js"]
