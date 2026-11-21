# API/broker for the local member environment. Production keeps its existing image.
ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/python:3.12.13-slim
RUN sed -i 's@http://deb.debian.org/debian@https://mirrors.tuna.tsinghua.edu.cn/debian@g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends nginx curl ca-certificates ffmpeg nodejs npm \
    && npm install -g --registry=https://registry.npmmirror.com @larksuite/cli@1.0.98 \
    && rm -rf /var/lib/apt/lists/*
COPY server/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple --require-hashes -r /tmp/requirements.lock \
    && pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple pytest==9.1.1 pytest-asyncio==1.4.0
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --from=docker.io/library/docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker
