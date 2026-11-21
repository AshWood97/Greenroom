# MinIO now distributes source; build the official, pinned releases locally.
FROM golang:1.23-alpine AS build
ENV GOPROXY=https://goproxy.cn,direct GOTOOLCHAIN=auto
RUN sed -i 's@dl-cdn.alpinelinux.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apk/repositories \
    && apk add --no-cache curl git ca-certificates
WORKDIR /src/minio
RUN curl -fsSL --max-time 240 https://codeload.github.com/minio/minio/tar.gz/refs/tags/RELEASE.2025-10-15T17-29-55Z | tar -xz --strip-components=1
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -o /out/minio .
WORKDIR /src/mc
RUN curl -fsSL --max-time 240 https://codeload.github.com/minio/mc/tar.gz/refs/tags/RELEASE.2025-08-13T08-35-41Z | tar -xz --strip-components=1
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -o /out/mc .
FROM alpine:3.20
RUN sed -i 's@dl-cdn.alpinelinux.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates curl
COPY --from=build /out/minio /out/mc /usr/local/bin/
COPY --from=build /src/minio/LICENSE /licenses/minio-LICENSE
COPY --from=build /src/mc/LICENSE /licenses/mc-LICENSE
ENTRYPOINT ["minio"]
