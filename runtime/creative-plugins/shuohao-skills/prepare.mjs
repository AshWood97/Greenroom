import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareKnowledge } from '../aigc-shared/prepare.mjs';

async function reviseKnowledge(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await reviseKnowledge(path);
    else if (entry.name.endsWith('.md')) {
      let source = await readFile(path, 'utf8');
      source = source.replaceAll('sha256', 'revision').replaceAll('SHA-256', 'revision')
        .replaceAll('文字描述指纹', '文字描述revision').replaceAll('文字指纹', '文字revision')
        .replaceAll('画风指纹', '画风revision').replaceAll('文件指纹', '引用revision')
        .replaceAll('layersHash', 'layersRevision').replaceAll('lookHash', 'lookRevision');
      await writeFile(path, source);
    }
  }
}
await prepareKnowledge({
  root: process.argv[2], id: 'shuohao-skills', prefix: 'shuohao_skills', productionKinds: ['image'],
  notes: `七个原生Skill及其分层字段、改编/角色/美术/剧本/站位/分镜方法、references、示例、Apache-2.0许可证及NOTICE保留。六个novel流程只用mcp__greenroom__shuohao_skills_outline、cast、art、script、staging、storyboard的固定operation枚举；原脚本切块后用read_source_chunk按kind和index读取；源文档及逐张角色卡/名册通过注册文档保存。报告用build_report，分镜原生export只导出提示词包，不提交视频任务。所有脚本固定来自只读镜像，不运行install/selftest/门日志维护。
角色图只走平台管理员托管image服务。先set_character_intake，原样展示其确认表，保留stated/inferred/default标记；年龄、性别、年代不明时依原规则询问。用户确认当前revision后confirm_character_intake。整剧画风统一，默认原生动漫；换画风用set_character_style，支持原生自定义画风快照。使用prepare_character_views准备准确任务，展示后等待用户明确确认当前jobId，再confirm_production/execute_production；不得直接用通用prepare_production绕过角色入口。首次只出正面全身锚点，get_character取回真实产物供用户查看，再confirm_character_anchor确认具体version，之后才准备大头照/侧面/背面及按需细节图。所有派生图引用当前锚点，原规定的头发/脸/领口细节可额外引用当前正脸大头照。get_character和get_production沿原平台任务ID恢复并保留逐项失败，旧图不遮盖本次失败。输入、画风及引用过期由显式revision比较，不计算文件摘要、指纹或校验。禁止上游本机Codex、ComfyUI、OpenAI个人Key、自定义命令和本地配置入口；原models.mjs已替换为不可执行通道说明。角色报告用render_character_report；未目视的长相/角度/取景不得声称已核验。`,
  async patch(root) {
    const directory = join(root, 'skills/character-refs');
    const path = join(directory, 'scripts/core.mjs');
    let core = await readFile(path, 'utf8');
    if (!core.includes('// greenroom-revision-refs')) {
      core = core.replace("import { createHash } from 'node:crypto';\n", '')
        .replace("export const sha256 = (x) => createHash('sha256').update(x).digest('hex');\n", '');
      const start = core.indexOf('/** 文字层指纹');
      if (start >= 0) {
        const end = core.indexOf('/* ------------------------------------------------------------------ */', start);
        core = core.slice(0, start) + '// 来源变化由受管工程显式递增的layersRevision、lookRevision及参考revision记录。\n\n' + core.slice(end);
      }
      core = core.replace('    name: x.name,', '    name: x.name,\n    layersRevision: 1,')
        .replace('        views: {},', '        lookRevision: 1,\n        views: {},')
        .replace("  const L = resolveLayers(asset, outfitId);\n  if (cur.layersHash !== viewLayersHash(L, allViews(outfit)[viewId])) why.push({ code: 'layers' });", "  if (cur.layersRevision !== (asset.layersRevision ?? 1)) why.push({ code: 'layers' });")
        .replace("  if (cur.lookHash !== lookHash(outfit.look)) why.push({ code: 'look' });", "  if (cur.lookRevision !== (outfit.lookRevision ?? 1)) why.push({ code: 'look' });")
        .replace('now.v !== r.v || now.sha256 !== r.sha256', 'now.v !== r.v || now.revision !== r.revision')
        .replace('refs.push({ view: rv, v: cur.v, sha256: cur.sha256, file: cur.file });', 'refs.push({ view: rv, v: cur.v, revision: cur.revision, file: cur.file, assetId: cur.assetId });')
        .replace('sha256: sha256(out), model, seed,', 'revision: v, model, seed,')
        .replace('refs.map(({ view: rv, v: rvv, sha256: rs }) => ({ view: rv, v: rvv, sha256: rs }))', 'refs.map(({ view: rv, v: rvv, revision, assetId }) => ({ view: rv, v: rvv, revision, assetId }))')
        .replace('layersHash: viewLayersHash(resolveLayers(asset, oid), spec), lookHash: lookHash(outfit.look),', 'layersRevision: asset.layersRevision ?? 1, lookRevision: outfit.lookRevision ?? 1,')
        .replaceAll('文字指纹、画风指纹、参考图版本与文件指纹', '文字revision、画风revision、参考图版本与revision');
      core = '// greenroom-revision-refs\n' + core;
      await writeFile(path, core);
    }
    const models = `// Greenroom只允许由平台托管image任务；原本机及个人供应商入口不参与执行。\nconst unavailable = () => { throw new Error('请通过shuohao_skills_prepare_character_views及确认后的平台任务生成角色图'); };\nexport const CONFIG_PATH = null;\nexport const configMissing = () => [];\nexport const loadConfig = unavailable;\nexport const saveConfig = unavailable;\nexport const maskConfig = () => ({ managed: true, confirmAnchor: true });\nexport const modelKind = unavailable;\nexport const generate = unavailable;\n`;
    await writeFile(join(directory, 'scripts/models.mjs'), models);
    const cliPath = join(directory, 'scripts/character-refs.mjs');
    let cli = await readFile(cliPath, 'utf8');
    cli = cli.replace(": '<span class=\"ok\">✓</span>';", ": cur.inspection === 'not_run' ? '<span class=\"dim\">未运行本地图像检查 / local checks not run</span>' : '<span class=\"ok\">✓</span>';");
    await writeFile(cliPath, cli);
    await reviseKnowledge(directory);
    const skillPath = join(directory, 'SKILL.md');
    let skill = await readFile(skillPath, 'utf8');
    skill = skill.replace('支持 Qwen Image（ComfyUI）、codex 内置出图、OpenAI Images API（GPT Image 2）和自定义命令，主图与派生图可以使用不同模型。', '图片由Greenroom管理员托管的image模型生成；主图与派生图可选择不同的已授权模型。')
      .replace(/### Step 0 — 初次设置（每台机器一次）[\s\S]*?(?=### Step 1 — 一次性输入)/, '### Step 0 — 平台托管设置\n\n本机模型、个人Key、自定义命令及config.local.json入口不在平台执行。模型由管理员配置，角色输入与锚点确认沿本Skill原规则保留，使用本文件开头的固定MCP操作。\n\n');
    await writeFile(skillPath, skill);
  },
});
