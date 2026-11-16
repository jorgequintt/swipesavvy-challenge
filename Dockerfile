# frontend build stage: only the static output (index.html + assets) leaves it
FROM node:24-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# build stage
FROM node:24-alpine AS api
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
COPY db/migrations /db/migrations
RUN npm run build

# runtine stage - only release files

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --from=api /app/dist ./dist
COPY db/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
COPY --from=web /web/dist ./public
ENV STATIC_DIR=/app/public
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]