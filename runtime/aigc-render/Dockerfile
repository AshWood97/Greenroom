ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/chromium HOME=/tmp/renderer
WORKDIR /opt/aigc-render
COPY --from=docker.io/library/python:3.12.13-slim /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY runtime/aigc-render/package.json runtime/aigc-render/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org \
    && sed -i 's@http://deb.debian.org/debian@https://mirrors.tuna.tsinghua.edu.cn/debian@g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt update \
    && npx playwright install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10000 renderer && useradd --uid 10001 --gid 10000 renderer
COPY runtime/aigc-render/runner.mjs ./
RUN chmod -R a-w /opt/aigc-render /opt/chromium
USER 10001:10000
ENTRYPOINT ["node", "/opt/aigc-render/runner.mjs"]
