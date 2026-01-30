# Production Dockerfile for Hedged LP Bot
# Multi-stage build for minimal image size

# ============================================
# Stage 1: Builder - compile TypeScript
# ============================================
FROM node:24-alpine AS builder

WORKDIR /app

# Copy dependency files
COPY package*.json ./
COPY tsconfig.json ./

# Install ALL dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript to JavaScript
RUN npm run build

# Remove devDependencies (keep only production deps)
RUN npm prune --omit=dev

# ============================================
# Stage 2: Production - minimal runtime image
# ============================================
FROM node:24-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy ONLY production dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Create logs directory with correct permissions
RUN mkdir -p logs && chown -R nodejs:nodejs logs

# Switch to non-root user
USER nodejs

# Health check (optional - uncomment if you add an HTTP endpoint)
# HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
#   CMD node -e "require('http').get('http://localhost:3000/health')" || exit 1

# Use dumb-init to handle signals properly (SIGTERM, etc)
ENTRYPOINT ["dumb-init", "--"]

# Set DNS result order to IPv4 first for better compatibility
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# Start the application
CMD ["node", "dist/index.js"]
