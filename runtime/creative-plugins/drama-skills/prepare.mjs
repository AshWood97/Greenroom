import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const integration = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || '.');
mkdirSync(join(root, 'greenroom'), { recursive: true });
for (const file of ['server.py', 'breakdown.py', 'edit_worker.py', 'managed.js', 'tools.json', 'adapter.mjs', 'manifest.json', 'Dockerfile', 'prepare.mjs']) {
  cpSync(join(integration, file), join(root, 'greenroom', file));
}
for (const skill of readdirSync(join(root, 'skills'))) {
  const path = join(root, 'skills', skill, 'SKILL.md');
  const source = readFileSync(path, 'utf8');
  const frontmatter = source.match(/^---\n[\s\S]*?\n---\n/);
  const note = `\n## Greenroom 受管执行\n\n先调用 greenroom_select_plugins 选择 drama-skills。本套件在 DSH 中按需加载，保留原创作规则与引用资料。以下托管规则覆盖正文和引用中的终端、供应商配置、摘要校验及导出命令：\n\n- 先调用 mcp__greenroom__drama_skills_read_knowledge 读取本 Skill 的所需 references/assets；只读知识资源通过该工具获得。\n- 大文件原著先用 mcp__greenroom__drama_skills_import_source 从成员已上传资产导入；原著分析使用 mcp__greenroom__drama_skills_index_source、mcp__greenroom__drama_skills_read_source_chapters 按章读取；通过 mcp__greenroom__drama_skills_write_analysis 与 mcp__greenroom__drama_skills_read_analysis 保存与恢复原分析产物。\n- 项目和分集文档使用 mcp__greenroom__drama_skills_create_project、mcp__greenroom__drama_skills_read_document、mcp__greenroom__drama_skills_write_document；正文枚举和原目录格式保持不变。用 accepted=true 仅表达用户已接受该份创作文档。\n- 图片、视频、TTS、音乐先用 mcp__greenroom__drama_skills_preview_production 展示准确任务、模型、提示词、参考、参数与输出；等待用户明确确认后调用 mcp__greenroom__drama_skills_confirm_production，再 mcp__greenroom__drama_skills_execute_production。未配置的能力明确说明不可用。\n- 参考素材先从当前成员已下载产物的 assetId/projectPath 绑定，或调用 mcp__greenroom__drama_skills_import_reference 导入已上传 Asset。referenceBindings 保留官方槽位、顺序、路径、中文名、role 和允许/禁止控制；用途必须逐字来自当前文档，视频按原 role 提交，不把首尾帧或音频降级。图片/视频必须来自 IMG/SHOT/MOTION 完整可复制正文；PLAN 不能当实际输入（SHOT 自身首帧绘制保留官方豁免）。当前官方选择器不能表达 reference_video，未配置的生成能力明确拒绝，目录未知不代表真实模型已验证。\n- 生产恢复只调用 mcp__greenroom__drama_skills_get_production，沿原平台任务编号查询。查询或下载异常不重新生成，批次逐项保留失败。\n- 剪辑使用 mcp__greenroom__drama_skills_render_episode，按原《剪辑单.md》处理。四类画面文字和字幕由免费 FFmpeg 渲染，无需安装 Remotion。归档使用 mcp__greenroom__drama_skills_archive_project。\n- 新增 short-drama-breakdown：先用 mcp__greenroom__drama_skills_register_benchmark 登记当前成员视频 Asset、允许用途/依据、外传许可与问题；mcp__greenroom__drama_skills_run_breakdown 仅运行固定免费本地测量（measure/audio/subtitle-sheet/subtitles/shots/transcript/plan/profile），传稳定 requestId，原编号用 get_breakdown 读回，不重跑未知任务。报告保存为 breakdown-report；参考原片、转写、切片都留在输入/对标，正常项目归档不包含它们。外传许可不等于调用模型；此适配没有自动看片/整集还原功能，不运行 agy。\n- 续接选择使用 mcp__greenroom__drama_skills_set_continuation_route，仅在创作者确认后保存 independent_starts 或 relay_external；待续接/不可提交条目不能投产，前者先补已接受真实起始帧并由 owner 改写正文，后者只移交创作者，不代调外部工具。\n- 不运行上游 Python/终端脚本、不调用 export/check/verify/hash 流程、不配置个人 API Key；生产操作只能经上述业务 MCP。\n\n`;
  writeFileSync(path, frontmatter ? frontmatter[0] + note + source.slice(frontmatter[0].length) : note + source);
}
const editToolPath = join(root, 'skills/short-drama-edit/scripts/edit_tool.py');
const editTool = readFileSync(editToolPath, 'utf8');
const frameLimit = 'command += ["-frames:v", str(round(length * fps)), "-t", f"{length:.6f}"]';
if (!editTool.includes(frameLimit)) throw new Error('固定剪辑帧率入口已改变');
const finalAudio = `        if delivery.loudness_lufs is not None:
            command += ["-af", _loudnorm_filter(ffmpeg, joined, delivery.loudness_lufs)]
            command += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
        else:
            command += ["-c:a", "copy"]`;
