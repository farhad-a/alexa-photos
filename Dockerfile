FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled output
COPY dist/ ./dist/

# Create data directory (host should mount volume here)
RUN mkdir -p /app/data

CMD ["node", "dist/index.js"]
