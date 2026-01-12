# MyQRLWallet Backend - Node.js Express Server
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Create non-root user for security
RUN addgroup -S backend && adduser -S backend -G backend && \
    chown -R backend:backend /app

USER backend

# Expose port (default Express port)
EXPOSE 3000

# Environment variables (set at runtime)
ENV NODE_ENV=production
ENV PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "server.js"]