if (!editTool.includes(finalAudio)) throw new Error('固定剪辑音频交付入口已改变');
writeFileSync(editToolPath, editTool.replace(frameLimit,
  'command += ["-r", f"{fps:g}", "-frames:v", str(round(length * fps)), "-t", f"{length:.6f}"]')
  .replace(finalAudio, `        # AAC decode padding and loudnorm may outlast the picture. Bound the
        # final samples to the actual frame-rounded cut timeline, not a target.
        audio_filters = []
        if delivery.loudness_lufs is not None:
            audio_filters.append(_loudnorm_filter(ffmpeg, joined, delivery.loudness_lufs))
        audio_filters += ["aresample=48000", "asetpts=N/SR/TB", "apad",
                          f"atrim=end_sample={round(sum(spans) * 48000)}"]
        command += ["-af", ",".join(audio_filters), "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]`));
const assets = join(root, 'skills/short-drama/assets/dashboard');
let app = readFileSync(join(assets, 'app.js'), 'utf8');
const start = app.indexOf('async function establishSession() {');
const end = app.indexOf('\nconst query = ', start);
if (start < 0 || end < 0) throw new Error('固定 Dashboard 会话入口已改变');
app = app.slice(0, start) + `async function establishSession() {\n  S.apiBase = location.pathname.replace(/\\/$/, '');\n}\n` + app.slice(end);
writeFileSync(join(assets, 'app.js'), app);
let html = readFileSync(join(assets, 'index.html'), 'utf8');
const dashboardBase = JSON.parse(readFileSync(join(integration, 'manifest.json'), 'utf8')).ui.basePath;
for (const asset of ['tokens.css', 'styles.css', 'app.js']) {
  html = html.replace(`"/${asset}"`, `"${dashboardBase}${asset}"`);
}
html = html.replace('</body>', `<script type="module" src="${dashboardBase}managed.js"></script>\n</body>`);
writeFileSync(join(assets, 'index.html'), html);
cpSync(join(integration, 'managed.js'), join(assets, 'managed.js'));
const serverPath = join(root, 'skills/short-drama/scripts/dashboard_server.py');
let dashboard = readFileSync(serverPath, 'utf8');
dashboard = dashboard.replace('entry.name.casefold() == ".short-drama"', 'entry.name.casefold() in {".short-drama", ".greenroom"}')
  .replace('pure.parts[0].casefold() == ".short-drama"', 'pure.parts[0].casefold() in {".short-drama", ".greenroom"}');
writeFileSync(serverPath, dashboard);

// Managed measurements use immutable member Asset inputs and a fresh directory
// per persisted request. Do not calculate upstream content digests or reuse its
// digest-based overwrite path. The original repository is left unchanged.
const breakdownPath = join(root, 'skills/short-drama-breakdown/scripts/breakdown_tool.py');
let breakdown = readFileSync(breakdownPath, 'utf8');
const hashStart = breakdown.indexOf('def file_sha256(path: Path) -> str:');
const hashEnd = breakdown.indexOf('def measure_video(', hashStart);
if (hashStart < 0 || hashEnd < 0) throw new Error('固定拆解摘要入口已改变');
breakdown = breakdown.slice(0, hashStart) + breakdown.slice(hashEnd);
breakdown = breakdown.replace('import hashlib\n', '')
  .replaceAll('        "source_sha256": file_sha256(video),\n', '')
  .replace('"source_sha256": file_sha256(video), ', '')
  .replace(/    expected = record.get\("source_sha256"\)[\s\S]*?(?=    ffmpeg = _require)/, '')
  .replace('        "source_sha256": expected or file_sha256(video),\n', '')
  .replace(/    if target.is_file\(\):[\s\S]*?(?=    target.write_text)/, '');
if (/file_sha256|source_sha256|hashlib/.test(breakdown)) throw new Error('固定拆解摘要调用尚未移除');
// Only local files/pipes are valid: media parsers must not fetch remote playlists.
breakdown = breakdown.replaceAll('[_require("ffmpeg"), ', '[_require("ffmpeg"), "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,image2,png_pipe,jpeg_pipe", ')
  .replaceAll('[_require("ffprobe"), ', '[_require("ffprobe"), "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,image2,png_pipe,jpeg_pipe", ')
  .replaceAll('[ffmpeg, ', '[ffmpeg, "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,image2,png_pipe,jpeg_pipe", ');
writeFileSync(breakdownPath, breakdown);
