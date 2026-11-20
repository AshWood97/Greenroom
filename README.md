# Greenroom

Greenroom 是在本机运行的 AI 创作工作台。控制台管理项目、供应商和创作记录，可打开官方 DeepSeek Harness，也能将单独安装的创作工具接到同一套模型网关。

## 安装

需要 Node.js 24.9 或更新版本。新克隆的仓库执行：

```sh
npm ci --ignore-scripts
npm start
```

打开 [http://127.0.0.1:3210](http://127.0.0.1:3210)。在「供应商与模型」保存自己的 API Key，并创建项目。点击侧栏「DeepSeek Harness → 启动 DSH → 打开官方工作台」进入官方 Web 界面。Greenroom 使用 DSH 的本机认证链接和原生权限设置。

控制台和 DSH 均监听回环地址，默认使用 3210 和 3211。可用 `GREENROOM_DATA`、`GREENROOM_PORT`、`GREENROOM_DSH_PORT` 指定数据目录和端口，另启一份工作区时三项应分别设置。默认数据位于被 Git 忽略的 `.greenroom/`。本地数据库、加密密钥、DSH profiles、会话和产物由该目录持有。备份时保存整个数据目录。已有公开版工作区在启动时添加新字段，历史记录可继续读回。

## 创作与模型

- 可以添加多个供应商、设置默认网关，以及在「创作插件」分别绑定文字、图片和音频的供应商。未绑定时继承默认网关。各供应商的模型目录从 `GET /models` 拉取，并按模型 ID 分类。
- 文字支持 Responses 和 Chat Completions。模型和思考深度独立选择。图片走 `/images/generations`，Flare 默认单张 1024 × 1024、Low 画质。配音走 `/audio/speech`，保存 MP3。
- Responses 可显式选用后台生成。已返回原编号的任务可在记录中查询。换网关或重新启动后仍向原地址查询同一编号，查询失败保留原记录。一般同步请求仍由当前提交窗口等待结果。
- 模型供应商密钥只由本机服务读取和转发。插件拥有各自的本机桥接凭据。调用生成会向绑定的供应商发送提示词，启用 Responses 后台生成会将该次结果保存到服务商，以便查询。

DSH 固定为 [官方 0.2.2-rc.5](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb)。启动时将 DSH 的文本供应商及其模型装入官方 profile。切换文本供应商或想重新拉取模型时，在没有进行中会话的情况下使用「同步网关并重启」。DSH 可通过自带的 MCP 机制读取 Greenroom 项目和历史、查询已受理任务，以及按需保存生成的图片和配音。原生插件、实验入口与权限操作沿用官方 Web profile。

## 创作插件

在「创作插件」可以查看每个项目的固定上游、许可证和安装方式。外部工具单独安装和启动，再登记本机网页地址。支持 Streamable HTTP MCP 的工具还可以登记本机 MCP 地址，DSH 在下一次启动时加载。需要单独认证的 MCP 服务可用 DSH 自带的设置界面配置。

支持 OpenAI 兼容网关的工具可以使用以下命令读取该工具自己的本机接入地址和凭据：

```sh
npm run plugin -- t8
```

以 T8 为例，从[固定版本的官方源码](https://github.com/T8mars/T8-penguin-canvas/tree/1d7061c0e6d2be92797b9e3f2ff0d12d485915e7)按上游说明启动，登记画布的本机网页地址，在 T8「API 设置」添加启用的 OpenAI 兼容扩展供应商，填写命令输出的 Base URL 和 API Key，并添加所需模型 ID。文字工具使用 Chat Completions 路径，图像使用 Image Generations 路径。Greenroom 项目和各独立插件自己的项目分别由各自工作区保存。

| 组件 | 交付方式与验证范围 |
| --- | --- |
| 官方 DSH、Greenroom MCP | 默认可用。已验证官方 Web 登录、原生 CLI 经模拟网关输出和 MCP 项目读取、配音保存。 |
| T8 画布 | 独立选装。已用固定版本的实际扩展供应商路线对接模拟网关，验证图片提交及 T8 本地保存和读回。 |
| ArcReel、魔因漫创、OpenMontage | 各自作为独立 AGPL 服务选装，使用上游源码与许可证。 |
| 火宝短剧、Hypit | 用户从上游自行安装，按其额外条款使用。 |
| 其余工具与 Skills | 提供上游目录。兼容的本机网页、模型网关及 MCP 可按上文登记。原生 Skills 依各上游说明安装到 DSH。 |

公开版的 DSH 和 T8 可独立运行。上表其余外部应用保留各自的安装及业务接口要求，独立应用的业务调用和项目导入仍有未移植项。

## 验证

```sh
npm test
```

测试使用隔离的本地目录和模拟模型网关，覆盖新工作区、模型分类、按用途绑定、文字／图片／配音、错误脱敏、重启读回、原供应商查询与官方 DSH 启动。另可在启动隔离的 T8 后端后设置 `GREENROOM_TEST_T8_URL` 为其回环地址，执行真实的 T8 图片接口测试。所有用例跳过付费生成与视频生成。

## 许可证

Greenroom 自有源码按 [Apache License 2.0](LICENSE) 提供。依赖和外部插件使用各自的许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。
