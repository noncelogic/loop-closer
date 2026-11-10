# loopcloser service image: ghcr.io/noncelogic/loop-closer (built by CI job `image`).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Read at runtime by src/contracts (schemas resolved relative to the app root).
COPY contracts ./contracts
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
