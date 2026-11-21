ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/python:3.12.13-slim
RUN pip install --no-cache-dir aiohttp==3.14.3 && groupadd --gid 10000 dsh && useradd --uid 10002 --gid 10000 --no-create-home connector
COPY runtime/connector/app.py /app/runtime/connector/app.py
COPY runtime/dsh/package.json /app/runtime/dsh/package.json
USER 10002:10000
CMD ["python", "/app/runtime/connector/app.py"]
