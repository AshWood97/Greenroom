# Greenroom

Greenroom 是本地运行的 AI 创作工作台。每个项目独立保存文字、图片和配音的提示词、模型、供应商与产物。

## 运行

需要 Node.js 24 或更新版本。在仓库目录执行：

```sh
npm start
```

打开 [http://127.0.0.1:3210](http://127.0.0.1:3210)，进入「供应商与模型」，输入网关地址和 API Key，然后创建项目。程序只在本机回环地址监听。默认数据目录是仓库内被 Git 忽略的 `.greenroom/`，可使用 `GREENROOM_DATA` 指定目录、用 `GREENROOM_PORT` 指定端口。

- 可以添加多个供应商、设置默认网关、限制单个供应商用于文字、图片或音频。
- 模型目录从所选供应商的 `GET /models` 自动拉取，根据模型 ID 分组。归类只用于展示，生成前仍由所选模型服务校验实际能力。
- 文字支持 OpenAI Responses 和 Chat Completions，模型与思考深度独立选择。
- 生图对接 OpenAI 兼容的 `POST /images/generations`，默认单张 1024 × 1024、Low 画质，保存网关返回的 PNG。
- 配音对接 OpenAI 兼容的 `POST /audio/speech`，保存 MP3。
- API Key 由本机服务加密保存，网页只读取供应商名称、地址、协议和适用工具。发起生成时，服务会向所选网关发送提示词与认证信息。备份数据时需同时保存本地数据库及其加密密钥。

公开仓库从独立实现开始。目前包含上面的创作主流程。DSH、旧版插件接入、视频生成和旧项目导入还未移植。

## 许可证

本仓库的 Greenroom 源码采用 [Apache License 2.0](LICENSE)。第三方软件和素材按各自的许可使用。本版本安装时不捆绑任何创作插件或模型服务端。

以下是评估旧版集成时核对过的上游许可，供后续开发独立接入时参考。

| 组件 | 对应上游许可 |
| --- | --- |
| AID Studio、Lemo Opuscar | MIT。按各自项目的要求保留版权和许可声明。 [AID Studio](https://github.com/shijue-aid/aid-studio/blob/804a775dd03cfb144a8218b3a6fdea876c7e8066/LICENSE) · [Lemo Opuscar](https://github.com/lemomo-ai/lemo-opuscar/blob/143f387ad774525dc9abc0ff05fb5f4bfbaa5f02/LICENSE) |
| OpenSlop | Apache-2.0。 [OpenSlop](https://github.com/openslop/openslop/blob/8848790b15730b63f601e8795790880379660c5f/LICENSE) |
| ArcReel、魔因漫创、OpenMontage | AGPL 第 3 版。改造、分发和提供网络服务前，应逐个核对组件与组合方式的源码义务。 [ArcReel](https://github.com/ArcReel/ArcReel/blob/afdb2091af79c154f87c3a1683bfb5d2ddd75493/LICENSE) · [魔因漫创](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/LICENSE) · [OpenMontage](https://github.com/OpenMontageInc/OpenMontage/blob/fecb9a1e3cc23ef84de30b272059457a427f16f8/LICENSE) |
| Hypit | 自定义协议。对第三方多租户服务与商业再分发有额外限制。 [Hypit](https://github.com/hypit-ai/hypit/blob/25454bed40bbb09eaf675e217ed9901fa8ef4f2a/LICENSE) |
