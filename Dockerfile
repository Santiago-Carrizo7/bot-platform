# ==========================================
# Etapa 1: Base & Dependencias
# ==========================================
FROM node:20-alpine AS deps
WORKDIR /app

RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

RUN pnpm install --frozen-lockfile
RUN pnpm exec prisma generate

# ==========================================
# Etapa 2: Build
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma/
COPY src ./src/

RUN pnpm run build

# ==========================================
# Etapa 3: Runner de Producción
# ==========================================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Aplica migraciones pendientes y luego arranca la aplicación
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/app/index.js"]
