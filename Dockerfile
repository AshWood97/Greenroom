ARG DOCKERHUB_PREFIX=docker.io

FROM ${DOCKERHUB_PREFIX}/library/node:22.22.0-alpine AS frontend-deps
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN corepack enable \
    && corepack prepare pnpm@9.15.0 --activate \
    && pnpm config set registry "${NPM_REGISTRY}"

# Fetch lockfile-pinned tarballs first so a version-only package.json change
# relinks from the store instead of re-downloading every dependency.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm fetch
COPY package.json ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline
