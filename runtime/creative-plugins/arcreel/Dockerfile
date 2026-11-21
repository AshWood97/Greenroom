FROM node:24-bookworm-slim AS source
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/arcreel
RUN git init . && git remote add origin https://github.com/ArcReel/ArcReel.git && git fetch --depth 1 origin afdb2091af79c154f87c3a1683bfb5d2ddd75493 && git checkout --detach FETCH_HEAD
COPY runtime/creative-plugins/arcreel/ /opt/greenroom/arcreel/
COPY runtime/creative-plugins/managed-bridge.py /opt/greenroom/managed-bridge.py
RUN node /opt/greenroom/arcreel/prepare.mjs /opt/arcreel
RUN corepack enable && cd frontend && pnpm install --frozen-lockfile && pnpm exec vite build

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /usr/local/bin/uv
COPY --from=source /opt/arcreel /opt/arcreel
WORKDIR /opt/arcreel
RUN uv sync --frozen --no-dev --no-install-project
ENV PATH=/opt/arcreel/.venv/bin:$PATH PYTHONUNBUFFERED=1 AUTH_ENABLED=false
EXPOSE 18804
COPY runtime/shared/plugin-launcher.py /opt/greenroom/plugin-launcher.py
CMD ["python", "greenroom_start.py"]
