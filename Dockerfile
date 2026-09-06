# syntax=docker/dockerfile:1
# CLAWD JUMP: ECHO TOWER — Fastify server + static client, built with esbuild.
# Multi-stage: full build → slim runtime (non-root, health-checked). The server
# bundle carries every dependency, so the runtime image ships no node_modules.

# --- build: full toolchain; produces dist/public and dist/server/index.js ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Minified, hashed client bundle; the server bundle is unaffected by the mode.
RUN NODE_ENV=production npm run build

# --- runtime -----------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/dist/public
WORKDIR /app
# package.json carries "type": "module" so dist/server/index.js loads as ESM.
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# --enable-source-maps: stack traces point at src/ via dist/server/index.js.map.
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
