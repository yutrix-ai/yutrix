FROM node:24.16.0-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && npm install -g pm2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

ARG TARGETARCH
RUN ./scripts/bootstrap-opencode.sh

COPY ecosystem.config.cjs ./

ENV PNPM_IGNORE_BUILD_SCRIPTS=false
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true \
    && pnpm build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DB_FILE=/app/data/promptgate.sqlite
ENV ACTION_LOG_FILE=/app/data/action.log
ENV NODE_INTERPRETER=/usr/local/bin/node

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["pm2-runtime", "start", "ecosystem.config.cjs"]
