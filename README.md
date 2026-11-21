# Greenroom

Greenroom 是本机运行的创作工作台。它把官方 DeepSeek Harness、T8 画布、创作插件、素材和模型供应商集中在一个本地环境。API 管理支持分类模型目录、多供应商和插件绑定。

## 本机启动

需要 Python 3.9+、Docker Engine（或 Docker Desktop）及 Docker Compose v2/v5。首次启动从公开源码和软件包构建镜像，需要访问 GitHub、Docker Hub、npm、PyPI 及公开系统软件源。运行端口绑定在本机。

\`\`\`sh
git clone https://github.com/AshWood97/Greenroom.git
cd Greenroom
python3 scripts/dev/local-live.py up
\`\`\`

在 macOS 上，可运行 \`python3 scripts/dev/local-live.py trust\` 把本机 CA 加入用户钥匙串。其他系统可按系统或浏览器的证书管理方式信任数据目录内的 \`tls/edge/ca.crt\`。工作台和控制台使用同一张证书。

打开 [Greenroom API 管理](https://greenroom.localhost:18443/?panel=api) 设置模型网关。DSH 通过 \`dsh.greenroom.localhost:18443\` 进入。默认数据目录是 \`~/.local/share/greenroom-public\`。已有服务占用端口时，可用 \`GREENROOM_LOCAL_PORT\` 自定义端口。可用 \`GREENROOM_LOCAL_DATA\`、\`GREENROOM_COMPOSE_PROJECT\` 和 \`GREENROOM_IMAGE_PREFIX\` 分开运行多套实例。停止服务用 \`python3 scripts/dev/local-live.py down\`。

## 插件与许可证

这个仓库发布 Greenroom 源码、构建脚本和适用声明。Greenroom 自有部分使用 [Apache-2.0](LICENSE)。第三方组件按各自许可使用，固定版本、对应源码与适用声明见 [第三方声明](THIRD_PARTY_NOTICES.md)。

火宝短剧和 Hypit 由需要它们的用户分别从上游安装并遵循上游许可。公开版的启动器不下载或启动这两项，也不包含本机已有项目、API Key、数据文件或镜像。

- [代码导航](docs/wiki/README.md)
- [插件目录](runtime/creative-plugins/catalog.json)
