FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && corepack enable \
  && pnpm install --frozen-lockfile=false \
  && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV DATABASE_PATH=/data/app.sqlite

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
COPY src/server ./src/server
COPY sample ./sample

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
