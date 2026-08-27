FROM node:24-alpine AS client-build

WORKDIR /app
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client
# vite.config.ts imports ../shared/vite-theme-bootstrap-plugin, and
# agentCommandPalette.ts imports ../../../src/agent/agentInstructions.ts
# directly — both shared/ and the root src/ have to sit alongside client/
# in the build context, not just on the host.
COPY shared/ ./shared/
COPY src/ ./src/
COPY client/ ./client/
RUN npm run build --prefix client

FROM node:24-alpine AS api-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-alpine AS admin-client-build

WORKDIR /app
COPY admin-client/package.json admin-client/package-lock.json ./admin-client/
RUN npm ci --prefix admin-client
# Same shared/ dependency as client-build above.
COPY shared/ ./shared/
COPY admin-client/ ./admin-client/
RUN npm run build --prefix admin-client

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3003

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=api-build /app/dist ./dist
COPY --from=client-build /app/client/dist ./client/dist
COPY --from=admin-client-build /app/admin-client/dist ./admin-client/dist

# Run as the base image's built-in unprivileged user instead of root —
# node:24-alpine defaults to root, and the app needs write access under
# /app at runtime (data/uploads for local file storage), so ownership has
# to move with it.
RUN chown -R node:node /app
USER node

EXPOSE 3003 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3003/health || exit 1

CMD ["node", "dist/index.js"]
