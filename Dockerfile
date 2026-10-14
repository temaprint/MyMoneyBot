# ── builder: все зависимости (вкл. prisma CLI) + генерация клиента ──
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl

# Манифесты отдельно → слой зависимостей кэшируется
COPY package*.json ./
RUN npm ci --no-audit --no-fund --cache /tmp/npm-cache && rm -rf /tmp/npm-cache

COPY prisma ./prisma
RUN npx prisma generate

# ── prod-deps: только runtime-зависимости + сгенерированный клиент ──
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund --cache /tmp/npm-cache && rm -rf /tmp/npm-cache
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# ── migrate: одноразовый контейнер со схемой и prisma CLI ───────────
FROM node:22-alpine AS migrate
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=builder /app/node_modules ./node_modules
COPY prisma ./prisma
COPY package.json ./
CMD ["npx", "prisma", "db", "push"]

# ── app: финальный образ без prisma CLI ─────────────────────────────
FROM node:22-alpine AS app
WORKDIR /app
RUN apk add --no-cache openssl

# Не от root
RUN addgroup -S app && adduser -S app -G app
USER app

COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app src ./src
COPY --chown=app:app package.json ./

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
