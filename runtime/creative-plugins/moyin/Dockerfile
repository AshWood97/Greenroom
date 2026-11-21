FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/moyin
RUN curl -fL https://codeload.github.com/MemeCalculate/moyin-creator/tar.gz/7e5c5655de94d49885e13c369f0a71212893a0aa | tar -xz --strip-components=1
COPY runtime/creative-plugins/moyin/ /opt/greenroom/moyin/
COPY runtime/shared/generation-error.ts /opt/shared/generation-error.ts
RUN node /opt/greenroom/moyin/prepare.mjs /opt/moyin
RUN npm ci --ignore-scripts --no-audit --no-fund && npx vite build --config vite.greenroom.config.ts && npx esbuild src/greenroom-worker.ts --bundle --platform=node --format=esm --target=node24 --packages=external --alias:@=./src --alias:@opencut/ai-core=./src/packages/ai-core --define:import.meta.env.BASE_URL='"/plugins/moyin/"' --outfile=greenroom-worker.mjs
EXPOSE 18803
COPY runtime/shared/plugin-launcher.mjs /opt/greenroom/plugin-launcher.mjs
# Requires the shared activation delivery files from PR #28; packaging only.
COPY runtime/shared/activation-runner.mjs runtime/shared/activation-client.mjs runtime/shared/activation-startup-unit.mjs runtime/shared/activation-startup-units.json /opt/greenroom/shared/
CMD ["node", "greenroom-server.mjs"]
