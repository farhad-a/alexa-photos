FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY dist/ ./dist/

# Create data directory
RUN mkdir -p /app/data

CMD ["node", "dist/index.js"]
