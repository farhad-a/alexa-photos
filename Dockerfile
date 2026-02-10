# Multi-stage build for alexa-photos sync service

# Stage 1: Build TypeScript
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Stage 2: Runtime
FROM node:20-slim

# Install curl for healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist/ ./dist/

# Create data directory (host should mount volume here)
RUN mkdir -p /app/data

# Set production environment
ENV NODE_ENV=production

# Expose health endpoint
EXPOSE 3000

# Add healthcheck to ensure the service is running and healthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD [ "curl", "-s", "http://localhost:3000/health" ]

# Start the application
CMD ["node", "dist/index.js"]
