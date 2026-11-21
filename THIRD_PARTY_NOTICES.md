# 第三方声明

Greenroom 自有部分使用 Apache-2.0。依赖各自保留其版权、许可证和适用的 NOTICE。公开仓库提供接入源码、依赖锁定和构建脚本。构建器在本机下载固定的公开上游；GitHub 不发布这些构建出的镜像或二进制包。对外分发包中实际包含的组件须附带它们的许可和适用的声明。

- DeepSeek Harness 使用官方 npm 包。其传递依赖和分发说明见 [官方第三方声明](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/THIRD_PARTY_NOTICES.md)。
- AGPL 组件的未修改源码可从表中的固定上游获取。Greenroom 的集成、修改和构建脚本分别在 \`runtime/creative-plugins/arcreel\`、\`runtime/creative-plugins/moyin\`、\`runtime/creative-plugins/openmontage\`。自行改造、再分发或提供网络服务时，按各组件适用条款提供对应源码并保留声明。ArcReel 另有 [NOTICE](https://github.com/ArcReel/ArcReel/blob/afdb2091af79c154f87c3a1683bfb5d2ddd75493/NOTICE)。
- 火宝短剧为 CC BY-NC-SA 4.0。Hypit 对向第三方提供多租户服务与商业再分发另有限制。两者由用户从上游单独安装，公开版不下载、构建或启动它们。

| 组件 | 许可 | 对应源码和版本 | 接入方式 |
| --- | --- | --- | --- |
| DeepSeek Harness | [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/LICENSE) | [npm 0.2.2-rc.5](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.2-rc.5) · [上游仓库](https://github.com/deepseek-ai/deepseek-harness) | 按固定版本从 npm 安装 |
| T8 画布 | [MIT](https://github.com/T8mars/T8-penguin-canvas/blob/1d7061c0e6d2be92797b9e3f2ff0d485915e7/LICENSE) | [1d7061c0](https://github.com/T8mars/T8-penguin-canvas/tree/1d7061c0e6d2be92797b9e3f2ff0d485915e7) | 按固定公开上游本机构建 |
| 火宝短剧 | [CC-BY-NC-SA-4.0](https://github.com/chatfire-AI/huobao-drama/blob/b48e6b2312166e25b1ff141832d2e82e5d63c142/LICENSE) | [b48e6b23](https://github.com/chatfire-AI/huobao-drama/tree/b48e6b2312166e25b1ff141832d2e82e5d63c142) | 上游单独安装 |
| MoneyPrinterTurbo | [MIT](https://github.com/harry0703/MoneyPrinterTurbo/blob/c235354804104665b58679223847f78c2b5e27d4/LICENSE) | [c2353548](https://github.com/harry0703/MoneyPrinterTurbo/tree/c235354804104665b58679223847f78c2b5e27d4) | 按固定公开上游本机构建 |
| Toonflow | [MIT](https://github.com/HBAI-Ltd/Toonflow-app/blob/6086cdffceb704a632eca143dd16cd461a78cdac/LICENSE) | [6086cdff](https://github.com/HBAI-Ltd/Toonflow-app/tree/6086cdffceb704a632eca143dd16cd461a78cdac) | 按固定公开上游本机构建 |
| 影策 | [MIT](https://github.com/ddcat-ai/open-ai-canvas/blob/3ce013ec15a1a6065654986fd7f9433bf8d10b8c/LICENSE) | [3ce013ec](https://github.com/ddcat-ai/open-ai-canvas/tree/3ce013ec15a1a6065654986fd7f9433bf8d10b8c) | 按固定公开上游本机构建 |
| 魔因漫创 | [AGPL-3.0-or-later](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/LICENSE) | [7e5c5655](https://github.com/MemeCalculate/moyin-creator/tree/7e5c5655de94d49885e13c369f0a71212893a0aa) | 独立服务 |
| ArcReel | [AGPL-3.0-only](https://github.com/ArcReel/ArcReel/blob/afdb2091af79c154f87c3a1683bfb5d2ddd75493/LICENSE) | [afdb2091](https://github.com/ArcReel/ArcReel/tree/afdb2091af79c154f87c3a1683bfb5d2ddd75493) | 独立服务 |
| LocalMiniDrama | [MIT](https://github.com/xuanyustudio/LocalMiniDrama/blob/3fbcda9713ca545979dff9e75d21bed53694188f/LICENSE) | [3fbcda97](https://github.com/xuanyustudio/LocalMiniDrama/tree/3fbcda9713ca545979dff9e75d21bed53694188f) | 按固定公开上游本机构建 |
| AID Studio | [MIT](https://github.com/shijue-aid/aid-studio/blob/804a775dd03cfb144a8218b3a6fdea876c7e8066/LICENSE) | [804a775d](https://github.com/shijue-aid/aid-studio/tree/804a775dd03cfb144a8218b3a6fdea876c7e8066) | 按固定公开上游本机构建 |
| Kineo | [MIT](https://github.com/Agions/kineo/blob/45572564546fe885bf5b76adccccc9b073f7c5af/LICENSE) | [45572564](https://github.com/Agions/kineo/tree/45572564546fe885bf5b76adccccc9b073f7c5af) | 按固定公开上游本机构建 |
| OpenSlop | [Apache-2.0](https://github.com/openslop/openslop/blob/8848790b15730b63f601e8795790880379660c5f/LICENSE) | [8848790b](https://github.com/openslop/openslop/tree/8848790b15730b63f601e8795790880379660c5f) | 按固定公开上游本机构建 |
| ViMax | [MIT](https://github.com/HKUDS/ViMax/blob/fd4b72e7731be6e5f88486206d25ea59849b0285/LICENSE) | [fd4b72e7](https://github.com/HKUDS/ViMax/tree/fd4b72e7731be6e5f88486206d25ea59849b0285) | 按固定公开上游本机构建 |
| OpenMontage | [AGPL-3.0-only](https://github.com/OpenMontageInc/OpenMontage/blob/fecb9a1e3cc23ef84de30b272059457a427f16f8/LICENSE) | [fecb9a1e](https://github.com/OpenMontageInc/OpenMontage/tree/fecb9a1e3cc23ef84de30b272059457a427f16f8) | 独立服务 |
| Drama Skills | [MIT](https://github.com/zenstory-ai/drama-skills/blob/3d813c30871b4db5f2387d83bdc3a49db8ce7b2b/LICENSE) | [3d813c30](https://github.com/zenstory-ai/drama-skills/tree/3d813c30871b4db5f2387d83bdc3a49db8ce7b2b) | 按固定公开上游本机构建 |
| Shuohao Skills | [Apache-2.0](https://github.com/eternityspring/shuohao-skills/blob/8af10e0ea1a550e4575666884f4deef780bf38ff/LICENSE) | [8af10e0e](https://github.com/eternityspring/shuohao-skills/tree/8af10e0ea1a550e4575666884f4deef780bf38ff) | 按固定公开上游本机构建 |
| Lemo Opuscar | [MIT · 素材另有许可](https://github.com/lemomo-ai/lemo-opuscar/blob/143f387ad774525dc9abc0ff05fb5f4bfbaa5f02/LICENSE) | [143f387a](https://github.com/lemomo-ai/lemo-opuscar/tree/143f387ad774525dc9abc0ff05fb5f4bfbaa5f02) | 按固定公开上游本机构建 |
| 漫剧老李 | [MIT](https://github.com/lixiaoxiao9888-create/manju-laoli-skill/blob/ffa717b83f21fecb968d7697690196486a65332c/LICENSE) | [ffa717b8](https://github.com/lixiaoxiao9888-create/manju-laoli-skill/tree/ffa717b83f21fecb968d7697690196486a65332c) | 按固定公开上游本机构建 |
| 短剧 Skill 查找 | [CC0-1.0](https://github.com/UnderleveledBuilder/awesome-short-drama-skills/blob/9a1f686460c0a03cb0df40c3d2e55739568911dc/LICENSE) | [9a1f6864](https://github.com/UnderleveledBuilder/awesome-short-drama-skills/tree/9a1f686460c0a03cb0df40c3d2e55739568911dc) | 按固定公开上游本机构建 |
| 导演 Skills | [MIT](https://github.com/kangarooking/director-skills/blob/301e6e72199f28b8ea82cd48ff06ab9ae49d0ee5/LICENSE) | [301e6e72](https://github.com/kangarooking/director-skills/tree/301e6e72199f28b8ea82cd48ff06ab9ae49d0ee5) | 按固定公开上游本机构建 |
| 首映创作室 | [MIT · 依赖另有许可](https://github.com/talsiach/take-one/blob/43fd27b8878241deb50a5884a154b173272b858f/LICENSE) | [43fd27b8](https://github.com/talsiach/take-one/tree/43fd27b8878241deb50a5884a154b173272b858f) | 按固定公开上游本机构建 |
| ManjuForge | [MIT-0](https://github.com/mengxiujie/ManjuForge/blob/e6a42b29dbc19cdd315fa54ebed38c43247d74eb/LICENSE) | [e6a42b29](https://github.com/mengxiujie/ManjuForge/tree/e6a42b29dbc19cdd315fa54ebed38c43247d74eb) | 按固定公开上游本机构建 |
| Hypit | [自定义许可](https://github.com/hypit-ai/hypit/blob/25454bed40bbb09eaf675e217ed9901fa8ef4f2a/LICENSE) | [25454bed](https://github.com/hypit-ai/hypit/tree/25454bed40bbb09eaf675e217ed9901fa8ef4f2a) | 上游单独安装 |

- 本地素材服务在 [runtime/local-asset-service](runtime/local-asset-service) 单独运行，使用 [AGPL-3.0-only](runtime/local-asset-service/LICENSE)；对应源码位于同目录。
- [ArcReel NOTICE](runtime/creative-plugins/arcreel/NOTICE)、[魔因漫创 NOTICE](runtime/creative-plugins/moyin/NOTICE)、[Shuohao Skills NOTICE](runtime/creative-plugins/shuohao-skills/NOTICE) 随接入源码保留。
