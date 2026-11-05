# ---- Base ----
FROM node:20-alpine AS base
# Prisma needs the OpenSSL CLI to detect the libssl version of the base image.
# Without it Prisma falls back to an openssl-1.1.x engine on Alpine (musl) and
# the generated client / schema engine fails at container start-up.
RUN apk add --no-cache openssl
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ---- Runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# --chown is required because the container runs as the unprivileged `node`
# user: the Prisma CLI (used for `prisma migrate deploy` at start-up) must be
# able to read and, if necessary, materialise engine binaries under
# /app/node_modules/@prisma.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/docs/openapi.yaml ./docs/openapi.yaml
COPY --chown=node:node package.json ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]