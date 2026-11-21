ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS ui
ENV NODE_OPTIONS=--use-env-proxy
WORKDIR /opt/kineo
RUN curl -fsSL --max-time 240 https://codeload.github.com/Agions/kineo/tar.gz/45572564546fe885bf5b76adccccc9b073f7c5af | tar -xz --strip-components=1
COPY runtime/creative-plugins/kineo/ /opt/integration/
COPY runtime/shared/generation-error.ts runtime/shared/media-storage.mjs /opt/integration/
RUN node /opt/integration/prepare.mjs /opt/kineo
RUN corepack enable && HUSKY=0 pnpm install --frozen-lockfile --ignore-scripts && pnpm exec vite build
FROM ${DOCKERHUB_PREFIX}/library/rust:1.90-slim-bookworm AS native
COPY --from=ui /opt/kineo/crates /opt/kineo/crates
COPY --from=ui /opt/kineo/greenroom/native /opt/kineo/greenroom/native
WORKDIR /opt/kineo
RUN cargo build --release --locked --manifest-path greenroom/native/Cargo.toml
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/kineo
COPY --from=ui /opt/kineo/dist ./dist
COPY --from=ui /opt/kineo/greenroom/server.mjs /opt/kineo/greenroom/generation-error.ts /opt/kineo/greenroom/media-storage.mjs /opt/kineo/greenroom/media-retention.mjs ./greenroom/
COPY --from=ui /opt/kineo/LICENSE ./LICENSE
COPY --from=ui /opt/kineo/package.json ./package.json
COPY --from=native /opt/kineo/greenroom/native/target/release/kineo-greenroom-native ./greenroom/kineo-native
ENV PORT=18808
COPY runtime/shared/plugin-launcher.mjs /opt/greenroom/plugin-launcher.mjs
CMD ["node","greenroom/server.mjs"]
