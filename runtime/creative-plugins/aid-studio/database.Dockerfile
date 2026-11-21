ARG DOCKERHUB_PREFIX=docker.io
FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS source
WORKDIR /source
RUN curl -fsSL --max-time 240 https://codeload.github.com/gzxx-2025/aid-studio/tar.gz/7e0ed1512b295e558e9c0accd9c12689076b3547 | tar -xz --strip-components=1
# The 5.7 dump mixes explicit columns and temporary tables inheriting the database default.
RUN sed -i 's/SET NAMES utf8mb4;/SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;/g' sql/aid-init.sql \
    && sed -i '/DEFAULT CHARSET=utf8mb4 COLLATE=/!s/DEFAULT CHARSET=utf8mb4/DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci/g' sql/aid-init.sql \
    && sed -i 's/group_concat_max_len=GREATEST(@@session.group_concat_max_len,65535)/group_concat_max_len=CAST(GREATEST(@@session.group_concat_max_len,65535) AS UNSIGNED)/' sql/aid-init.sql \
    && sed -i '1iALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;' sql/aid-init.sql
FROM ${DOCKERHUB_PREFIX}/library/mysql:8.4
COPY --from=source /source/sql/aid-init.sql /docker-entrypoint-initdb.d/10-aid.sql
