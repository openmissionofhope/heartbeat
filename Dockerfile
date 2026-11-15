# syntax=docker/dockerfile:1.7
# OMH Heartbeat: one Node.js process (web + scheduled jobs) talking to PostgreSQL.
FROM node:22.14.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.14.0-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json LICENSE NOTICE ./
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
