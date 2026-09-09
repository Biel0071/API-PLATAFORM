# ---------- Build ----------
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY eslint.config.mjs ./
COPY packages/shared/package.json packages/shared/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY packages/sdk-js/package.json packages/sdk-js/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/

# The lockfile is committed; deterministic CI install avoids resolver work and
# prevents long, non-reproducible deploy jobs on the VPS.
RUN npm ci --workspaces --include-workspace-root --ignore-scripts --prefer-offline

COPY packages ./packages
COPY apps/api ./apps/api

RUN npm run build -w packages/shared \
 && npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w apps/api \
 && if [ "$RUN_IMAGE_TESTS" = "true" ]; then npm test -w apps/api -- --exclude tests/http-routes-and-auth.test.ts --exclude tests/fenix-operational-core.test.ts; fi

# ---------- Runtime ----------
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma ./apps/api/prisma

WORKDIR /app/apps/api
EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/main.js"]

