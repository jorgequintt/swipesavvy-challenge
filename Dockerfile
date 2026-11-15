FROM node:24-alpine AS api
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
RUN npm run build

# Second stage - only release files

FROM node:24-alpine
WORKDIr /app
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --from=api /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]