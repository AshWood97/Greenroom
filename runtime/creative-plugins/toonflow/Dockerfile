FROM oven/bun:1.4.3-debian AS build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/toonflow
RUN git init . && git remote add origin https://github.com/HBAI-Ltd/Toonflow-app.git && git fetch --depth 1 origin 6086cdffceb704a632eca143dd16cd461a78cdac && git checkout --detach FETCH_HEAD
COPY runtime/creative-plugins/toonflow/ /opt/greenroom/toonflow/
COPY runtime/shared/generation-error.ts /opt/shared/generation-error.ts
COPY runtime/shared/media-storage.mjs /opt/shared/media-storage.mjs
RUN bun /opt/greenroom/toonflow/prepare.mjs /opt/toonflow
RUN bun install --frozen-lockfile
RUN bun run build:server && chmod a+r build/tools/pluginDeveloper.tool.js
ENV NODE_ENV=production TOONFLOW_SERVER_PORT=18802
EXPOSE 18802
COPY runtime/shared/plugin-launcher.mjs /opt/greenroom/plugin-launcher.mjs
# Requires the shared activation delivery files from PR #28; packaging only.
COPY runtime/shared/activation-runner.mjs runtime/shared/activation-client.mjs runtime/shared/activation-startup-unit.mjs runtime/shared/activation-startup-units.json /opt/greenroom/shared/
CMD ["bun", "build/server/index.js"]
