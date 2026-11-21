# Greenroom 代码导航

- [本机启动器](../../scripts/dev/local-live.py)管理 Compose、插件和本机 TLS。
- [服务入口](../../server/app/main.py)挂载本地会话、素材、DSH 会话代理和 API 管理。
- [本机模型实验台](local-models.md)可单独验证模型 API。
- [插件目录](../../runtime/creative-plugins/catalog.json)列出可启用的创作工具和 Skills。


## 本机验证

- 前端构建使用 \`pnpm install --frozen-lockfile\` 和 \`pnpm build\`。
- 模型路由测试使用本机模拟供应商，覆盖文字、图片、配音、权限和任务查询。已安装 Python 依赖的环境可以从 \`server/\` 运行 \`GREENROOM_LOCAL_BOOTSTRAP_TOKEN=standalone-fixture-token DATA_DIR="$(mktemp -d)" python -m pytest -q tests\`。
- 准备好与仓库固定版本一致的 T8 源码后，可以设置 \`GREENROOM_CANVAS_SOURCE\` 并运行 \`pnpm test:canvas\`。
