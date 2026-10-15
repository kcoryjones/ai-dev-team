# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json

RUN npm ci

FROM dependencies AS build

COPY apps ./apps
COPY packages ./packages

RUN npm run build

FROM build AS test

CMD ["sh", "-lc", "npm test && npm run typecheck && npm run build"]

FROM build AS production-dependencies

RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ENGINEERING_TEAM_HOST=0.0.0.0 \
    ENGINEERING_TEAM_PORT=4317 \
    ENGINEERING_TEAM_DATABASE=/data/engineering-team.db \
    ENGINEERING_TEAM_WORKSPACE_ROOT=/workspaces \
    ENGINEERING_TEAM_WEB_ROOT=public

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends git ca-certificates gosu tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /workspaces /worktrees \
    && chown node:node /data /worktrees \
    && git config --system --add safe.directory '*'

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/database/package.json ./packages/database/package.json
COPY --from=build --chown=node:node /app/packages/database/dist ./packages/database/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./public
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/engineering-team-entrypoint

EXPOSE 4317

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["tini", "--", "/usr/local/bin/engineering-team-entrypoint"]
CMD ["node", "apps/server/dist/main.js"]

FROM runtime AS controller

USER root

ARG CODEX_VERSION=0.162.1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends docker.io \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY apps/server/worker/plan-schema.json /opt/engineering-team/plan-schema.json
COPY apps/server/worker/coding-result-schema.json /opt/engineering-team/coding-result-schema.json

EXPOSE 4319

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4319/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/server/dist/controller-main.js"]
