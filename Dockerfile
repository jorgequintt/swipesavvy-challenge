# build stage
FROM node:24-alpine AS api
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
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
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]