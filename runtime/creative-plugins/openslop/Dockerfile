ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS source
WORKDIR /opt/openslop
RUN curl -fsSL --max-time 240 https://codeload.github.com/openslop/openslop/tar.gz/8848790b15730b63f601e8795790880379660c5f | tar -xz --strip-components=1
COPY runtime/creative-plugins/openslop /integration
RUN node /integration/prepare.mjs /opt/openslop

FROM source AS build
WORKDIR /opt/openslop
ENV PUPPETEER_SKIP_DOWNLOAD=true DISABLE_TELEMETRY=true NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_GREENROOM_BASE_PATH=/plugins/openslop
RUN npm install --ignore-scripts && npm run build

FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ffmpeg python3 fonts-noto-cjk fonts-noto-color-emoji ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/openslop
COPY --from=build /opt/openslop /opt/openslop
ENV PORT=18809 NEXT_TELEMETRY_DISABLED=1 DISABLE_TELEMETRY=true PUPPETEER_SKIP_DOWNLOAD=true CHROMIUM_PATH=/usr/bin/chromium FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe GREENROOM_PLUGIN_ROOT=/var/lib/dsh/creative-plugins/openslop GREENROOM_BASE_PATH=/plugins/openslop NEXT_PUBLIC_GREENROOM_BASE_PATH=/plugins/openslop
EXPOSE 18809
COPY runtime/shared/plugin-launcher.mjs /opt/greenroom/plugin-launcher.mjs
CMD ["node","--import","tsx","greenroom/start.ts"]
