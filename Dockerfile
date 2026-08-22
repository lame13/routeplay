FROM node:22-bookworm-slim AS build

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY biome.json tsconfig.json tsup.config.ts vitest.config.ts ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runner

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /src/dist ./dist
COPY routeplay.schema.json README.md LICENSE ./

RUN mkdir -p /work && chown pwuser:pwuser /work
USER pwuser
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
