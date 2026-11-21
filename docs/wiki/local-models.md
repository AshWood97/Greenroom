# 本机自定义模型 API

本机独立版可以配置自己的模型地址、请求字段、结果映射和原任务查询。配置和运行记录保存在本机 SQLite。

## 实际入口与归属

- 从本机 Greenroom 的「API 管理 → 接入总览」找到「自定义模型 API」卡片，点击「配置与测试」进入 [配置页](https://greenroom.localhost:18443/local-models/)。`app.py` 提供同源配置/运行 API 和固定静态文件。主站使用现有本地会话校验 API 请求及写入来源。
- `server/app/local_models/__main__.py` 提供独立调试入口，固定监听 `127.0.0.1`，单 worker，禁用代理头信任。
- `core.py`：JSON/multipart 组装、HTTP(S) 有界请求、私有 SQLite 配置和原请求状态。没有自动提交/轮询后台循环。
- `ui/`：专属无依赖浏览器配置与明确提交/原编号查询，不改共享 DSH 或应用外观入口。
- 本模块不改素材服务。图片/视频/音频输出目前是服务商 URL；文本是映射后的字符串。没有把这些链接冒充 `/api/media/:id` 或成员 Asset。

已有 Python 依赖的开发环境也可运行独立调试入口。

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=server python -m app.local_models --data-dir /path/to/private-local-models --port 3099
```

独立调试页面位于 `http://127.0.0.1:3099/local-models/`。从本机主站使用该功能时，模型请求由 API 容器发出，其中 `127.0.0.1` 指向该容器。

本机整合后复跑了 36 项 Python 和 10 项界面定向检查。实际入口验证了页面及静态资源、登录后配置与任务列表、跨站写入拒绝以及 JSON 字段校验。定向检查使用替身，未调用供应商。

## 配置与真实支持范围

`GET /api/local-models/profiles` 只返回配置及 `has_key`，不返回 Key。

`PUT /api/local-models/profiles/{id}`：`{profile, api_key?, clear_key?}`。认证是 `none`、Bearer 或单一自定义 Key 请求头。Key 存在专属服务端 SQLite（文件权限 0600），不进配置读回、日志或运行视图。不是加密保险箱，有本机文件权限的进程仍可能读取。清除当前配置 Key 不清除历史任务冻结 Key；缺 Key 的新任务在网络前拒绝。

配置支持：

- HTTP/HTTPS；新生成方法 GET/POST/PUT/PATCH，输入 JSON 或 multipart 文件。GET 参数按查询字符串发送。
- 固定非秘密参数、输入点分路径映射；文件由页面选取并以 base64 交给本机服务，最多 16 文件、总 10 MiB，不接受任意本机路径。JSON 引用 URL 可作为普通输入配置。
- JSON 对象/数组响应，用 JSON Pointer 映射原任务 ID、状态和错误字段；结果路径可用 `*` 展开数组。
- image/video/audio 的 HTTP(S) URL 或 text 字符串结果。一个配置保持单一媒体种类，可映射多结果。
- GET/POST 原任务查询。`{task_id}` 只能出现在路径/查询，不可改变主机；也可映射到查询参数或 JSON 字段。查询和提交须同源。

不支持特殊签名、WebSocket、SSE/流式输出、二进制直接响应、只在响应头返回任务 ID、任意执行脚本、自动取消供应商任务或通用异步上传协议。没有提供“支持任意 API”的保证。无明确公开协议的服务需要专属适配。

服务商字段配置必须与其真实合同一致，特别是 `not_accepted_values`：只填写服务商明确证明没有创建任务的业务码，不要把所有 4xx/5xx 当作未受理。状态数组支持字符串、数字与布尔值；三类状态不能重叠。

## 不重投的生命周期

`POST /api/local-models/runs` 接受 `{request_id,profile_id,inputs,files}`。请求 ID 在提交前由调用者固定，原配置、Key 和输入冻结在私有库里，尝试记录提交后才发送网络请求。

- 本地参数/缺 Key 拒绝：没有网络提交。DNS/连接阶段明确失败记 `not_accepted`。
- 请求已开始而响应丢失、非可映射回复、未得任务号：`acceptance_unknown`。保存原请求，不重发；用户仍可明确创建独立的新请求。
- 有原服务商编号：`accepted`，仅查询该编号。
- HTTP 成功响应里的明确业务终态：`succeeded` 或 `failed`。声明成功但缺结果时保留原 ID 和结果待确认状态。
- 查询 401/429/5xx、网络异常：保存 `last_query_error`，不把查询错误改成原任务失败。
- 同 request ID 重复 POST 只读原记录，不再请求模型。输入变化返回 409，不覆盖旧输入或自动换 ID。

`GET /api/local-models/runs/{id}` 和 `GET /api/local-models/runs` 只读本机；后者最多返回最近 100 条、不含提示词、Key 或冻结请求。

若提交/查询已返回回执，但 SQLite UPDATE 或 commit 暂时失败，当前服务实例先保留原编号、结果与冻结配置，视图返回 `receipt_pending=true` 及明确警告，不把已返回编号丢回未知。读取原请求/列表只显示该进程持有的回执，不发网络。此时 `can_poll=true` 表示现有“原任务查询”按钮可先重试**本地保存**；该次调用无论保存成功或失败均不请求服务商，成功后再明确查询才 GET/POST 原编号。同 request ID、同输入 POST 也只重试保存；不同输入仍 409。

这不是崩溃持久日志：若进程在回执落盘前退出，内存编号/结果仍会丢失，重启只能看到之前持久化的 `acceptance_unknown`，不会再次提交。请勿关闭带有待保存回执的服务。初始尝试 INSERT/commit 失败仍不允许发送模型请求；不清理旧记录、不认领其他任务。

`POST /api/local-models/runs/{id}/poll {}` 在无待保存回执时仅显式查询原任务。没有原 ID/查询配置就拒绝；并发查询明确返回 `query_busy`，本次未排队。停止页面、重启服务或刷新不重新生成。当前服务是单进程实例，不能同时起多个实例共写这个专属数据库。

## 地址和 Key 边界

默认只访问公网地址。用户明确为某配置打开 `allow_private_network` 后，可使用其指定的本机或私网模型服务；链路本地/云 metadata、组播、未指定/保留地址仍拒绝，也拒绝把此配置服务本身用作模型。

DNS 解析后连接固定 IP，保留原 Host/TLS SNI，禁重定向和环境代理；查询实际构造 URL 再核同源。目标来源或认证类型改变时，必须重新填写 Key，不把旧 Key 静默转交新主机。

URL 用户密码、已知凭据查询参数（包括编码后的 key/api_key 等）拒绝。不能识别任意供应商发明的秘密参数名，用户不得把秘密放入地址、固定参数或普通输入字段。HTTP 会明文传输 Key，页面要求明确风险确认。结果错误只取已配置字段并脱敏；不会转完整供应商错误体。结果 URL 不带本机认证 Key 下载或代理，当前没有自动结果下载。

## 既有插件接线仍未完成

固定 batch 中的真实调用链是 `creative-proxy.managedPath` → model relay → CanvasService，并在完成后生成本地 Asset 记录。Moyin、Toonflow、火宝和 OpenMontage 的实际消费者都要求 `assetId` 或 `/api/media/:id`，不是随便一个 URL。

本页的配置由本页提交和查询。DSH 与创作插件仍使用原模型接口。把这里的图片、视频或音频结果交给插件，仍需接通本机素材归档及原任务恢复。

## 实际定向检查与未验

作者执行（Python 3.12.14；现有 FastAPI 0.141.1、Starlette 1.6.0、Uvicorn 0.52.1、httpx 0.28.1，未安装依赖）：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=server python -m unittest discover -s server/tests -p test_local_models.py -v
```

C2 结果 28/28，通过实际私有 SQLite、重新创建服务对象读回、multipart 字节组装、线程并发门禁及 ASGI 替身。网络为 FakeTransport/连接替身；包括 poll 域名占位符、清 Key、新请求缺 Key、401/429 不终结任务等独审触发回归。旧公司检查、旧 42 项用例不计为本轮复测。

非作者对 C2 做了独立静态增量复核，本轮已发现触发均闭合，未重跑以上 28 项；不是 Azure review/批准。未运行实际 TLS、供应商、Bun/DSH/插件桥、浏览器、完整类型检查、构建、生产或付费生成；未触 Mac 工作树。真实供应商效果只由用户手动新项目体验。无摘要/指纹或完整性清单。

保留火宝和 Hypit 原许可证与署名。火宝非商用及相同方式共享、Hypit 商业分发与托管限制未因本模块而改变；本候选不对其许可作重新授权。

## C3 回执保存故障增量（2026-11-17 UTC）

应用基线为已交付 `greenroom-local-models-core-c2.patch`（Library version 0）应用后的文件，底层固定 batch 仍是 `175d1f2f11fa5605fbff9045156a7745b765c27d`。此增量不改 UI 或素材存储，不宣称插件已接线。

作者实际执行：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=server python -m unittest discover -s server/tests -p test_local_models_receipts.py -v
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=server python -m unittest discover -s server/tests -p test_local_models.py -v
```

结果分别 8/8、28/28。新增项含实际 SQLite UPDATE 触发器失败/恢复、初始 INSERT 拒绝不发请求、同进程原 ID 保留、持续保存失败不查询、不同输入拒绝、结果保存失败、commit 已完成但确认丢失替身、进程重建后保留 unknown 不重投。所有供应商网络均为替身；没有运行真实供应商、监听服务、浏览器、Bun/DSH、构建、部署或 Mac 检查。作者 42 项历史离线用例未复测。独立复审另列于交付说明，不将作者结果当独立验收。
