ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS source
WORKDIR /opt/openmontage
RUN curl -fsSL --retry 3 --max-time 240 https://codeload.github.com/OpenMontageInc/OpenMontage/tar.gz/fecb9a1e3cc23ef84de30b272059457a427f16f8 | tar -xz --strip-components=1
COPY runtime/creative-plugins/openmontage/ /opt/integration/
RUN node /opt/integration/prepare.mjs /opt/openmontage

FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg chromium fonts-noto-cjk fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/openmontage
COPY --from=source /opt/openmontage /opt/openmontage
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir pyyaml==6.0.3 pydantic==2.12.3 jsonschema==4.25.1 python-dotenv==1.1.1 Pillow==11.3.0 fastapi==0.118.0 uvicorn==0.37.0 watchfiles==1.1.0
ENV PUPPETEER_SKIP_DOWNLOAD=true CHROMIUM_PATH=/usr/bin/chromium FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe DISABLE_TELEMETRY=true PORT=18811
RUN cd greenroom/renderer && npm install --no-audit --no-fund && node prepare-renderer.mjs
COPY runtime/shared/plugin-launcher.py /opt/greenroom/plugin-launcher.py
CMD ["/opt/openmontage/.venv/bin/python", "/opt/openmontage/greenroom/server.py"]
