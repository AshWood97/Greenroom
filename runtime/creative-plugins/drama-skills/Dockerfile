ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS source
WORKDIR /opt/drama-skills
RUN curl -fsSL --retry 3 --max-time 240 https://codeload.github.com/zenstory-ai/drama-skills/tar.gz/3d813c30871b4db5f2387d83bdc3a49db8ce7b2b | tar -xz --strip-components=1
COPY runtime/creative-plugins/drama-skills/ /opt/integration/
RUN node /opt/integration/prepare.mjs /opt/drama-skills

FROM ${DOCKERHUB_PREFIX}/library/python:3.12-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/drama-skills
COPY --from=source /opt/drama-skills /opt/drama-skills
RUN python -m venv .venv && .venv/bin/pip install --no-cache-dir Pillow==11.3.0
ENV PORT=18812
COPY runtime/shared/plugin-launcher.py /opt/greenroom/plugin-launcher.py
CMD ["/opt/drama-skills/.venv/bin/python", "/opt/drama-skills/greenroom/server.py"]
