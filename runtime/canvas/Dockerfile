ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git curl python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN (curl --fail --location --retry 3 --connect-timeout 20 --max-time 180 "https://codeload.github.com/T8mars/T8-penguin-canvas/tar.gz/1d7061c0e6d2be92797b9e3f2ff0d12d485915e7" -o /tmp/canvas.tar.gz \
    && tar -xzf /tmp/canvas.tar.gz --strip-components=1 && rm /tmp/canvas.tar.gz) \
    || (git -c http.version=HTTP/1.1 clone --depth 1 --branch v3.5.2 https://github.com/T8mars/T8-penguin-canvas.git . && git checkout --detach 1d7061c0e6d2be92797b9e3f2ff0d12d485915e7 && rm -rf .git)
RUN npm ci --ignore-scripts --no-audit --no-fund && npm rebuild better-sqlite3 esbuild sharp
COPY runtime/canvas/prepare.mjs runtime/canvas/greenroom.ts runtime/canvas/runninghub.ts runtime/canvas/managed-execution.ts runtime/canvas/managed-client.ts runtime/canvas/managed-runtime.cjs runtime/canvas/frame-pair.cjs /integration/
COPY runtime/shared/generation-error.ts /shared/generation-error.ts
COPY runtime/shared/media-storage.mjs /shared/media-storage.mjs
COPY tests/verify-canvas-managed.mjs /integration/verify-canvas-managed.mjs
ARG GREENROOM_RELEASE_CHECKS=deferred
RUN node /integration/prepare.mjs /app && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build --config vite.config.ts \
    && if [ "$GREENROOM_RELEASE_CHECKS" != deferred ]; then GREENROOM_CANVAS_SOURCE=/app node /integration/verify-canvas-managed.mjs; fi \
    && npm prune --omit=dev --ignore-scripts

FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10000 dsh && useradd --uid 10003 --gid 10000 --no-create-home canvas
WORKDIR /app
COPY --from=build /app/package.json /app/LICENSE ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/src ./backend/src
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/tools/parsehub-bridge ./tools/parsehub-bridge
COPY --from=build /app/tools/zcanvas-cli ./tools/zcanvas-cli
COPY --from=build /app/dist ./dist
COPY runtime/canvas/launch.cjs ./launch.cjs
ENV HOST=127.0.0.1 PORT=18766 NODE_ENV=production T8PC_PACKAGED=1 \
    T8PC_FRONTEND_DIST=/app/dist T8PC_USER_DATA=/var/lib/canvas HOME=/var/lib/canvas T8_FIGMA_BRIDGE_AUTOSTART=0
USER 10003:10000
CMD ["node", "/app/launch.cjs"]
