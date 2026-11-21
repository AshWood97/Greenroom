ARG DOCKERHUB_PREFIX=docker.io

FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS creative-knowledge
WORKDIR /build
RUN mkdir openmontage drama-skills \
    && curl -fsSL --connect-timeout 20 --max-time 240 https://codeload.github.com/OpenMontageInc/OpenMontage/tar.gz/fecb9a1e3cc23ef84de30b272059457a427f16f8 | tar -xz -C openmontage --strip-components=1 \
    && curl -fsSL --connect-timeout 20 --max-time 240 https://codeload.github.com/zenstory-ai/drama-skills/tar.gz/3d813c30871b4db5f2387d83bdc3a49db8ce7b2b | tar -xz -C drama-skills --strip-components=1
COPY runtime/creative-plugins/openmontage /integration/openmontage
COPY runtime/creative-plugins/drama-skills /integration/drama-skills
RUN node /integration/openmontage/prepare.mjs /build/openmontage \
    && node /integration/drama-skills/prepare.mjs /build/drama-skills \
    && chmod -R a-w /build/openmontage/managed-skills /build/drama-skills/skills

FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS aigc-knowledge
WORKDIR /build
RUN mkdir shuohao-skills \
    && curl -fsSL --connect-timeout 20 --max-time 240 https://codeload.github.com/eternityspring/shuohao-skills/tar.gz/8af10e0ea1a550e4575666884f4deef780bf38ff | tar -xz -C shuohao-skills --strip-components=1
RUN mkdir lemo-opuscar \
    && curl -fsSL --connect-timeout 20 --max-time 240 https://codeload.github.com/lemomo-ai/lemo-opuscar/tar.gz/143f387ad774525dc9abc0ff05fb5f4bfbaa5f02 | tar -xz -C lemo-opuscar --strip-components=1
RUN mkdir manju-laoli-skill \
    && curl -fsSL --connect-timeout 20 --max-time 240 https://codeload.github.com/lixiaoxiao9888-create/manju-laoli-skill/tar.gz/ffa717b83f21fecb968d7697690196486a65332c | tar -xz -C manju-laoli-skill --strip-components=1
RUN mkdir awesome-short-drama-skills \
    && curl -fsSL --connect-timeout 20 --max-time 240 https://codeload.github.com/UnderleveledBuilder/awesome-short-drama-skills/tar.gz/9a1f686460c0a03cb0df40c3d2e55739568911dc | tar -xz -C awesome-short-drama-skills --strip-components=1
RUN mkdir director-skills \
    && curl -fsSL --connect-timeout 20 --max-time 240 https://codeload.github.com/kangarooking/director-skills/tar.gz/301e6e72199f28b8ea82cd48ff06ab9ae49d0ee5 | tar -xz -C director-skills --strip-components=1
RUN mkdir take-one \
    && curl -fsSL --connect-timeout 20 --max-time 240 https://codeload.github.com/talsiach/take-one/tar.gz/43fd27b8878241deb50a5884a154b173272b858f | tar -xz -C take-one --strip-components=1
RUN mkdir manjuforge \
    && curl -fsSL --connect-timeout 20 --max-time 240 https://codeload.github.com/mengxiujie/ManjuForge/tar.gz/e6a42b29dbc19cdd315fa54ebed38c43247d74eb | tar -xz -C manjuforge --strip-components=1
RUN --mount=type=cache,target=/root/.npm npm ci --prefix /build/lemo-opuscar --ignore-scripts --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org
COPY runtime/creative-plugins /integration
RUN node /integration/shuohao-skills/prepare.mjs /build/shuohao-skills \
    && node /integration/lemo-opuscar/prepare.mjs /build/lemo-opuscar \
    && node /integration/manju-laoli-skill/prepare.mjs /build/manju-laoli-skill \
    && node /integration/awesome-short-drama-skills/prepare.mjs /build/awesome-short-drama-skills \
    && node /integration/director-skills/prepare.mjs /build/director-skills \
    && node /integration/take-one/prepare.mjs /build/take-one /build/lemo-opuscar \
    && node /integration/manjuforge/prepare.mjs /build/manjuforge \
    && chmod -R a-w /build/shuohao-skills /build/lemo-opuscar/managed-skills \
        /build/manju-laoli-skill /build/awesome-short-drama-skills \
        /build/director-skills /build/take-one/managed-skills /build/manjuforge

FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm AS managed-runtime-inputs
WORKDIR /managed-runtime-inputs
COPY runtime/dsh/*.mjs ./
COPY runtime/dsh/managed-profile ./managed-profile
RUN chmod 0555 /managed-runtime-inputs/creative-cli.mjs \
    && chmod a-w /managed-runtime-inputs/greenroom-managed.mjs \
    && chmod -R a-w /managed-runtime-inputs/managed-profile

FROM ${DOCKERHUB_PREFIX}/library/node:24.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv bash curl procps util-linux ffmpeg poppler-utils python3-matplotlib fonts-noto-cjk && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10000 dsh && useradd --uid 10001 --gid 10000 --create-home dsh
WORKDIR /opt/dsh
COPY runtime/dsh/package.json runtime/dsh/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --omit=dev --registry=https://registry.npmjs.org
RUN test "$(node node_modules/@deepseek-ai/dsh/lib/bin.js --version)" = 0.2.2-rc.5 \
    && ln -s /opt/dsh/node_modules/pnpm/bin/pnpm.mjs /usr/local/bin/pnpm
COPY --from=managed-runtime-inputs /managed-runtime-inputs/*.mjs ./
RUN ln -s /opt/dsh/creative-cli.mjs /usr/local/bin/greenroom-mcp
COPY runtime/creative-plugins /opt/creative-plugins
COPY --from=creative-knowledge /build/openmontage/managed-skills /opt/creative-skills/openmontage
COPY --from=creative-knowledge /build/drama-skills/skills /opt/creative-skills/drama-skills
COPY --from=aigc-knowledge /build/shuohao-skills /opt/creative-skills/shuohao-skills
COPY --from=aigc-knowledge /build/lemo-opuscar/managed-skills /opt/creative-skills/lemo-opuscar
COPY --from=aigc-knowledge /build/manju-laoli-skill /opt/creative-skills/manju-laoli-skill
COPY --from=aigc-knowledge /build/awesome-short-drama-skills /opt/creative-skills/awesome-short-drama-skills
COPY --from=aigc-knowledge /build/director-skills /opt/creative-skills/director-skills
COPY --from=aigc-knowledge /build/take-one/managed-skills /opt/creative-skills/take-one
COPY --from=aigc-knowledge /build/manjuforge /opt/creative-skills/manjuforge
COPY --from=managed-runtime-inputs /managed-runtime-inputs/managed-profile ./managed-profile
COPY runtime/shared/media-storage.mjs runtime/shared/generation-error.ts runtime/shared/plugin-lifecycle.mjs runtime/shared/plugin-work.mjs /opt/shared/
RUN GREENROOM_DSH_NATIVE=1 node patch-dsh.mjs
RUN mkdir -p /workspace /var/lib/dsh /run/dsh && chown 10001:10000 /workspace /var/lib/dsh /run/dsh
ENV DSH_HOME=/var/lib/dsh HOME=/var/lib/dsh GREENROOM_PROVIDER_KEY=runtime-placeholder
USER 10001:10000
WORKDIR /workspace
CMD ["node", "/opt/dsh/launch.mjs"]
