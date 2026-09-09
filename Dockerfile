# Multi-stage build for alexa-photos sync service

# Stage 1: Build workspace packages
FROM node:25-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY server/package*.json ./server/
COPY web/package*.json ./web/
# --ignore-scripts: better-sqlite3 ships prebuilt N-API binaries in its tarball
# (prebuilds/linux-*.node), but npm runs `node-gyp rebuild` for any package with a
# binding.gyp. node:*-slim has no python/make/g++, so let the prebuilds be used.
RUN npm ci --ignore-scripts

COPY server/ ./server/
COPY web/ ./web/
RUN npm run build -w server && npm run build -w web

# Strip dev dependencies so the runtime stage can copy node_modules as-is,
# avoiding a second install (and the ~20MB npm cache it would leave behind).
RUN npm prune --omit=dev

# Fail the build if the native binary is missing. --ignore-scripts fails silently,
# and better-sqlite3 only ships prebuilds for x64/arm64 - on any other platform this
# is the difference between a broken build and a container that crashes on start.
RUN node -e "new (require('better-sqlite3'))(':memory:').exec('SELECT 1')"

# Stage 2: Runtime
FROM node:25-slim

# Install curl for healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace package files (needed for "type": "module" resolution)
COPY package*.json ./
COPY server/package*.json ./server/
COPY web/package*.json ./web/

# Copy pruned production dependencies from builder
COPY --from=builder /app/node_modules/ ./node_modules/

# Copy compiled backend from builder
COPY --from=builder /app/server/dist/ ./server/dist/

# Copy compiled frontend from web-builder
COPY --from=builder /app/web/dist/ ./web/dist/

# Create data directory (host should mount volume here)
RUN mkdir -p /app/data

# Set production environment
ENV NODE_ENV=production

# Expose health/UI endpoint
EXPOSE 3000
# Login proxy, used only during device registration
EXPOSE 3456

# Add healthcheck to ensure the service is running and healthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD [ "curl", "-s", "http://localhost:3000/health" ]

# Start the application
CMD ["node", "server/dist/index.js"]
