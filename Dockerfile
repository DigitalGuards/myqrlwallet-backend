# MyQRLWallet Backend - Node.js Express Server (TypeScript)

# ── Build stage: compile src/ -> dist/ with devDependencies ──
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ── Runtime stage: production deps + compiled output only ──
FROM node:22-alpine

WORKDIR /app

# Install curl for health checks (not available in alpine by default)
RUN apk add --no-cache curl

# Install production dependencies first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled output + the stable entry shim
COPY --from=build /app/dist ./dist
COPY server.js ./

# Use the built-in node user (UID 1000, GID 1000) for security
# The node user already exists in node:22-alpine
RUN chown -R node:node /app

USER node

# Expose port (default Express port)
EXPOSE 3000

# Environment variables (set at runtime)
ENV NODE_ENV=production
ENV PORT=3000

# Health check using curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health/live || exit 1

# Start the server
CMD ["node", "server.js"]
