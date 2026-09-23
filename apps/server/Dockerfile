FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/server apps/server
RUN npm run build -w @leadforge/server

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/web/package.json apps/web/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/server/dist apps/server/dist
USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/server/dist/api.js"]
