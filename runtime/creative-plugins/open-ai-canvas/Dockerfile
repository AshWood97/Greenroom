ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm-slim AS source
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fL https://codeload.github.com/ddcat-ai/open-ai-canvas/tar.gz/3ce013ec15a1a6065654986fd7f9433bf8d10b8c | tar -xz --strip-components=1
COPY runtime/creative-plugins/open-ai-canvas /integration
RUN node /integration/prepare.mjs /src

FROM ${DOCKERHUB_PREFIX}/oven/bun:1.3.9 AS web
COPY --from=source /src /src
WORKDIR /src/web
RUN bun install --frozen-lockfile && ROLLDOWN_WORKER_THREADS=2 RAYON_NUM_THREADS=2 bun --bun ./node_modules/vite/bin/vite.js build

FROM ${DOCKERHUB_PREFIX}/library/golang:1.25.3-bookworm AS backend
ENV GOPROXY=https://proxy.golang.org,direct
COPY --from=source /src /src
WORKDIR /src/backend
RUN CGO_ENABLED=1 go build -trimpath -o /out/yingce-backend ./cmd/server

FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/canvas
COPY --from=backend /out/yingce-backend /usr/local/bin/yingce-backend
COPY --from=source /src/LICENSE /opt/canvas/LICENSE
COPY --from=source /src/plugin-packages /opt/canvas/plugin-packages
COPY --from=source /src/backend/agent-runtime/pi /opt/canvas/backend/agent-runtime/pi
RUN cd /opt/canvas/backend/agent-runtime/pi && npm ci --omit=dev --ignore-scripts
COPY --from=source /src/greenroom /opt/canvas/greenroom
COPY --from=web /src/web/dist /opt/canvas/web/dist
ENV GREENROOM_PLUGIN_ROOT=/data/canvas GREENROOM_MANAGED=true
EXPOSE 18806
COPY runtime/shared/plugin-launcher.mjs /opt/greenroom/plugin-launcher.mjs
CMD ["node", "/opt/canvas/greenroom/host.mjs"]
