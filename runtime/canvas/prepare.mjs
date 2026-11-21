// Apply the Greenroom integration to the pinned upstream Web source before building.
import { readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const source = resolve(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
function edit(name, transform) {
  const file = join(source, name);
  writeFileSync(file, transform(readFileSync(file, 'utf8')));
}
function prefixFrontend(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) prefixFrontend(file);
    else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      const text = readFileSync(file, 'utf8');
      writeFileSync(file, text.replace(/(["'`])\/(api|assets|artist-style-master|official-skills|previs-studio)\//g, '$1/canvas/$2/'));
    }
  }
}
prefixFrontend(join(source, 'src'));
edit('src/i18n/resources.ts', (text) => text
  .replace('贞贞的AI工坊-独立LLM Key（默认）', '管理员托管 LLM 通道（默认）')
  .replace('使用“贞贞的平价AI小屋 API Key”，接口为 api.seedance.nz。', '该通道的 API 接入由管理员统一管理，无需在插件内配置。'));
edit('src/App.tsx', (text) => text
  .replace('Moon, Settings, Sun', 'Moon, Sun')
  .replace("const ApiSettingsModal = lazy(() => import('./components/ApiSettings'));\n", '')
  .replace('  const [settingsOpen, setSettingsOpen] = useState(false);\n', '')
  .replace("  const [apiSettingsMode, setApiSettingsMode] = useState<'full' | 'creator'>('full');\n", '')
  .replace('  const [apiSettingsRevision, setApiSettingsRevision] = useState(0);', '  const apiSettingsRevision = 0;')
  .replace(/          <button\n            onClick=\{\(\) => \{\n              setApiSettingsMode\('full'\);[\s\S]*?<\/button>\n/, '')
  .replace(/              onOpenApiSettings=\{\(\) => \{[\s\S]*?\n              \}\}/, '')
  .replace(/        \{settingsOpen && <ApiSettingsModal[\s\S]*?\n        \}\} \/>\}\n/, ''));
edit('src/utils/runPreflightContext.ts', (text) => text.replace(
  "function builtInCredentialNotice(node: Node, settings: ApiSettings): RunPreflightDiagnosticInput | null {\n  const data = (node.data || {}) as Record<string, unknown>;",
  "function builtInCredentialNotice(node: Node, settings: ApiSettings): RunPreflightDiagnosticInput | null {\n  const data = (node.data || {}) as Record<string, unknown>;\n  if (data.model === 'greenroom-image' || data.mainId === 'greenroom-video' || node.type === 'llm' || node.type === 'batch-tagger') return null;")
  .replace('  const { source } = selectedProviderFields(node);\n\n  if (node.type === \'story\') {',
    "  const { source } = selectedProviderFields(node);\n  if (node.type === 'story' && (!source || source === 'zhenzhen') && data.llmApiSource !== 'seedance-nz') return null;\n  if (['minimax-h3-prompt-enhancer', 'minimax-music3-prompt-enhancer', 'seedance20-prompt-enhancer'].includes(node.type || '') && data.llmApiSource === 'zhenzhen') return null;\n\n  if (node.type === 'story') {")
  .replace("  if (['runninghub', 'runninghub-wallet', 'rh-tools', 'rh-toolbox'].includes(String(node.type || ''))) {",
    `  if (['runninghub', 'runninghub-wallet', 'rh-tools', 'rh-toolbox', 'greenroom-selected'].includes(String(node.type || ''))) {
    if ((['rh-tools', 'greenroom-selected'].includes(String(node.type || '')) && data.rhToolsActiveAppId === 'greenroom-rh-upscale')
        || (['runninghub', 'runninghub-wallet'].includes(String(node.type || ''))
            && data.webappId === 'greenroom-rh-upscale')) return null;`));
edit('src/services/api.ts', (text) => text.replace("const BASE = '/api';", "const BASE = '/canvas/api';"));
edit('src/components/Canvas.tsx', (text) => "import { greenroomNodeDefaults } from '../greenroom';\n" + text
  .replace('ready={creatorAgentCanvasReady}', 'ready={false}')
  .replace(/\.\.\.\(INITIAL_DATA\[([^\]]+)\] \|\| \{\}\)/g,
    '...(INITIAL_DATA[$1] || {}), ...(greenroomNodeDefaults[$1] || {})')
  .replace("const RHToolsNode = lazyCanvasNode(() => import('./nodes/RHToolsNode'), 'RHToolsNode');",
    "const RHToolsNode = lazyCanvasNode(() => import('./nodes/RHToolsNode'), 'RHToolsNode');\nconst GreenroomSelectedNode = lazyCanvasNode(() => import('./nodes/GreenroomSelectedNode'), 'GreenroomSelectedNode');")
  .replace("  'rh-tools': RHToolsNode,",
    "  'rh-tools': RHToolsNode,\n  'greenroom-selected': GreenroomSelectedNode,")
  .replace("  // RH 工具节点（v1.2.10.1+）：启动器状态字段",
    `  'greenroom-selected': {
    reuseResult: false,
    rhToolsActiveCategoryId: 'all',
    rhToolsActiveAppId: '',
    rhToolsSearchQuery: '',
    appInfo: null,
    paramValues: {},
    materialOrder: [],
    instanceType: '',
    status: 'idle',
    taskId: '',
    urls: [],
    error: '',
    rhCode: 0,
    imageUrl: '',
    videoUrl: '',
    audioUrl: '',
  },
  // RH 工具节点（v1.2.10.1+）：启动器状态字段`));
edit('src/utils/mediaNodeDefaults.ts', (text) => "import { greenroomNodeDefaults } from '../greenroom';\n" + text
  .replace('  const preserved = { ...base, ...explicit };',
    "  const preserved = { ...base, ...explicit };\n  if (intent === 'blank' && greenroomNodeDefaults[type]) return { ...base, ...greenroomNodeDefaults[type], ...explicit };"));
edit('src/components/Sidebar.tsx', (text) => text
  .replace("  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});",
    "  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => Object.keys(NODE_GROUPS).reduce<Record<string, boolean>>((acc, k) => { acc[k] = k !== 'rh'; return acc; }, {}));")
  .replace("  const toggle = (key: string) => setCollapsed((s) => ({ ...s, [key]: !s[key] }));",
    "  const toggle = (key: string) => setCollapsed((s) => ({ ...s, [key]: !(s[key] ?? (key !== 'rh')) }));")
  .replace("          const isCollapsed = collapsed[key];",
    "          const isCollapsed = keyword.trim() ? false : (collapsed[key] ?? (key !== 'rh'));")
  .replace("    const colorHex = COLOR_HEX[n.color] || COLOR_HEX.slate;\n    return (",
    "    const colorHex = COLOR_HEX[n.color] || COLOR_HEX.slate;\n    const isFeatured = n.type === 'greenroom-selected';\n    return (")
  .replace("        className={`t8-sidebar-node w-full text-left flex items-center gap-2 px-2 py-1.5 transition-colors text-xs ${\n          isPixel\n            ? 'px-row'\n            : `rounded-md ${\n                isDark\n                  ? 'hover:bg-white/10 text-zinc-200'\n                  : 'hover:bg-black/5 text-zinc-800'\n              }`\n        }`}",
    "        className={`t8-sidebar-node w-full text-left flex items-center gap-2 px-2 py-1.5 transition-colors text-xs ${\n          isPixel\n            ? 'px-row'\n            : `rounded-md ${\n                isDark\n                  ? 'hover:bg-white/10 text-zinc-200'\n                  : 'hover:bg-black/5 text-zinc-800'\n              }`\n        } ${isFeatured ? 'font-semibold' : ''}`}\n        style={isFeatured && !isPixel ? { border: `2px solid ${colorHex}`, background: `${colorHex}1a`, boxShadow: `0 0 10px ${colorHex}40` } : undefined}")
  .replace("                  background: colorHex + '22',\n                  color: colorHex,\n                  boxShadow: `inset 0 0 0 1px ${colorHex}55`,",
    "                  background: isFeatured ? colorHex + '33' : colorHex + '22',\n                  color: colorHex,\n                  boxShadow: isFeatured ? `inset 0 0 0 2px ${colorHex}, 0 0 8px ${colorHex}80` : `inset 0 0 0 1px ${colorHex}55`,"));
edit('src/types/canvas.ts', (text) => text.replace("  | 'rh-tools'", "  | 'rh-tools'\n  | 'greenroom-selected'"));
edit('src/i18n/nodeCatalog.ts', (text) => text.replace(
  "  'rh-tools': { label: 'RH Marketplace', description: 'Browse, search, and run categorized RunningHub AI applications from one launcher.' },",
  "  'rh-tools': { label: 'RH Marketplace', description: 'Browse, search, and run categorized RunningHub AI applications from one launcher.' },\n  'greenroom-selected': { label: 'greenroom Selection', description: 'Curated RunningHub AI applications selected by greenroom.' },"));
edit('src/utils/nodePlacement.ts', (text) => text.replace(
  "  'rh-tools': { w: 360, h: 460 },",
  "  'rh-tools': { w: 360, h: 460 },\n  'greenroom-selected': { w: 360, h: 460 },"));
edit('src/utils/reuseGenerationResult.ts', (text) => text.replace(
  "  | 'rh-tools'",
  "  | 'rh-tools'\n  | 'greenroom-selected'"));
edit('backend/src/shared/canvasNodeSchema.json', (text) => text
  .replace('    "rh-tools": {', `    "greenroom-selected": {
      "resolver": "static",
      "inputs": [
        {
          "id": null,
          "kinds": [
            "text",
            "image",
            "video",
            "audio"
          ],
          "required": false,
          "minConnections": 0,
          "maxConnections": null
        }
      ],
      "outputs": [
        {
          "id": null,
          "kinds": [
            "image",
            "video",
            "audio"
          ],
          "required": false,
          "minConnections": 0,
          "maxConnections": null
        }
      ]
    },
    "rh-tools": {`)
  .replace('    {\n      "type": "runninghub",',
    `    {\n      "type": "greenroom-selected",\n      "label": "Greenroom 严选",\n      "category": "rh",\n      "description": "Greenroom 严选 RunningHub AI 应用，在节点内分类浏览 / 拼音搜索 / 一键运行",\n      "icon": "Sparkles",\n      "color": "amber",\n      "ports": {\n        "inputs": [\n          "text",\n          "image",\n          "video",\n          "audio"\n        ],\n        "outputs": [\n          "image",\n          "video",\n          "audio"\n        ]\n      },\n      "executable": true,\n      "generatable": false,\n      "generation": {\n        "allowedDataFields": {\n          "reuseResult": {\n            "type": "boolean"\n          }\n        },\n        "defaults": {\n          "reuseResult": false\n        }\n      }\n    },\n    {\n      "type": "runninghub",`));
edit('vite.config.ts', (text) => text.replace('plugins: [react(), localExtensionsPlugin()],',
  "base: '/canvas/',\n  plugins: [react(), localExtensionsPlugin()],"));
edit('src/providers/models.ts', (text) => text.replace("export const DEFAULT_LLM_MODEL = 'gemini-3.5-flash';",
  "export let DEFAULT_LLM_MODEL = 'gemini-3.5-flash';\nexport function setGreenroomDefaultLlm(id: string) { DEFAULT_LLM_MODEL = id; }"));
copyFileSync(join(here, 'greenroom.ts'), join(source, 'src/greenroom.ts'));
copyFileSync(join(here, 'runninghub.ts'), join(source, 'src/greenroomRunninghub.ts'));
const generationErrorSource = readFileSync(join(here, '../shared/generation-error.ts'), 'utf8');
writeFileSync(join(source, 'src/utils/greenroomGenerationError.ts'), generationErrorSource);
const { transformSync, buildSync } = createRequire(join(source, 'package.json'))('esbuild');
writeFileSync(join(source, 'backend/src/utils/greenroomGenerationError.js'),
  transformSync(generationErrorSource, { loader: 'ts', format: 'cjs', target: 'node24' }).code);
edit('src/services/generation.ts', (text) =>
  "import { formatGenerationError, generationErrorText } from '../utils/greenroomGenerationError';\n" + text
    .replace(`  const error = new Error(normalizeProviderErrorMessage(
    [data?.error, data?.message],
    fallback || \`HTTP \${response.status}\`,
  )) as Error & Record<string, any>;`,
      `  const cause = generationErrorText({ ...data, httpStatus: response.status });
  const error = new Error(formatGenerationError(cause, fallback)) as Error & Record<string, any>;`)
    .replace("const data = await r.json();\n  if (!r.ok) throw providerResponseError(r, data);",
      "const data = await safeJsonResponse(r, '任务状态查询');\n  if (!r.ok || (data.success === false && !data.data?.status && !data.status)) throw providerResponseError(r, data);")
    .replace("progress: '0%', error: data?.error },",
      "progress: '0%', error: generationErrorText(data) },")
    .replaceAll("const data = await r.json();\n  if (!r.ok || !data.success) throw providerResponseError(r, data);",
      "const data = await safeJsonResponse(r, '生成服务');\n  if (!r.ok || !data.success) throw providerResponseError(r, data);")
    .replace(/(export async function (?:queryImageStatus|queryVideo|queryRh)\([^\n]*\): Promise<[^>]+> \{)([\s\S]*?)(\n\})/g,
      `$1\n  try {$2\n  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(), {
      message: '任务状态查询失败（未确认生成结果）：' + generationErrorText(error),
    });
  }$3`)
    .replace(/    const contentType = response.headers.get\('content-type'\)[\s\S]*?    throw new Error\(`\$\{label\} 返回了非 JSON 响应[\s\S]*?\);/,
      "    throw new Error(`${label} 返回非 JSON 响应（HTTP ${response.status}）`);"));

// The persisted node error is also the source after refresh or recovery.
for (const node of ['ImageNode', 'VideoNode', 'RunningHubNode', 'RHToolsNode']) {
  edit('src/components/nodes/' + node + '.tsx', (text) =>
    "import { formatGenerationError" + (node === 'ImageNode' ? '' : ', generationErrorText') + " } from '../../utils/greenroomGenerationError';\n" + text
      .replace('  const d = data as any;',
        '  const d = data as any;\n  const visibleGenerationError = error || d?.error;')
      .replace('  const visibleGenerationError = error || d?.error;', node === 'RHToolsNode'
        ? '' : '  const visibleGenerationError = error || d?.error;')
      .replace('  const [error, setError] = useState<string | null>(null);',
        '  const [error, setError] = useState<string | null>(null);' + (node === 'RHToolsNode'
          ? '\n  const visibleGenerationError = error || d?.error;' : ''))
      .replace('{error && (', '{visibleGenerationError && (')
      .replace('<span className="break-all">{error}</span>',
        '<span className="break-all whitespace-pre-wrap">{formatGenerationError(visibleGenerationError)}</span>')
      .replace('<span className="break-all">{normalizeProviderErrorMessage(error, \'生成失败\')}</span>',
        '<span className="break-all whitespace-pre-wrap">{formatGenerationError(visibleGenerationError)}</span>')
      .replace("const msg = e?.message || '生成失败';", 'const msg = formatGenerationError(e);')
      .replace("normalizeProviderErrorMessage(r.failReason, '生成失败')",
        'formatGenerationError({ error: r.failReason, code: (r as any).code })')
      .replace("normalizeProviderErrorMessage(r.error, 'FAL 生成失败')",
        'formatGenerationError({ error: r.error, code: (r as any).code })')
      .replace("throw new Error(q.error || '任务失败');",
        'throw new Error(formatGenerationError({ error: q.error, code: q.code }));')
      .replace('throw new Error(query.error || `${seedanceNzProviderLabel}${imageFamilyLabel} 任务失败`);',
        'throw new Error(formatGenerationError({ error: query.error, code: (query as any).code }));')
      .replace("throw new Error(`MJ 失败: ${q.failReason || '未知错误'}`);",
        'throw new Error(formatGenerationError(q.failReason));')
      .replace("setError(e?.message || '提交失败');", 'setError(formatGenerationError(e));')
      .replace("setVisibleError(e?.message || '提交失败');", 'setVisibleError(formatGenerationError(e));')
      .replace("update({ status: 'error', error: e?.message });",
        "update({ status: 'error', error: formatGenerationError(e) });"));
}

for (const node of ['VideoNode', 'RunningHubNode', 'RHToolsNode']) {
  edit('src/components/nodes/' + node + '.tsx', (text) => {
    const show = node === 'RHToolsNode' ? 'setVisibleError' : 'setError';
    return text
      .replaceAll('      let pollInFlight = false;', '      let pollInFlight = false;\n      let lastQueryError = \'\';')
      .replace(/          update\(\{ status: 'error', error: '(?:FAL )?轮询超时' \}\);[\s\S]*?          (reject|finish)\((?:false, )?new Error\('(?:FAL )?轮询超时'\)\);/g,
        `          const message = lastQueryError || '任务状态查询超时（未确认生成结果）';
          update({ status: 'error', error: message });
          ${show}(message);
          ${node === 'VideoNode' ? 'reject(new Error(message));' : 'finish(false, new Error(message));'}`)
      .replaceAll("          console.warn('轮询出错', e?.message);",
        `          lastQueryError = generationErrorText(e);
          if (!lastQueryError.includes('未确认生成结果')) lastQueryError = '任务状态查询失败（未确认生成结果）：' + lastQueryError;
          update({ error: lastQueryError });
          ${show}(lastQueryError);`)
      .replaceAll("          console.warn('FAL 轮询出错', e?.message);",
        `          lastQueryError = generationErrorText(e);
          if (!lastQueryError.includes('未确认生成结果')) lastQueryError = '任务状态查询失败（未确认生成结果）：' + lastQueryError;
          update({ error: lastQueryError });
          ${show}(lastQueryError);`)
      .replace("          console.warn('RH 轮询出错', e?.message);\n", '')
      .replace('          logBus.warn(`轮询出错: ${e?.message || e}`, src);',
        `          lastQueryError = generationErrorText(e);
          if (!lastQueryError.includes('未确认生成结果')) lastQueryError = '任务状态查询失败（未确认生成结果）：' + lastQueryError;
          update({ error: lastQueryError });
          ${show}(lastQueryError);`)
      .replaceAll('          const normalizedStatus = String(r.status',
        `          if (lastQueryError || d?.error) { lastQueryError = ''; update({ error: null }); ${show}(null); }
          const normalizedStatus = String(r.status`)
      .replace('          const r = await queryVideoFal(falPollRef.current!);',
        `          const r = await queryVideoFal(falPollRef.current!);
          if (lastQueryError || d?.error) { lastQueryError = ''; update({ error: null }); ${show}(null); }`)
      .replace('          const r = await queryRh(tid, activeRhSiteRef.current);\n          applyResolvedRhSite(r.site);',
        `          const r = await queryRh(tid, activeRhSiteRef.current);
          if (lastQueryError || d?.error) { lastQueryError = ''; update({ error: null }); ${show}(null); }
          applyResolvedRhSite(r.site);`)
      .replaceAll("            update({ status: 'polling', progress: '100% · 正在下载' });",
        `            lastQueryError = r.error ? '生成产物保存未完成：' + generationErrorText(r.error) : '';
            update({ status: 'polling', progress: '100% · 正在下载', error: lastQueryError || null });
            ${show}(lastQueryError || null);`)
      .replaceAll("            update({ status: 'polling', progress: '100% · 正在下载', rhCode: r.code });",
        `            lastQueryError = r.error ? '生成产物保存未完成：' + generationErrorText(r.error) : '';
            update({ status: 'polling', progress: '100% · 正在下载', rhCode: r.code, error: lastQueryError || null });
            ${show}(lastQueryError || null);`)
      .replace("            update({ status: 'polling', rhCode: r.code, error: '' });",
        `            lastQueryError = r.error ? '生成产物保存未完成：' + generationErrorText(r.error) : '';
            update({ status: 'polling', rhCode: r.code, error: lastQueryError || null });
            ${show}(lastQueryError || null);`)
      .replace(/            let reason: string;[\s\S]*?            await reporter\?\.providerResponse\(/,
        `            const reason = formatGenerationError({ error: r.failReason, code: r.code });
            await reporter?.providerResponse(`);
  });
}
edit('src/services/generation.ts', (text) =>
  "import { isGreenroomRhApp, greenroomRhAppInfo, submitGreenroomRh } from '../greenroomRunninghub';\n" + text
    .replace("  const r = await fetch('/canvas/api/proxy/runninghub/submit', {", `  if (isGreenroomRhApp(req.webappId)) {
    const r = await submitGreenroomRh(req, providerSubmissionHeaders(transport));
    const data = await safeJsonResponse(r, 'RH 提交');
    if (!r.ok || !data.success) throw providerResponseError(r, data);
    return withProviderTransportTrace(data.data, r);
  }
  const r = await fetch('/canvas/api/proxy/runninghub/submit', {`)
    .replace("export async function fetchRhAppInfo(webappId: string, site: RhSite = 'cn'): Promise<any> {",
      "export async function fetchRhAppInfo(webappId: string, site: RhSite = 'cn'): Promise<any> {\n  if (isGreenroomRhApp(webappId)) return greenroomRhAppInfo(webappId);")
    .replace("export async function cancelRh(taskId: string, site: RhSite = 'cn'): Promise<{ taskId: string; site?: RhSite; raw?: any }> {",
      "export async function cancelRh(taskId: string, site: RhSite = 'cn'): Promise<{ taskId: string; site?: RhSite; raw?: any }> {\n  if (taskId.startsWith('grh_')) throw new Error('RH Upscale 暂不提供取消接口，任务会继续处理');"));
const rhToolsSource = readFileSync(join(source, 'src/components/nodes/RHToolsNode.tsx'), 'utf8');
const greenroomSelectedSource = "import { isGreenroomRhApp, GREENROOM_RH_TOOLS, GREENROOM_RH_CATEGORY } from '../../greenroomRunninghub';\n"
  + rhToolsSource
    .replace('  const categories = ctx?.categories ?? [];',
      '  const categories = [GREENROOM_RH_CATEGORY, ...(ctx?.categories ?? [])];')
    .replace('  const tools = ctx?.tools ?? [];',
      '  const tools = [...GREENROOM_RH_TOOLS, ...(ctx?.tools ?? []).filter((tool) => !isGreenroomRhApp(tool.webappId))];')
    .replace("const accent = isPixel\n    ? 'var(--px-ink)'\n    : (isLight ? 'rgb(8, 145, 178)' : 'rgb(34, 211, 238)');",
      "const accent = isPixel\n    ? 'var(--px-ink)'\n    : (isLight ? 'rgb(217, 119, 6)' : 'rgb(251, 191, 36)');")
    .replace("const accentSoft = isPixel\n    ? 'var(--px-yellow)'\n    : (isLight ? 'rgba(8, 145, 178, 0.10)' : 'rgba(34, 211, 238, 0.12)');",
      "const accentSoft = isPixel\n    ? 'var(--px-yellow)'\n    : (isLight ? 'rgba(217, 119, 6, 0.12)' : 'rgba(251, 191, 36, 0.16)');")
    .replaceAll('border: `2px solid ${selected ? accent : ringColor}`,',
      "border: selected ? `3px solid ${accent}` : `2px solid ${isLight ? 'rgba(217, 119, 6, 0.65)' : 'rgba(251, 191, 36, 0.75)'}`, boxShadow: selected ? `0 0 16px ${accent}44` : `0 0 10px ${isLight ? 'rgba(217, 119, 6, 0.15)' : 'rgba(251, 191, 36, 0.2)'}`,")
    .replaceAll('!bg-cyan-400', '!bg-amber-400')
    .replace('if (isUrlLike) {', 'if (isUrlLike && !isGreenroomRhApp(webappId)) {')
    .replace(" · {displayedRhSite === 'intl' ? '海外站' : '国内站'}",
      "{!isGreenroomRhApp(webappId) && (displayedRhSite === 'intl' ? ' · 海外站' : ' · 国内站')}")
    .replace(/(\{\/\* webappId 显示[^\n]*\*\/\})([\s\S]*?)(\n\n          \{\/\* 参数表 \*\/\})/,
      '$1\n          {!isGreenroomRhApp(webappId) && (<>$2\n          </>)}$3')
    .replace(/(\{\/\* 实例类型 select[^\n]*\*\/\})\n          <div>([\s\S]*?)\n          <\/div>/,
      '$1\n          {!isGreenroomRhApp(webappId) && (<div>$2\n          </div>)}')
    .replace('              onClick={handleStop}',
      '              disabled={isGreenroomRhApp(webappId)}\n              onClick={handleStop}')
    .replace("{cancelling ? '取消中...' : '停止'}", "{isGreenroomRhApp(webappId) ? '处理中' : cancelling ? '取消中...' : '停止'}")
    .replace('<div className="text-sm font-semibold leading-tight truncate">RH 超市</div>',
      '<div className="text-sm font-semibold leading-tight truncate">Greenroom 严选</div>')
    .replace('<div className="text-[10px] truncate" style={{ color: subText }}>RunningHub 应用启动器</div>',
      '<div className="text-[10px] truncate" style={{ color: subText }}>RunningHub 严选应用</div>')
    .replace('title="导出 RH 超市 JSON"', 'title="导出 Greenroom 严选 JSON"')
    .replace('title="导入 RH 超市 JSON，会先提示确认"', 'title="导入 Greenroom 严选 JSON，会先提示确认"')
    .replace("shouldReuseGenerationResult('rh-tools'", "shouldReuseGenerationResult('greenroom-selected'")
    .replace("hasReusableGenerationResult('rh-tools'", "hasReusableGenerationResult('greenroom-selected'")
    .replace("const src = `rh-tools:${id}`;", "const src = `greenroom-selected:${id}`;")
    .replace('const RHToolsNode = ({ id, data, selected }: NodeProps) => {',
      'const GreenroomSelectedNode = ({ id, data, selected }: NodeProps) => {')
    .replace('export default memo(RHToolsNode);', 'export default memo(GreenroomSelectedNode);');
writeFileSync(join(source, 'src/components/nodes/GreenroomSelectedNode.tsx'), greenroomSelectedSource);
edit('src/components/nodes/RunningHubNode.tsx', (text) =>
  "import { isGreenroomRhApp } from '../../greenroomRunninghub';\n" + text
    .replace('if (isUrlLike) {', 'if (isUrlLike && !isGreenroomRhApp(webappId)) {')
    .replace(/(        <div>\n          <label[^\n]*\{t\('runningHub.site'\)\}[\s\S]*?)(\n\n        \{\/\* 参数表单：)/,
      '        {!isGreenroomRhApp(webappId) && (<>$1\n        </>)}$2'));
edit('backend/src/routes/proxy.js', (text) => text.replace(
  "router.get('/runninghub/query', async (req, res) => {", `router.get('/runninghub/query', async (req, res) => {
  // Greenroom v2 tasks use their original regional authority, including after restart.
  if (/^grh_[a-f0-9]{32}$/.test(String(req.query.taskId || ''))) {
    const taskId = String(req.query.taskId);
    let savingOutput = false;
    try {
      const response = await fetch('http://127.0.0.1:3081/canvas/api/proxy/video/query?taskId=' + encodeURIComponent(taskId));
      const body = await response.json();
      if (!response.ok || !body.success) {
        return res.status(response.ok ? 502 : response.status).json({ success: false,
          error: '任务状态查询失败（未确认生成结果）：' + generationErrorText({ ...body, httpStatus: response.status }) });
      }
      const result = body.data;
      if (result.status === 'SUCCESS') {
        savingOutput = true;
        if (!result.urls?.length) return res.json({ success: true,
          data: { ...result, status: 'FAILED', code: 805, failReason: 'RH Upscale 未返回视频产物' } });
        // The broker has already archived these outputs into the member's
        // company asset scope. Keep their stable controlled references.
        if (result.urls.some((url) => !/^\\/api\\/media\\/[^/?#]+$/.test(url))) {
          return res.status(502).json({ success: false, error: 'RH 产物尚未归档，保留原任务编号' });
        }
      }
      return res.json({ success: true, data: result });
    } catch (error) {
      return res.status(502).json({ success: false,
        error: (savingOutput ? '生成产物保存失败：' : '任务状态查询失败（未确认生成结果）：') + generationErrorText(error) });
    }
  }`));
edit('backend/src/services/runRecovery.js', (text) => text
    .replace("'use strict';", "'use strict';\nconst { generationErrorText } = require('../utils/greenroomGenerationError');")
    .replace(
  'function outputKindForDescriptor(descriptor) {',
  "function outputKindForDescriptor(descriptor) {\n  if (descriptor.kind === 'runninghub' && /^grh_[a-f0-9]{32}$/.test(descriptor.taskId || '')) return 'video';")
    .replace('error: boundedText(data?.failReason || data?.error || payload?.error, 4000) || null,',
      'error: generationErrorText({ ...data, error: data?.failReason || data?.error || payload?.error }) || null,')
    .replace('boundedText(payload?.error || `恢复查询 HTTP ${response.status}`, 4000)',
      "'任务状态查询失败（未确认生成结果）：' + generationErrorText({ ...payload, httpStatus: response.status })")
    .replace('try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text.slice(0, 1000) }; }',
      `try { payload = text ? JSON.parse(text) : {}; } catch {
    throw Object.assign(new Error(\`任务状态查询返回非 JSON 响应（HTTP \${response.status}，未确认生成结果）\`),
      { httpStatus: response.status, retryable: true });
  }`)
    .replace('  if (!response.ok) {',
      '  if (!response.ok || (payload?.success === false && !payload?.data?.status && !payload?.status)) {')
    .replace('      const pollCount = ticket.attempt.pollCount + index + 1;',
      '      lastError = null;\n      const pollCount = ticket.attempt.pollCount + index + 1;')
    .replace("    return this.interruptTicket(ticket, lastError?.message || '恢复轮询达到上限');",
      `    const cause = generationErrorText(lastError);
    return this.interruptTicket(ticket, lastError
      ? cause.includes('未确认生成结果') ? cause : '任务状态查询失败（未确认生成结果）：' + cause
      : '任务状态查询超时（未确认生成结果）');`));
edit('src/main.tsx', (text) => {
  const start = text.indexOf("createRoot(document.getElementById('root')!).render(app);");
  return "import { initializeGreenroom } from './greenroom';\n" + text.slice(0, start) +
    'void initializeGreenroom().then(() => {\n' + text.slice(start) + '\n});\n';
});
edit('backend/src/services/runRecovery.js', (text) => text.replace(
  "const get = (path) => ({ url: `${root}${path}`, options: { method: 'GET' } });",
  "const get = (path) => ({ url: `${/^\\/api\\/proxy\\/(image\\/status\\/|video\\/query)/.test(path) ? 'http://127.0.0.1:3081/canvas' : root}${path}`, options: { method: 'GET' } });"));
edit('backend/src/config.js', (text) => text.replace(
  'const USER_HOME_DIR = os.homedir() || process.env.USERPROFILE || process.env.HOME || PROJECT_DIR;',
  'const USER_HOME_DIR = DATA_ROOT;'));
edit('backend/src/routes/proxy.js', (text) => text
  .replace("const router = express.Router();", `const { generationErrorText } = require('../utils/greenroomGenerationError');
const { AsyncLocalStorage } = require('node:async_hooks');
const greenroomCanvasKeys = new AsyncLocalStorage();
const router = express.Router();
router.use((req, _res, next) => {
  const keys = req.get('x-greenroom-canvas-keys');
  if (!keys) return next();
  delete req.headers['x-greenroom-canvas-keys'];
  return greenroomCanvasKeys.run(JSON.parse(keys), next);
});`)
  .replace(/function loadRawSettings\(\) \{[\s\S]*?\n\}/, `function loadRawSettings() {
  let settings = null;
  if (fs.existsSync(config.SETTINGS_FILE)) {
    try { settings = JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf-8')); } catch {}
  }
  const keys = greenroomCanvasKeys.getStore();
  if (!keys) return settings;
  return { ...settings, ...keys,
    gptImageApiKey: '', nanoBananaApiKey: '', mjApiKey: '', veoApiKey: '',
    soraApiKey: '', grokApiKey: '', seedanceApiKey: '', sunoApiKey: '',
    rhOverseasApiKey: '', runninghubApiKey: '',
  };
}`));
edit('backend/src/routes/settings.js', (text) => text
  .replace("router.get('/', (_req, res) => {", "router.get('/', (req, res) => {")
  .replace('  res.json({ success: true, data: masked });', `  const configured = JSON.parse(req.get('x-greenroom-canvas-configured') || '{}');
  for (const field of ['zhenzhenApiKey', 'zhenzhenSd2ApiKey', 'rhApiKey', 'rhIntlApiKey', 'llmApiKey']) {
    masked[field] = configured[field] ? 'configured' : '';
  }
  for (const field of CLASSIFIED_KEY_FIELDS) masked[field] = '';
  res.json({ success: true, data: masked });`)
  .replace("router.get('/raw', (_req, res) => {\n  res.json({ success: true, data: loadSettings() });\n});",
    "router.get('/raw', (_req, res) => {\n  res.status(403).json({ success: false, error: '画布 API Key 由管理员统一配置' });\n});")
  .replace('  const incoming = req.body || {};', `  const incoming = req.body || {};
  if (Object.keys(incoming).some((field) => field !== 'preferences')) {
    return res.status(403).json({ success: false, error: '画布设置由管理员统一配置' });
  }`));
edit('index.html', (text) => text.replace(/(["'])\/(assets|infinite-canvas-loading.png)/g, '$1/canvas/$2')
  .replace(/<title>.*?<\/title>/, '<title>T8 画布 · Greenroom</title>'));

// Both DSH and the managed UI execute through this member-local backend.
function strictEdit(name, before, after) {
  edit(name, (text) => {
    if (!text.includes(before)) throw new Error('Greenroom runtime patch anchor missing: ' + name);
    return text.replace(before, after);
  });
}
// Reuse the official pure collector without loading React hooks in the member
// backend. Keep its implementation and occurrence IDs identical to the UI.
const upstreamMaterials = readFileSync(join(source, 'src/components/nodes/useUpstreamMaterials.ts'), 'utf8');
const collectorStart = upstreamMaterials.indexOf('export function collectUpstreamMaterials(');
const collectorEnd = upstreamMaterials.indexOf('\n/**', collectorStart);
const typesStart = upstreamMaterials.indexOf('export type MaterialKind');
const typesEnd = upstreamMaterials.indexOf('type MediaBuckets');
if (collectorStart < 0 || collectorEnd < 0 || typesStart < 0 || typesEnd < 0) throw new Error('T8 v3.5 upstream collector anchor missing');
const collectorImports = upstreamMaterials.split('\n').filter((line) => line.startsWith('import ') && !line.includes("from 'react'") && !line.includes("from '@xyflow/react'")).join('\n');
writeFileSync(join(source, 'src/components/nodes/greenroomUpstreamMaterials.ts'),
  collectorImports + '\n' + upstreamMaterials.slice(typesStart, typesEnd) + upstreamMaterials.slice(collectorStart, collectorEnd));
copyFileSync(join(here, 'managed-execution.ts'), join(source, 'src/greenroomExecution.ts'));
copyFileSync(join(here, 'managed-client.ts'), join(source, 'src/greenroomExecutionClient.ts'));
copyFileSync(join(here, 'frame-pair.cjs'), join(source, 'backend/src/greenroom-frame-pair.js'));
copyFileSync(join(here, 'managed-runtime.cjs'), join(source, 'backend/src/greenroom-managed-runtime.js'));
copyFileSync(join(here, '../shared/media-storage.mjs'), join(source, 'backend/src/greenroom-media-storage.mjs'));
buildSync({ entryPoints: [join(source, 'src/greenroomExecution.ts')], bundle: true,
  outfile: join(source, 'backend/src/greenroomExecution.js'), platform: 'node', format: 'cjs', target: 'node24' });
strictEdit('backend/src/server.js', "app.use('/api/canvas', canvasRouter);", `const greenroomCanvas = require('./greenroom-managed-runtime').installGreenroomCanvas(app, { config, getRuntime: projectRunsRouter.getRuntime });
app.use('/api/canvas', canvasRouter);`);
strictEdit('backend/src/server.js', '.then(() => runs.recoveryManager.recoverPendingRuns())',
  '.then(() => runs.recoveryManager.recoverPendingRuns())\n      .then((result) => { greenroomCanvas.resume(); return result; })');
strictEdit('backend/src/server.js', 'const runRecoveryManager = projectRunsRouter.peekRuntime()?.recoveryManager;',
  'greenroomCanvas.shutdown();\n    const runRecoveryManager = projectRunsRouter.peekRuntime()?.recoveryManager;');
strictEdit('backend/src/services/projectDatabase.js', 'for (const runId of activeRunIds) {\n        const activeNodes =',
  `for (const runId of activeRunIds) {
        if (this.getRun(runId)?.summary?.greenroomExecution?.version === 1) {
          recoverableRunIds.push(runId);
          continue;
        }
        const activeNodes =`);
strictEdit('backend/src/services/runRecovery.js', 'const tickets = this.database.listPendingRunRecoveries();',
  'const tickets = this.database.listPendingRunRecoveries().filter((ticket) => !ticket.run.summary?.greenroomExecution);');
strictEdit('backend/src/services/runRecovery.js', "    const error = { kind: 'protocol', code: 'RUN_RECOVERY_UNAVAILABLE', message: boundedText(message, 4000), retryable: true };\n    const terminal = this.database.completeRecoveredRunAttempt({",
  `    const error = { kind: 'protocol', code: 'RUN_RECOVERY_UNAVAILABLE', message: boundedText(message, 4000), retryable: true };
    if (ticket.run.summary?.greenroomExecution) {
      const interrupted = this.database.withProjectDatabaseWrite('run.greenroom.query-interrupted', () => {
        const run = this.database.getRun(ticket.run.id);
        const nodeRun = this.database.getNodeRun(ticket.nodeRun.id);
        const attempt = this.database.getAttempt(ticket.attempt.id);
        if (!run?.entityUid || run.entityUid !== ticket.run.entityUid
          || !nodeRun?.entityUid || nodeRun.entityUid !== ticket.nodeRun.entityUid || nodeRun.runId !== run.id
          || !attempt?.entityUid || attempt.entityUid !== ticket.attempt.entityUid || attempt.nodeRunId !== nodeRun.id
          || !ACTIVE_STATUSES.has(run.status) || !ACTIVE_STATUSES.has(nodeRun.status) || !ACTIVE_STATUSES.has(attempt.status)) return false;
        this.database.updateAttempt(ticket.attempt.id, { status: 'interrupted', error });
        this.database.updateNodeRun(ticket.nodeRun.id, { status: 'interrupted' });
        this.database.updateRun(ticket.run.id, { summary: { lastError: error.message } });
        this.database.appendRunEvent(ticket.run.id, { nodeRunId: ticket.nodeRun.id, type: 'log',
          payload: { phase: 'recovery.query-interrupted', attemptId: ticket.attempt.id, error } });
        return true;
      });
      return interrupted ? 'interrupted' : 'deferred';
    }
    const terminal = this.database.completeRecoveredRunAttempt({`);
strictEdit('backend/src/services/runRecovery.js', 'for (let index = 0; index < descriptor.maxPolls; index += 1) {',
  `for (let index = 0; index < descriptor.maxPolls; index += 1) {
      if (!ACTIVE_STATUSES.has(this.database.getRun(ticket.run.id)?.status)) return 'deferred';`);
strictEdit('backend/src/services/runRecovery.js', '          runRevision: ticket.run.revision,',
  `          runRevision: ticket.run.summary?.greenroomExecution
            ? this.database.getRun(ticket.run.id)?.revision : ticket.run.revision,`);
strictEdit('backend/src/services/assetIndexer.js', '  async indexFile(filename, options = {}) {',
  `  async indexFile(filename, options = {}) {
    if (['input', 'output'].includes(options.rootName)) {
      return require('../greenroom-managed-runtime').archiveIndexedFile(this, filename, options);
    }`);
strictEdit('backend/src/services/assetIndexer.js', '  async commitHostRunOutputAssets(input = {}) {',
  `  async commitHostRunOutputAssets(input = {}) {
    if (Array.isArray(input.outputs) && input.outputs.length && input.outputs.every((item) =>
      /^\\/(?:canvas\\/)?(?:api\\/media\\/|files\\/(?:input|output)\\/)/.test(String(item.sourceUrl || ''))
      || (typeof item.text === 'string' && !item.sourceUrl))) {
      return require('../greenroom-managed-runtime').commitManagedOutputs(this, input);
    }`);

// Use the same persisted graph and parameter mapping for manual and batch UI actions.
strictEdit('src/components/Canvas.tsx', "import { greenroomNodeDefaults } from '../greenroom';", `import { greenroomNodeDefaults } from '../greenroom';
import { isManagedNode } from '../greenroomExecution';
import { registerManagedCanvasHooks, runGreenroomNodes } from '../greenroomExecutionClient';`);
strictEdit('src/components/Canvas.tsx', '  const handlePreviewCanvasPatch =', `  useEffect(() => registerManagedCanvasHooks({
    before: async (canvasId) => ensureCanvasPatchBaseline(canvasId),
    refresh: async (canvasId) => {
      const baseline = lastSavedByCanvasRef.current.get(canvasId);
      const document = await api.getCanvasData(canvasId);
      commitAuthoritativeCanvasPatchDocument(canvasId, document as VersionedCanvasData,
        { expectedLocalSnapshot: baseline, historyMode: 'reset' });
    },
  }), [ensureCanvasPatchBaseline, commitAuthoritativeCanvasPatchDocument]);

  const handlePreviewCanvasPatch =`);
strictEdit('src/components/Canvas.tsx', '      const plannedNodeIds = new Set(order);', `      if (!options.runIntentId && !options.secondaryProviderAction
        && order.every((nodeId) => isManagedNode(plannedSubgraph.nodes.find((node) => node.id === nodeId)!))) {
        await runGreenroomNodes(order, { canvasId: launchCanvasId, submissionId: options.requestId });
        return order.length;
      }
      const plannedNodeIds = new Set(order);`);
for (const [component, type, handler, errorSetter] of [
  ['ImageNode', 'image', 'handleGenerate', 'setError'], ['VideoNode', 'video', 'handleGenerate', 'setError'],
  ['LLMNode', 'llm', 'handleSend', 'setError'], ['RHToolsNode', 'rh-tools', 'handleRun', 'setVisibleError'],
  ['GreenroomSelectedNode', 'greenroom-selected', 'handleRun', 'setVisibleError'],
]) {
  edit('src/components/nodes/' + component + '.tsx', (text) => `import { isManagedNode } from '../../greenroomExecution';\nimport { runGreenroomNodes } from '../../greenroomExecutionClient';\n` + text);
  strictEdit('src/components/nodes/' + component + '.tsx', `  const ${handler} = async (reporter?: RunNodeLifecycleReporter) => {`,
    `  const ${handler} = async (reporter?: RunNodeLifecycleReporter) => {
    if (!reporter && isManagedNode({ id, type: '${type}', data: d })) {
      try { await runGreenroomNodes([id]); }
      catch (error) { const message = error instanceof Error ? error.message : '托管任务执行失败'; ${errorSetter}(message); update({ status: 'error', error: message }); }
      return;
    }`);
}

// Archive uploads instead of retaining completed media under input/output.
strictEdit('backend/src/routes/files.js', "destination: (_req, _file, cb) => cb(null, config.INPUT_DIR),",
  `destination: (_req, _file, cb) => {
    require('../greenroom-managed-runtime').prepareMediaWrite(config.INPUT_DIR)
      .then(() => cb(null, config.INPUT_DIR), cb);
  },`);
edit('backend/src/routes/files.js', (text) => text
  .replace('url: `/files/input/${req.file.filename}`,', 'url: asset.sourceUrl,')
  .replace('      indexError = error?.message || String(error);\n      console.warn(\'[asset-index] upload indexing failed:\', indexError);',
    `      fs.rmSync(req.file.path, { force: true });
      return res.status(502).json({ success: false, error: error?.message || '素材归档失败' });`)
  .replace("router.post('/upload-base64', express.json({ limit: '20mb' }), (req, res) => {",
    "router.post('/upload-base64', express.json({ limit: '20mb' }), async (req, res) => {")
  .replace('    fs.writeFileSync(fp, buf);\n    res.json({',
    `    await require('../greenroom-managed-runtime').prepareMediaWrite(config.OUTPUT_DIR, buf.length);
    fs.writeFileSync(fp, buf);
    const archived = await getFilesAssetIndexer().indexFile(fp, { rootName: 'output', rootPath: config.OUTPUT_DIR });
    res.json({`)
  .replace('url: `/files/output/${filename}`,\n        size: buf.length,', 'url: archived.sourceUrl,\n        size: buf.length,')
  .replace("    const options = fileSaveOptions();\n    const localDescriptor = parseMountedFileUrl(url);",
    `    if (require('../greenroom-managed-runtime').isAsset(url)) {
      return res.json({ success: true, data: { url, path: '', filename: filename || '已归档素材', exist: true, source: 'asset-service' } });
    }
    await require('../greenroom-managed-runtime').prepareMediaWrite(config.OUTPUT_DIR);
    const options = fileSaveOptions();
    const localDescriptor = parseMountedFileUrl(url);`));
strictEdit('backend/src/routes/files.js', "require('../greenroom-managed-runtime').prepareMediaWrite(config.INPUT_DIR)",
  "require('../greenroom-managed-runtime').reserveUpload(config.INPUT_DIR, _req)");
strictEdit('backend/src/server.js', '  app.use(prefix, guardUserMediaStatic, express.static(directory, userMediaStaticOptions));',
  `  app.use(prefix, guardUserMediaStatic,
    (req, res, next) => require('./greenroom-managed-runtime').readLegacyMedia(config, directory, req, res, next),
    express.static(directory, userMediaStaticOptions));`);
strictEdit('backend/src/services/projectDatabase.js', '    if (!contentHash) {\n      this.db.prepare(\'DELETE FROM asset_blob_refs WHERE asset_id = ?\').run(asset.id);',
  `    if (!contentHash || (asset.storageMode === 'remote' && asset.metadata?.assetId)) {
      this.db.prepare('DELETE FROM asset_blob_refs WHERE asset_id = ?').run(asset.id);`);
strictEdit('backend/src/routes/projectAssets.js', '  const health = String(asset?.metadata?.health || \'\').trim().toLowerCase();',
  `  if (asset && require('../greenroom-managed-runtime').isAsset(asset.sourceUrl)) return res.redirect(302, asset.sourceUrl);
  if (asset?.managedPath && asset.storageMode === 'managed') {
    try {
      const migrated = await require('../greenroom-managed-runtime').archiveProjectAsset(assetIndexer, asset);
      if (require('../greenroom-managed-runtime').isAsset(migrated.sourceUrl)) return res.redirect(302, migrated.sourceUrl);
    } catch (error) { return res.status(502).json({ success: false, error: error.message }); }
  }
  const health = String(asset?.metadata?.health || '').trim().toLowerCase();`);
strictEdit('backend/src/routes/imageOps.js', 'async function fetchImageBuffer(url, remoteFetchOptions = {}) {',
  `async function fetchImageBuffer(url, remoteFetchOptions = {}) {
  if (require('../greenroom-managed-runtime').isAsset(url)) {
    const response = await fetch('http://127.0.0.1:3081' + require('../greenroom-managed-runtime').assetPath(url));
    if (!response.ok) throw new Error('资产图像读取失败（HTTP ' + response.status + '）');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_REMOTE_IMAGE_BYTES) throw new Error('图像超过处理大小上限');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }`);
strictEdit('backend/src/routes/imageOps.js', `function saveBuffer(buf, ext = 'png') {
  const filename = \`op_\${Date.now()}_\${Math.random().toString(36).slice(2, 6)}.\${ext}\`;
  const filePath = path.join(config.OUTPUT_DIR, filename);
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(filePath, buf);
  return \`/files/output/\${filename}\`;
}`,
  `async function saveBuffer(buf, ext = 'png') {
  const storage = await import('../greenroom-media-storage.mjs');
  const filename = 'op_' + Date.now() + '.' + ext;
  const media = await storage.archiveStream(require('node:stream').Readable.from([buf]), { size: buf.length, filename, assetType: 'image' });
  return media.fileUrl;
}`);
strictEdit('backend/src/routes/imageOps.js', `async function saveBufferAsync(buf, ext = 'png') {
  const filename = \`op_\${Date.now()}_\${Math.random().toString(36).slice(2, 8)}.\${ext}\`;
  const filePath = path.join(config.OUTPUT_DIR, filename);
  await fsp.mkdir(config.OUTPUT_DIR, { recursive: true });
  await fsp.writeFile(filePath, buf);
  return \`/files/output/\${filename}\`;
}`, `async function saveBufferAsync(buf, ext = 'png') {
  return saveBuffer(buf, ext);
}`);
edit('backend/src/routes/imageOps.js', (text) => text.replaceAll("imageUrl: saveBuffer(out, 'png')", "imageUrl: await saveBuffer(out, 'png')"));
// These files are rebuildable previews; originals in asset-blobs are migrated
// through the asset reader above and are never removed by cache pruning.
strictEdit('backend/src/routes/videoOps.js', 'async function resolveVideoSource(url, targetDir) {',
  `async function resolveVideoSource(url, targetDir) {
  if (/^http:\\/\\/127\\.0\\.0\\.1:3081\\/api\\/media\\/[^/?#]+$/.test(String(url))) return url;
  if (require('../greenroom-managed-runtime').isAsset(url)) return 'http://127.0.0.1:3081' + require('../greenroom-managed-runtime').assetPath(url);`);
strictEdit('backend/src/routes/videoOps.js', 'async function composeVideoEdit(clips, settings, job = makeJob(\'compose\'), options = {}) {',
  `let greenroomCompositionActive = false;
async function composeVideoEdit(clips, settings, job = makeJob('compose'), options = {}) {`);
strictEdit('backend/src/routes/videoOps.js', '  const workDir = ensureDir(path.join(os.tmpdir(), `t8-video-compose-${job.id}`));',
  `  if (greenroomCompositionActive) throw new Error('已有视频合成正在运行，请等待该任务完成');
  await require('../greenroom-managed-runtime').prepareMediaWrite(config.OUTPUT_DIR);
  greenroomCompositionActive = true;
  const workDir = ensureDir(path.join(config.OUTPUT_DIR, '.greenroom-work', 'compose-' + job.id));
  job.greenroomWorkDir = workDir;
  job.greenroomOutputPaths = new Set();`);
strictEdit('backend/src/routes/videoOps.js', "  } finally {\n    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});\n  }\n}\n\nfunction resolveVideoEditClipPayload",
  `  } finally {
    greenroomCompositionActive = false;
    if (options.markComplete !== false) fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveVideoEditClipPayload`);
strictEdit('backend/src/routes/videoOps.js', 'async function runFfmpegAttempt(ffmpeg, args, job, timeoutMs) {',
  `async function runFfmpegAttempt(ffmpeg, args, job, timeoutMs) {
  await require('../greenroom-managed-runtime').prepareMediaWrite(config.OUTPUT_DIR, 0);
  if (job?.greenroomWorkDir) {
    const output = args.at(-1);
    if (typeof output === 'string' && path.isAbsolute(output)) {
      job.greenroomOutputPaths.add(output);
      const used = require('../greenroom-managed-runtime').directoryBytes(job.greenroomWorkDir);
      const remaining = 512 * 1024 * 1024 - used;
      if (remaining < 1024) throw new Error('本次视频处理超过 512 MiB 临时空间上限');
      args = [...args.slice(0, -1), '-fs', String(remaining), output];
    }
  }`);
strictEdit('backend/src/routes/videoOps.js', "    child.stderr.on('data', (chunk) => {\n      stderr += chunk.toString();",
  `    child.stderr.on('data', (chunk) => {
      if (job?.greenroomWorkDir) {
        try { require('../greenroom-managed-runtime').checkMediaWork(job); }
        catch (error) { job.greenroomCapacityError = error; try { child.kill('SIGKILL'); } catch (_) {} }
      }
      stderr += chunk.toString();`);
strictEdit('backend/src/routes/videoOps.js', '      resolve({ code, signal, stdout, stderr });',
  `      if (job?.greenroomCapacityError) return reject(job.greenroomCapacityError);
      resolve({ code, signal, stdout, stderr });`);
strictEdit('backend/src/routes/videoOps.js', '    const stat = fs.statSync(output);\n    const result = {\n      jobId: job.id,\n      videoUrl: `/files/output/${filename}`,',
  `    if (job.cancelled || job.status === 'cancelled') throw new Error('已取消');
    const stat = fs.statSync(output);
    job.result = { videoUrl: '/files/output/' + filename, directVideoUrl: '/files/output/' + filename,
      fileName: filename, size: stat.size, mime: 'video/mp4' };
    const archived = options.markComplete === false ? { sourceUrl: '/files/output/' + filename }
      : await require('../greenroom-managed-runtime').archiveIndexedFile(
        require('./projectRuns').getRuntime().assetIndexer, output, { rootName: 'output', rootPath: config.OUTPUT_DIR });
    const result = {
      jobId: job.id,
      videoUrl: archived.sourceUrl,`);
strictEdit('backend/src/routes/videoOps.js', '      directVideoUrl: `/files/output/${filename}`,\n      fileName: filename,',
  '      directVideoUrl: archived.sourceUrl,\n      fileName: filename,');
strictEdit('backend/src/routes/videoOps.js', '    if (outputToCleanOnFailure) {\n      await fsp.rm(outputToCleanOnFailure, { force: true }).catch(() => {});',
  '    if (outputToCleanOnFailure && !job.result?.videoUrl) {\n      await fsp.rm(outputToCleanOnFailure, { force: true }).catch(() => {});');
strictEdit('backend/src/routes/videoOps.js', "router.get('/jobs/:id', (req, res) => {", "router.get('/jobs/:id', async (req, res) => {");
strictEdit('backend/src/routes/videoOps.js', "    if (!job) return res.status(404).json({ success: false, error: '任务不存在' });\n    if (jobs.has(req.params.id)) persistVideoOperationProgress(job);",
  `    if (!job) return res.status(404).json({ success: false, error: '任务不存在' });
    if (!job.cancelled && job.status !== 'cancelled' && job.result?.videoUrl?.startsWith('/files/output/')) {
      const filename = path.basename(job.result.videoUrl);
      const output = path.join(config.OUTPUT_DIR, filename);
      if (fs.existsSync(output)) {
        const archived = await require('../greenroom-managed-runtime').archiveIndexedFile(
          require('./projectRuns').getRuntime().assetIndexer, output, { rootName: 'output' });
        job.result = { ...job.result, videoUrl: archived.sourceUrl, directVideoUrl: archived.sourceUrl };
      }
    }
    if (jobs.has(req.params.id)) persistVideoOperationProgress(job);`);
strictEdit('backend/src/routes/videoOps.js', 'const used = require(\'../greenroom-managed-runtime\').directoryBytes(job.greenroomWorkDir);',
  "const used = require('../greenroom-managed-runtime').mediaWorkBytes(job);");
strictEdit('backend/src/routes/videoOps.js', '    syntheticExecution,\n    _lastDurableFingerprint,',
  '    syntheticExecution,\n    greenroomWorkDir, greenroomOutputPaths, greenroomCapacityError, greenroomArchivePending,\n    _lastDurableFingerprint,');
strictEdit('backend/src/routes/videoOps.js', "    failJob(job, error, '视频合成失败');\n    throw error;",
  `    if (job.result?.videoUrl?.startsWith('/files/output/')) {
      job.status = 'running';
      job.greenroomArchivePending = true;
      job.message = '成片已完成，等待资产归档';
      job.error = error?.message || '成片归档失败';
      persistVideoOperationProgress(job);
      throw error;
    }
    failJob(job, error, '视频合成失败');
    throw error;`);
strictEdit('backend/src/routes/videoOps.js', "        if (!isTerminalJob(job)) {\n          try { failJob(job, error, fallbackMessage); } catch (_) {}",
  "        if (!isTerminalJob(job) && !job.greenroomArchivePending) {\n          try { failJob(job, error, fallbackMessage); } catch (_) {}");
strictEdit('backend/src/routes/videoOps.js', '        job.result = { ...job.result, videoUrl: archived.sourceUrl, directVideoUrl: archived.sourceUrl };',
  `        job.result = { ...job.result, videoUrl: archived.sourceUrl, directVideoUrl: archived.sourceUrl };
        if (job.greenroomArchivePending || !isTerminalJob(job)) {
          job.greenroomArchivePending = false;
          finishJob(job, '合成完成', job.result);
        }`);
// Cancelling an already-finished composition must not rewrite its durable result.
// A restarted process can answer for the same terminal job from its native ledger.
strictEdit('backend/src/routes/videoOps.js', `    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: '任务不存在' });
    cancelJob(job);`,
  `    const job = jobs.get(req.params.id) || reconstructDurableVideoOperationJob(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: '任务不存在' });
    if (isTerminalJob(job) || job.status === 'interrupted' || job.greenroomArchivePending || job.result?.videoUrl) return res.json({ success: true, data: publicJob(job) });
    cancelJob(job);`);
strictEdit('backend/src/routes/videoOps.js', "  finishJob(job, '音频处理完成', result);\n  return result;",
  `  try {
    for (const kind of ['video', 'audio']) {
      const url = result[kind + 'Url'];
      if (!url?.startsWith('/files/output/')) continue;
      const archived = await require('../greenroom-managed-runtime').archiveIndexedFile(
        require('./projectRuns').getRuntime().assetIndexer, path.join(config.OUTPUT_DIR, path.basename(url)), { rootName: 'output' });
      result[kind + 'Url'] = archived.sourceUrl;
      result['direct' + kind[0].toUpperCase() + kind.slice(1) + 'Url'] = archived.sourceUrl;
    }
  } finally {
    if (job.greenroomWorkDir) await fsp.rm(job.greenroomWorkDir, { recursive: true, force: true });
  }
  finishJob(job, '音频处理完成', result);
  return result;`);

// Managed Asset URLs have no extension. Preserve explicit video identity before
// the generic URL fallback consumes the shared seen set.
strictEdit('src/components/Canvas.tsx', '      // d.urls 是通用产物数组（RH/FAL 使用），可能同时含图/视频/音频/3D 模型。',
  `      const explicitVideoUrls = new Set<string>([
        d.videoUrl, ...(Array.isArray(d.videoUrls) ? d.videoUrls : []),
      ].filter((url): url is string => typeof url === 'string' && Boolean(url)));
      // Preserve the old fallback order to identify only the affected automatic output.
      const legacyImageUrls = [...new Set<string>([
        d.imageUrl, ...(Array.isArray(d.imageUrls) ? d.imageUrls : []),
        ...(Array.isArray(d.urls) ? d.urls.filter((url: unknown) => typeof url === 'string'
          && !/\\.(glb|gltf|obj|fbx|stl|usdz|zip|mp4|webm|mov|m4v|mkv|mp3|wav|ogg|m4a|flac|aac)(\\?.*)?$/i.test(url)) : []),
      ].filter((url): url is string => typeof url === 'string' && Boolean(url)))];
      // d.urls 是通用产物数组（RH/FAL 使用），可能同时含图/视频/音频/3D 模型。`);
strictEdit('src/components/Canvas.tsx', '          if (isModExt(u)) {',
  '          if (explicitVideoUrls.has(u)) pushVid(u);\n          else if (isModExt(u)) {');
strictEdit('src/components/Canvas.tsx', '      const validItemKeys = new Set(items.map(itemKey));',
  `      const correctedVideoPatches: Array<[string, Record<string, any>]> = [];
      for (const output of downstreamOutputs) {
        if (!output.removable || output.pickKind !== 'image'
          || !Number.isInteger(output.pickIndex) || output.pickIndex! < 0) continue;
        const url = legacyImageUrls[output.pickIndex!];
        if (!url || !explicitVideoUrls.has(url) || !Array.isArray(d.urls) || !d.urls.includes(url)) continue;
        const item = items.find((candidate) => candidate.kind === 'video' && candidate.url === url);
        if (!item) continue;
        const old = output.data || {};
        const stored = [old.imageUrl, old.directImageUrl, old.videoUrl, old.directVideoUrl,
          ...(Array.isArray(old.videoUrls) ? old.videoUrls : []),
          ...(Array.isArray(old.directVideoUrls) ? old.directVideoUrls : []),
          ...(Array.isArray(old.imageUrls) ? old.imageUrls : []),
          ...(Array.isArray(old.directImageUrls) ? old.directImageUrls : [])]
          .filter((value) => typeof value === 'string' && Boolean(value));
        if (stored.some((value) => value !== url)) continue;
        const patch = { ...outputDataForItem(item), imageUrl: '', imageUrls: [], directImageUrl: '', directImageUrls: [],
          ...(stored.length ? buildPersistentOutputSnapshotData(item) : {}) };
        correctedVideoPatches.push([output.id, patch]);
        output.data = { ...old, ...patch };
        output.pickKind = 'video';
        output.pickIndex = item.kindIndex;
      }
      const validItemKeys = new Set(items.map(itemKey));`);
strictEdit('src/components/Canvas.tsx', '      const upgradePatches: Array<[string, Record<string, any>]> = [];',
  '      const upgradePatches: Array<[string, Record<string, any>]> = [...correctedVideoPatches];');
