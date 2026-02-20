# Multi-stage build for alexa-photos sync service

# Stage 1: Build frontend (React)
FROM node:25-slim AS web-builder

WORKDIR /app/web

COPY web/package*.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# Stage 2: Build backend (TypeScript)
FROM node:25-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# Stage 3: Runtime
FROM node:25-slim

# Install curl for healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled backend from builder
COPY --from=builder /app/dist/ ./dist/

# Copy compiled frontend from web-builder
COPY --from=web-builder /app/web/dist/ ./web/dist/

# Create data directory (host should mount volume here)
RUN mkdir -p /app/data

# Set production environment
ENV NODE_ENV=production

# Expose health/UI endpoint
EXPOSE 3000

# Add healthcheck to ensure the service is running and healthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD [ "curl", "-s", "http://localhost:3000/health" ]

# Start the application
CMD ["node", "dist/index.js"]
