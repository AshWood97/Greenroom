FROM node:24.14.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/localminidrama
RUN git init . && git remote add origin https://github.com/xuanyustudio/LocalMiniDrama.git && git fetch --depth 1 origin 3fbcda9713ca545979dff9e75d21bed53694188f && git checkout --detach FETCH_HEAD
COPY runtime/creative-plugins/localminidrama/ /opt/greenroom/localminidrama/
COPY runtime/shared/generation-error.ts runtime/shared/media-storage.mjs /opt/shared/
RUN node /opt/greenroom/localminidrama/prepare.mjs /opt/localminidrama
RUN cd backend-node && npm install --omit=dev --no-audit --no-fund
RUN cd frontweb && npm ci --no-audit --no-fund && npm run build

FROM node:24.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/localminidrama /opt/localminidrama
WORKDIR /opt/localminidrama/backend-node
ENV PORT=18805 WEB_DIST_PATH=/opt/localminidrama/frontweb/dist
EXPOSE 18805
COPY runtime/shared/plugin-launcher.mjs /opt/greenroom/plugin-launcher.mjs
CMD ["node", "greenroom-start.cjs"]
