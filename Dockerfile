FROM node:24-alpine AS client-build

WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:24-alpine AS api-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-alpine AS admin-client-build

WORKDIR /app/admin-client
COPY admin-client/package.json admin-client/package-lock.json ./
RUN npm ci
COPY admin-client/ ./
RUN npm run build

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3003

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=api-build /app/dist ./dist
COPY --from=client-build /app/client/dist ./client/dist
COPY --from=admin-client-build /app/admin-client/dist ./admin-client/dist

EXPOSE 3003 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3003/health || exit 1

CMD ["node", "dist/index.js"]
