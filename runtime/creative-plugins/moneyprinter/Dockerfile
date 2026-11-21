FROM node:24-bookworm-slim AS source
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/moneyprinter
RUN git init . && git remote add origin https://github.com/harry0703/MoneyPrinterTurbo.git && git fetch --depth 1 origin c235354804104665b58679223847f78c2b5e27d4 && git checkout --detach FETCH_HEAD
COPY runtime/creative-plugins/moneyprinter/ /opt/greenroom/moneyprinter/
COPY runtime/creative-plugins/managed-bridge.py /opt/greenroom/managed-bridge.py
RUN node /opt/greenroom/moneyprinter/prepare.mjs /opt/moneyprinter

FROM python:3.12-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.12.12 /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/moneyprinter
COPY --from=source /opt/moneyprinter /opt/moneyprinter
RUN uv pip install --system --no-cache --overrides requirements-security.txt \
    -r requirements.txt aiohttp==3.14.5 'setuptools>=82.0.1' 'wheel>=0.46.2'
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/opt/moneyprinter
EXPOSE 18801
COPY runtime/shared/plugin-launcher.py /opt/greenroom/plugin-launcher.py
CMD ["python", "greenroom.py"]
