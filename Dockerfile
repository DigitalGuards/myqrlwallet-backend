# MyQRLWallet Backend - Node.js Express Server
FROM node:20-alpine

WORKDIR /app

# Install curl for health checks (not available in alpine by default)
RUN apk add --no-cache curl

# Install dependencies first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Use the built-in node user (UID 1000, GID 1000) for security
# The node user already exists in node:20-alpine
RUN chown -R node:node /app

USER node

# Expose port (default Express port)
EXPOSE 3000

# Environment variables (set at runtime)
ENV NODE_ENV=production
ENV PORT=3000

# Health check using curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "server.js"]
