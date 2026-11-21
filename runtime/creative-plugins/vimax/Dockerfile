ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS ui
WORKDIR /opt/vimax
RUN curl -fsSL --max-time 240 https://codeload.github.com/HKUDS/ViMax/tar.gz/fd4b72e7731be6e5f88486206d25ea59849b0285 | tar -xz --strip-components=1
COPY runtime/creative-plugins/vimax/ /opt/integration/
RUN node /opt/integration/prepare.mjs /opt/vimax
RUN cd web && npm ci --no-audit --no-fund && npm run build
FROM ${DOCKERHUB_PREFIX}/library/python:3.12-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/vimax
COPY --from=ui /opt/vimax /opt/vimax
RUN pip install --no-cache-dir uv==0.9.7 && UV_HTTP_TIMEOUT=180 uv sync --frozen --no-dev
ENV PYTHONPATH=/opt/vimax PORT=18810 TIKTOKEN_CACHE_DIR=/opt/vimax/tiktoken-cache
RUN /opt/vimax/.venv/bin/python -c "import tiktoken; tiktoken.get_encoding('cl100k_base')" \
    && chmod -R a+rX "$TIKTOKEN_CACHE_DIR"
COPY runtime/shared/plugin-launcher.py /opt/greenroom/plugin-launcher.py
CMD ["/opt/vimax/.venv/bin/python", "/opt/vimax/greenroom/server.py"]
