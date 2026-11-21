ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS source
WORKDIR /opt/aid
RUN curl -fsSL --max-time 240 https://codeload.github.com/shijue-aid/aid-studio/tar.gz/804a775dd03cfb144a8218b3a6fdea876c7e8066 | tar -xz --strip-components=1
COPY runtime/creative-plugins/aid-studio/ /opt/integration/
RUN node /opt/integration/prepare.mjs /opt/aid
RUN cd frontend/web && npm ci --no-audit --no-fund && npm run build
FROM ${DOCKERHUB_PREFIX}/library/maven:3.9.9-eclipse-temurin-17 AS backend
WORKDIR /build
COPY --from=source /opt/aid /build
RUN mvn -B -DskipTests -Dmaven.test.skip=true -pl aid-admin -am package
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless ffmpeg fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/aid
COPY --from=backend /build/aid-admin/target/aid-admin.jar ./aid-admin.jar
COPY --from=source /opt/aid/frontend/web/.next/standalone ./frontend/web
COPY --from=source /opt/aid/frontend/web/.next/static ./frontend/web/.next/static
COPY --from=source /opt/aid/frontend/web/public ./frontend/web/public
COPY --from=source /opt/aid/greenroom ./greenroom
COPY --from=source /opt/aid/sql/aid-init.sql /opt/aid/sql/aid-init.sql
COPY --from=source /opt/aid/LICENSE /opt/aid/NOTICE ./
ENV PORT=18807 GREENROOM_MANAGED=true
CMD ["node", "/opt/aid/greenroom/host.mjs"]
