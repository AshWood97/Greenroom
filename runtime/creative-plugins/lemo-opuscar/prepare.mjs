import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareKnowledge } from '../aigc-shared/prepare.mjs';

const integration = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2]);
const target = join(source, 'managed-skills/lemo-opuscar');
mkdirSync(join(target, 'references/library'), { recursive: true });
const textFile = path => /\.(md|txt|json|csv|js|mjs|cjs|ts|py|sh|html|css|svg)$/i.test(path) || /(?:LICENSE|NOTICE|CREDITS)(?:[_.-][^/]*)?$/.test(path);
function copyKnowledge(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) if (!name.startsWith('.') && name !== 'node_modules') copyKnowledge(join(from, name), join(to, name));
  } else if (textFile(from)) cpSync(from, to);
}
for (const name of ['AGENTS.md', 'DIRECTOR.md', 'TECHNIQUE.md', 'MY-STYLES.md', 'styles', 'core']) copyKnowledge(join(source, name), join(target, 'references/library', name));
cpSync(join(source, 'LICENSE'), join(target, 'LICENSE'));
cpSync(join(source, 'plugin/skills/lemo-opuscar/SKILL.md'), join(target, 'SKILL.md'));
const catalog = JSON.parse(readFileSync(join(source, 'styleboard/catalog.json'), 'utf8'));
writeFileSync(join(target, 'references/styles.json'), JSON.stringify(catalog, null, 2));
mkdirSync(join(target, 'assets/stills'), { recursive: true });
for (const item of catalog) {
  const still = join(source, 'styleboard/img', item.slug + '_0.jpg');
  if (existsSync(still)) cpSync(still, join(target, 'assets/stills', item.slug + '.jpg'));
}
writeFileSync(join(target, 'assets/ATTRIBUTION.md'), `# 示例画面署名\n\nLemoLab, Lemo-Opuscar, https://github.com/lemomo-ai/lemo-opuscar/tree/143f387ad774525dc9abc0ff05fb5f4bfbaa5f02 。示例静帧按 CC BY 4.0 提供（https://creativecommons.org/licenses/by/4.0/），仅调整文件位置，未修改画面。第三方资料保留各 demo/CREDITS。Memphis Diorama 的风格及示例作者为 Eian（https://github.com/YIAN6557），贡献见上游 #14 与 references/library/styles/memphis-diorama/demo/CREDITS。\n\n未分发任何示例影片、音频或语音轨；上游明确排除 Chalkboard、Circuit Board、Desktop Flythrough、Isometric Picture Book、Printed Long Take 的 Edge TTS 和 Broadcast News Package 的 Doubao TTS 六条语音轨。引用源码仅供技术阅读；源码出现的上述音轨路径不表示素材已获授权或可用。用户自己的影片无需 LemoLab 画面署名；复用示例静帧仍需上述署名。\n`);
mkdirSync(join(target, 'greenroom'), { recursive: true });
cpSync(join(integration, 'scripts/audio.mjs'), join(target, 'greenroom/audio.mjs'));
await copyRuntimeResources(source, target);
await prepareKnowledge({ root: target, id: 'lemo-opuscar', prefix: 'lemo_opuscar', skillFiles: ['SKILL.md'], notes: `- 保留全部 ${catalog.length} 种风格、DIRECTOR/TECHNIQUE、原 demo 源码和 MY-STYLES 创作方法，按 read_knowledge 的 references/library 路径读取。例片源码仅供技术阅读，不执行其 build.sh 或维护检查。示例静帧须按 assets/ATTRIBUTION.md 署名；示例音轨均未分发。\n- 自建风格：先在 style/style_changes/style_demo 文档中迭代，经用户确认后 lemo_opuscar_save_style，之后 list_styles/read_style 可在后续会话使用；不写上游库。\n- 代码制片只把完整自包含 HTML 写入 film 文档，接受当前稿后准备 kind=render，parameters 指定 width/height/fps/duration。页面提供 window.READY=true 和 window.render(t)；运行所需资源必须本地。/core 为固定 Lemo 辅助和字体，/vendor/three 为固定 Three.js；其余素材通过 import_asset 导入后以 assets/<assetId>.<扩展名> 引用，并列入 referenceAssetIds。\n- HTML/JS 只在隔离 aigc-render Job 的 Chromium 内执行；不得在 DSH 或审阅页预览、导入、执行成员代码，不运行用户 build.sh、npm、shell 或下载脚本。生产失败显示真实原因，未知不能当作成功。\n- 代码音乐使用 audio_score 文档的 JSON 音符（duration 和 notes，每音符 at/duration/frequency/velocity/wave/pan），接受文档后调用 process_audio(operation=synthesize)；已有音频用固定 trim/mix/concat 参数处理。TTS/模型音乐/图片/视频经管理员 prepare/confirm/execute_production；本地采样库下载、外部平台和产品录屏当前不可用。原文的自测、哈希、并行代理或外部工具命令不会自动执行。` });

async function copyRuntimeResources(library, skill) {
  const runtime = join(skill, 'assets/runtime');
  mkdirSync(join(runtime, 'core'), { recursive: true });
  for (const name of ['lib.js', 'post', 'three', 'fonts', 'assets']) cpSync(join(library, 'core', name), join(runtime, 'core', name), { recursive: true });
  const three = join(library, 'node_modules/three');
  if (!existsSync(join(three, 'build/three.module.js'))) throw new Error('构建阶段须先为固定 Lemo 上游 npm ci --ignore-scripts --omit=dev');
  mkdirSync(join(runtime, 'vendor'), { recursive: true });
  cpSync(three, join(runtime, 'vendor/three'), { recursive: true });
  cpSync(join(library, 'LICENSE'), join(runtime, 'core/LICENSE'));
}
