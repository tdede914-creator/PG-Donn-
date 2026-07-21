# =============================================================================
# Payment Gateway - Docker image
# =============================================================================
# Build:  docker build -t payment-gateway .
# Run:    docker run -d -p 3000:3000 --env-file .env -v $(pwd)/data:/app/data payment-gateway
# =============================================================================

FROM node:20-alpine AS deps

# Prisma butuh openssl di alpine
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# --- runtime stage ---
FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl libc6-compat tini

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma generate
RUN npx prisma generate

# Buat direktori data (untuk SQLite) + logs
RUN mkdir -p /app/data /app/logs && chown -R node:node /app

# Env default (bisa di-override oleh --env-file)
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL="file:/app/data/prod.db" \
    EMBED_POLLER=true

USER node

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node src/scripts/seed.js || true; node src/server.js"]
