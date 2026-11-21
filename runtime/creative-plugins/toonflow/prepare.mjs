import { copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
copyFileSync(new URL('startup.mjs', import.meta.url), join(root, 'greenroom-startup.mjs'));
// Use the official registry for upstream's pinned tarballs; retain versions and lock integrity.
const lockfile = join(root, 'bun.lock');
writeFileSync(lockfile, readFileSync(lockfile, 'utf8').replace(
  /https?:\/\/registry\.(?:npmmirror\.com|npm\.taobao\.org)(\/(?:@[^/"\s]+\/)?([^/"\s]+)\/-\/\2-[^/"\s]+\.tgz)/g,
  'https://registry.npmjs.org$1',
));
const patch = (file, before, after) => {
  const filename = join(root, file);
  const source = readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
  if (!source.includes(before)) throw new Error(`Toonflow 适配位置已变化：${file}`);
  writeFileSync(filename, source.replace(before, after));
};
copyFileSync(new URL('managed.ts', import.meta.url), join(root, 'apps/server/src/greenroom-managed.ts'));
copyFileSync(new URL('director.ts', import.meta.url), join(root, 'apps/server/src/greenroom-director.ts'));
copyFileSync(new URL('local-media.ts', import.meta.url), join(root, 'apps/server/src/greenroom-local-media.ts'));
// JSDOM 19 is already in the official lock graph (via cherry-markdown). Declare the
// existing version at the root so both source and build/server resolve the same runtime package.
const rootPackage = join(root, 'package.json');
const packageData = JSON.parse(readFileSync(rootPackage, 'utf8'));
packageData.dependencies = { ...packageData.dependencies, jsdom: '19.0.0' };
writeFileSync(rootPackage, JSON.stringify(packageData, null, 2) + '\n');
patch('bun.lock', '      "name": "toonflow",\n      "devDependencies": {', '      "name": "toonflow",\n      "dependencies": { "jsdom": "19.0.0" },\n      "devDependencies": {');
copyFileSync(new URL('prompt.ts', import.meta.url), join(root, 'apps/server/src/greenroom-prompt.ts'));
copyFileSync(new URL('text-references.ts', import.meta.url), join(root, 'apps/server/src/greenroom-text-references.ts'));
const promptSource = readFileSync(join(root, 'packages/nodeShared/src/promptText.ts'), 'utf8');
const signature = 'export function getPromptText(value: AnyTagProps[][], resolveReference?: (id: string) => string)';
if (!promptSource.includes(signature)) throw new Error('官方提示词合同锚点缺失');
writeFileSync(join(root, 'apps/server/src/greenroom-prompt-contract.ts'), promptSource
  .replace('import type { AnyTagProps } from "x-sender";\n', '')
  .replace(signature, 'export function getPromptText(document: any, value: any[][], resolveReference?: (id: string) => string)')
  .replace('querySelectorAll<HTMLElement>', 'querySelectorAll'));

// Extract the unchanged pure contracts, not the browser/UI entrypoint, for server consumers.
function nativeSection(file, start, end) {
  const source = readFileSync(join(root, file), 'utf8');
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`官方纯合同锚点缺失：${file}`);
  return source.slice(from, to);
}
const directorRoot = 'packages/nodes/director3dNode/src/';
writeFileSync(join(root, 'apps/server/src/greenroom-director-contract.ts'), `import { z } from 'zod';\n`
  + nativeSection(directorRoot + 'mannequin.ts', 'export const mannequinJoints =', '\n\nexport function createMannequin')
  + '\n' + nativeSection(directorRoot + 'scene.ts', 'const coordinate =', '\nexport interface SceneSettings')
  + '\n' + nativeSection(directorRoot + 'scene.ts', 'export function createEmptyScene()', '\nexport async function createStage')
  + '\n' + nativeSection(directorRoot + 'motion.ts', 'export const anchorSchema =', '\n\nexport function applyCamera')
  + '\n' + nativeSection(directorRoot + 'sceneAnimation.ts', 'export const directorPlanSchema =', '\nexport type DirectorPlan'));
const analysisSource = readFileSync(join(root, 'packages/nodes/frameAnalysisNode/src/videoAnalysis.ts'), 'utf8');
const analysisImport = 'import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData, WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";';
if (!analysisSource.includes(analysisImport)) throw new Error('官方拉片类型锚点缺失');
writeFileSync(join(root, 'apps/server/src/greenroom-videoAnalysis.ts'), analysisSource.replace(analysisImport,
  'import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/browser";\nimport type { WorkspaceFiles } from "./greenroom-workspaceFiles";').replace('"./sceneDetector"', '"./greenroom-sceneDetector"'));
copyFileSync(join(root, 'packages/nodes/frameAnalysisNode/src/sceneDetector.ts'), join(root, 'apps/server/src/greenroom-sceneDetector.ts'));
writeFileSync(join(root, 'apps/server/src/greenroom-workspaceFiles.ts'), nativeSection('packages/nodeScaffold/src/workspaceFiles.ts', 'export interface WorkspaceFiles', '\nfunction getNodeDirectory'));

copyFileSync(new URL('scene-analysis.ts', import.meta.url), join(root, 'apps/server/src/greenroom-scene-analysis.ts'));
const nodeAiSource = 'packages/nodeScaffold/src/nodeAi.ts';
writeFileSync(join(root, 'apps/server/src/greenroom-nodeAi-contract.ts'),
  'import type { NodeOutput } from "../../../packages/nodeScaffold/src/values";\n'
  + nativeSection(nodeAiSource, 'export type NodeAiModel =', '\nexport type NodeMediaModel =')
  + '\n' + nativeSection(nodeAiSource, 'type ModelIdentity =', '\nexport function getNodeModelKey')
  + '\n' + nativeSection(nodeAiSource, 'export function findNodeModel', '\nexport function useNodeModelSelection')
  + '\n' + nativeSection(nodeAiSource, 'export type NodeAiRequest =', '\nasync function readResult'));
const aiAnalysisSource = readFileSync(join(root, 'packages/nodes/frameAnalysisNode/src/aiAnalysis.ts'), 'utf8');
const aiAnalysisImport = 'import { findNodeModel, getNodeModelIdentity, type BrowserFfmpegFactory, type NodeAiModel, type NodeAiRequest, type NodeAiResult, type WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";';
if (!aiAnalysisSource.includes(aiAnalysisImport)) throw new Error('官方 AI 拉片纯合同锚点缺失');
writeFileSync(join(root, 'apps/server/src/greenroom-aiAnalysis.ts'), aiAnalysisSource.replace(aiAnalysisImport,
  'import { findNodeModel, getNodeModelIdentity, type NodeAiModel, type NodeAiRequest, type NodeAiResult } from "./greenroom-nodeAi-contract";\n'
  + 'import type { BrowserFfmpegFactory } from "@toonflow/ffmpeg/browser";\nimport type { WorkspaceFiles } from "./greenroom-workspaceFiles";')
  .replaceAll('"./videoAnalysis"', '"./greenroom-videoAnalysis"'));

copyFileSync(new URL('image-variants.ts', import.meta.url), join(root, 'apps/server/src/greenroom-image-variants.ts'));
for (const name of ['imageLighting', 'imageMultiAngle', 'imagePanorama']) {
  const imageSource = readFileSync(join(root, `packages/nodes/imageNode/src/${name}.ts`), 'utf8');
  const imageImport = 'import { z } from "@toonflow/nodes-scaffold/runtime";';
  if (name !== 'imagePanorama' && !imageSource.includes(imageImport)) throw new Error(`官方图片编辑纯合同锚点缺失：${name}`);
  writeFileSync(join(root, `apps/server/src/greenroom-${name}.ts`), imageSource.replace(imageImport, 'import { z } from "zod";'));
}

copyFileSync(new URL('idleShutdown.ts', import.meta.url), join(root, 'apps/server/src/greenroom-idleShutdown.ts'));
patch('apps/server/src/index.ts', 'app.listen(realPort, async (error?: Error) => {',
  'const { installIdleShutdown } = await import("./greenroom-idleShutdown");\nconst { beginIdleShutdown, isIdleForShutdown } = await import("./greenroom-managed");\nconst server = app.listen(realPort, async (error?: Error) => {');
const serverEntry = join(root, 'apps/server/src/index.ts');
writeFileSync(serverEntry, readFileSync(serverEntry, 'utf8') + '\ninstallIdleShutdown(server, { begin: beginIdleShutdown, idle: isIdleForShutdown });\n');
copyFileSync(new URL('../../shared/generation-error.ts', import.meta.url), join(root, 'apps/server/src/greenroom-generation-error.ts'));
patch('apps/server/src/app.ts', '  app.use("/api/desktop", desktopRequest);', '  const { install: installGreenroom } = await import("./greenroom-managed");\n  await installGreenroom(app);\n  app.use("/api/desktop", desktopRequest);');
patch('apps/server/src/router.ts', 'import type { Express } from "express";', 'import type { Express } from "express";\nimport { trackRouter } from "@/greenroom-managed";');
const routerFile = join(root, 'apps/server/src/router.ts');
const routerSource = readFileSync(routerFile, 'utf8');
const trackedRouterSource = routerSource.replace(/app\.use\(("\/api\/[^"]+"), (route\d+)\);/g, 'app.use($1, trackRouter($2));');
if (trackedRouterSource === routerSource) throw new Error('Toonflow 原生路由挂载位置已变化');
writeFileSync(routerFile, trackedRouterSource);
patch('apps/server/src/index.ts', '  appVersion: config.app.version,', '  appVersion: config.app.version,\n  pluginRevision: "6086cdffceb704a632eca143dd16cd461a78cdac-greenroom-audio",');
patch('apps/server/src/index.ts', '  await startMobileLinkRuntime(app).catch(error => console.error("设备互联启动失败：", error));', '  // Device pairing is managed outside the member business application.');
// The managed web app has no device-pairing runtime. Keep native refusal and server origin checks.
patch('apps/web/src/lib/mobile.ts', 'export const mobileConnection = ref<MobileConnection>({ mode: actualPlatform.isRemoteConnection ? "remote" : "local" });',
  'export const mobileConnection = ref<MobileConnection>({ mode: "local" });');
patch('apps/web/src/lib/mobile.ts', 'export const deviceConnectionSupported = ref(true);', 'export const deviceConnectionSupported = ref(false);');
patch('apps/web/src/lib/mobile.ts', 'export async function refreshMobileConnection() {',
  'export async function refreshMobileConnection() {\n  if (!deviceConnectionSupported.value) return mobileConnection.value;');
patch('apps/web/src/pages/home/index.vue', '<button v-if="!publicWeb" class="sidebarItem deviceButton"', '<button v-if="false" class="sidebarItem deviceButton"');
patch('apps/web/src/pages/hello/index.vue', '<el-button class="deviceLink"', '<el-button v-if="false" class="deviceLink"');
patch('apps/web/src/pages/hello/index.vue', '<div v-if="!multiTenantEnabled && view !== \'welcome\'" class="providerContent">', '<div v-if="false" class="providerContent">');
patch('apps/web/src/pages/hello/index.vue', '<accountPanel v-if="!loggedIn"', '<accountPanel v-if="false"');
patch('apps/web/src/pages/hello/index.vue', '<template v-if="!multiTenantEnabled">', '<template v-if="false">');
patch('apps/web/src/pages/hello/index.vue', '登录 Toonflow 即可免配置快速开始，直接开启创作。', '成员身份与模型由 Greenroom 统一托管，可直接开启创作。');
patch('apps/web/src/components/mobileConnect.vue', '请使用 Toonflow 桌面端或 Android 客户端连接其他设备。<br />本机共享可在“设置 → 设备互联”中管理。',
  '当前工作台由 Greenroom 统一托管，不支持设备配对或共享。<br />创作设置仍可在工作台中使用。');
patch('apps/server/src/utils/media/generation.ts', 'export async function listMediaModels(): Promise<MediaModel[]> {', 'export async function listMediaModels(): Promise<MediaModel[]> {\n  return (await import("@/greenroom-managed")).models();\n}\nasync function unmanagedListMediaModels(): Promise<MediaModel[]> {');
patch('apps/server/src/utils/media/generation.ts', 'export async function generateMedia(\n', 'async function unmanagedGenerateMedia(\n');
const generation = join(root, 'apps/server/src/utils/media/generation.ts');
writeFileSync(generation, readFileSync(generation, 'utf8') + '\nexport { generate as generateMedia } from "@/greenroom-managed";\n');
writeFileSync(join(root, 'apps/server/src/utils/media/tasks.ts'), `import { status as managedStatus, wait as managedWait } from "@/greenroom-managed";
export { start, cancel } from "@/greenroom-managed";
export function status(cwd: string, taskIds: string[], resume = false, owner?: unknown) {
  return managedStatus(cwd, taskIds, resume, owner).map((result, index) => ({ ...result, taskId: taskIds[index] }));
}
export function wait(cwd: string, taskId: string, owner?: unknown, signal?: AbortSignal) {
  const [result] = managedStatus(cwd, [taskId], false, owner);
  return managedWait(cwd, result.taskId, owner, signal);
}
`);

// Bind native media requests to the node and ordered references actually read
// before workspace/save awaits; the field is never passed to the provider.
const nodeAi = 'packages/nodeScaffold/src/nodeAi.ts';
patch(nodeAi, 'export type NodeImageRequest = {', `export type GreenroomCanvasBefore = { selection: string; inputs: { source: string; sourceHandle: string; dataType: string | string[]; value: unknown }[] };
export type NodeImageRequest = {
  greenroomCanvasBefore?: GreenroomCanvasBefore;`);
patch(nodeAi, 'export type NodeVideoRequest = Omit<MediaGenerationRequest, "size"> & { directory: string; outputDirectory: string };',
  'export type NodeVideoRequest = Omit<MediaGenerationRequest, "size"> & { directory: string; outputDirectory: string; greenroomCanvasBefore?: GreenroomCanvasBefore };');
patch(nodeAi, ' & { directory: string; outputDirectory: string };\nexport type NodeAudioResult',
  ' & { directory: string; outputDirectory: string; greenroomCanvasBefore?: GreenroomCanvasBefore };\nexport type NodeAudioResult');
patch(nodeAi, '  canvasPath?: string;\n  result?: MediaTaskResult;',
  '  canvasPath?: string;\n  greenroomCanvasBefore?: GreenroomCanvasBefore;\n  greenroomSelectionConflict?: boolean;\n  result?: MediaTaskResult;');
patch(nodeAi, '  async function getMediaPrice(input: NodeMediaPriceRequest, signal?: AbortSignal): Promise<NodeMediaPrice | null> {',
  '  async function getMediaPrice(input: NodeMediaPriceRequest, signal?: AbortSignal): Promise<NodeMediaPrice | null> {\n    input = { ...input };\n    delete input.greenroomCanvasBefore;');

const referencesFile = 'packages/nodeShared/src/useNodeReferences.ts';
patch(referencesFile,
  '  return { refList, referenceMentions, materialMentions, selectMaterialReference, selectAssetReference, setReferencePreview, removeReference };',
  `  function captureGreenroomCanvasBefore() {
    const { label, greenroomTask, mediaTask, ...selection } = node.data as Record<string, unknown>;
    return JSON.parse(JSON.stringify({ selection: JSON.stringify(selection),
      inputs: refList.value.map(({ source, sourceHandle, dataType, value }) => ({ source, sourceHandle, dataType, value })) }));
  }
  return { refList, referenceMentions, materialMentions, selectMaterialReference, selectAssetReference, setReferencePreview, removeReference, captureGreenroomCanvasBefore };`);

const generationState = 'packages/nodeShared/src/useNodeGeneration.ts';
patch(generationState, 'NodeMediaTaskStatus, NodeVideoRequest, useNodeAi', 'NodeMediaTaskStatus, NodeVideoRequest, GreenroomCanvasBefore, useNodeAi');
patch(generationState, '  applied?: boolean;\n};', '  applied?: boolean;\n  greenroomSelectionConflict?: boolean;\n};');
patch(generationState, '  ai: ReturnType<typeof useNodeAi>;\n  recover?:', '  ai: ReturnType<typeof useNodeAi>;\n  captureGreenroomCanvasBefore: () => GreenroomCanvasBefore;\n  recover?:');
patch(generationState, '  let attemptedTaskId = "";', '  let attemptedTaskId = "";\n  let completedSelection: { taskId: string; before?: GreenroomCanvasBefore; conflict: boolean } | undefined;');
patch(generationState, '  const pendingRecovery = computed(() => !generating.value && needsRecovery());',
  '  const pendingRecovery = computed(() => !generating.value && needsRecovery());\n  const selectionConflict = computed(() => !!savedData.value.mediaTask?.greenroomSelectionConflict);');
patch(generationState, '    return !!task && task.state !== "failed" && task.state !== "cancelled" && (task.state !== "succeeded" || !task.applied);',
  '    return !!task && task.state !== "failed" && task.state !== "cancelled" && (task.state !== "succeeded" || (!task.applied && !task.greenroomSelectionConflict));');
patch(generationState, '        checkTask(task, context);\n        if (value.nodeId',
  `        checkTask(task, context);
        if (value.state === "succeeded") completedSelection = { taskId: task.taskId, before: value.greenroomCanvasBefore, conflict: value.greenroomSelectionConflict !== false };
        if (value.nodeId`);
patch(generationState, '  async function generate<T extends "image" | "video" | "audio">',
  `  function canApply(result: NodeMediaResult, allowApplied = true) {
    const task = savedData.value.mediaTask;
    if (!task) return false;
    const current = outputs.value[result.mediaType] as { value?: { url?: string; mimeType?: string } } | undefined;
    if (allowApplied && current?.value?.url === result.path && current?.value?.mimeType === result.mimeType) return true;
    if (completedSelection?.taskId === task.taskId && !completedSelection.conflict && completedSelection.before
      && JSON.stringify(completedSelection.before) === JSON.stringify(options?.captureGreenroomCanvasBefore())) return true;
    task.greenroomSelectionConflict = true;
    error.value = "生成已完成，但节点或引用已变化，原任务和产物已保留，未覆盖当前选择：" + task.taskId;
    return false;
  }

  async function generate<T extends "image" | "video" | "audio">`);
patch(generationState, '    const applied = task.applied;\n    task.applied = true;',
  '    if (task.greenroomSelectionConflict) { await context.save(signal); return; }\n    const applied = task.applied;\n    task.applied = true;');
patch(generationState, '      if (options.recover) results = await options.recover(results, task, signal);',
  '      if (options.recover && task.recoveryData && results[0] && !canApply(results[0], false)) return;\n      if (options.recover) results = await options.recover(results, task, signal);\n      if (task.greenroomSelectionConflict) return;');
patch(generationState, '      if (!result || result.mediaType !== task.mediaType) throw new Error("生成任务未返回对应的媒体结果");',
  '      if (!result || result.mediaType !== task.mediaType) throw new Error("生成任务未返回对应的媒体结果");\n      if (!canApply(result)) return;');
patch(generationState, '  return { generating, pendingRecovery, cancelling, run, generate, resume, cancel: cancelGeneration };',
  '  return { generating, pendingRecovery, cancelling, selectionConflict, canApply, run, generate, resume, cancel: cancelGeneration };');

const mediaRoute = 'apps/server/src/routes/ai/media/generate.ts';
patch(mediaRoute, '  const { directory, mediaType, taskId, nodeId, canvasPath, ...request } = req.body;',
  '  const { directory, mediaType, taskId, nodeId, canvasPath, greenroomCanvasBefore, ...request } = req.body;');
for (let i = 0; i < 2; i++) patch(mediaRoute, '{ nodeId, canvasPath }, owner)', '{ nodeId, canvasPath, greenroomCanvasBefore }, owner)');

const imageInpaint = 'packages/nodes/imageNode/src/imageInpaint.ts';
patch(imageInpaint,
  'export function useImageInpaint(generate?: (input: NodeImageRequest, signal: AbortSignal, recoveryData: { input: NodeImageRequest; inpaint: ImageInpaint }) => Promise<NodeImageResult[]>) {',
  'export function useImageInpaint(generate?: (input: NodeImageRequest, signal: AbortSignal, recoveryData: { input: NodeImageRequest; inpaint: ImageInpaint }) => Promise<NodeImageResult[]>, canApply?: (result: NodeImageResult) => boolean) {');
patch(imageInpaint, '      if (!result) throw new Error("供应商未返回图片");\n      const generated =',
  '      if (!result) throw new Error("供应商未返回图片");\n      if (generate && canApply && !canApply(result)) return [];\n      const generated =');

for (const [nodeName, kind] of [['imageGenerationNode', 'image'], ['videoGenerationNode', 'video'], ['audioGenerationNode', 'audio']]) {
  const file = `packages/nodes/${nodeName}/src/index.vue`;
  patch(file,
    'const { refList, referenceMentions, materialMentions, selectMaterialReference, selectAssetReference, setReferencePreview, removeReference } = useNodeReferences();',
    'const { refList, referenceMentions, materialMentions, selectMaterialReference, selectAssetReference, setReferencePreview, removeReference, captureGreenroomCanvasBefore } = useNodeReferences();');
  patch(file, '    outputDirectory: `assets/${id}`,', '    outputDirectory: `assets/${id}`,\n    greenroomCanvasBefore: captureGreenroomCanvasBefore(),');
  if (kind === 'image') {
    patch(file, '  const input = generationInput.value;\n  if (!generationPrompt.value)',
      '  const currentInput = generationInput.value;\n  const input = currentInput && JSON.parse(JSON.stringify(currentInput)) as typeof currentInput;\n  if (!generationPrompt.value)');
    patch(file, '  const inpaintData = data.value.inpaint;',
      '  const inpaintData = data.value.inpaint && JSON.parse(JSON.stringify(data.value.inpaint)) as typeof data.value.inpaint;');
    patch(file, '  ai,\n  async recover(results, task, signal) {', '  ai, captureGreenroomCanvasBefore,\n  async recover(results, task, signal) {');
    patch(file,
      'const generateInpaint = useImageInpaint((input, signal, recoveryData) => generationState.generate("image", input, signal, recoveryData));',
      'const generateInpaint = useImageInpaint((input, signal, recoveryData) => generationState.generate("image", input, signal, recoveryData), result => generationState.canApply(result, false));');
  } else {
    patch(file, 'const generationState = useNodeGeneration(outputs, () => generationController?.abort(), { ai });',
      'const generationState = useNodeGeneration(outputs, () => generationController?.abort(), { ai, captureGreenroomCanvasBefore });');
    if (kind === 'video') patch(file, '  const input = getGenerationInput(prompt);',
      '  const currentInput = getGenerationInput(prompt);\n  const input = currentInput && JSON.parse(JSON.stringify(currentInput)) as typeof currentInput;');
    else patch(file, '  const input = generationInput.value;\n  if (!input) throw new Error("请先选择音频模型");',
      '  const currentInput = generationInput.value;\n  const input = currentInput && JSON.parse(JSON.stringify(currentInput)) as typeof currentInput;\n  if (!input) throw new Error("请先选择音频模型");');
  }
  patch(file, 'const { generating, pendingRecovery, cancelling } = generationState;',
    'const { generating, pendingRecovery, cancelling, selectionConflict } = generationState;');
  const message = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
  patch(file, `if (!result) throw new Error("供应商未返回${message}");\n`,
    `if (!result) { if (selectionConflict.value) return; throw new Error("供应商未返回${message}"); }\n      if (!generationState.canApply(result)) return;\n`);
}

patch('apps/server/src/utils/media/generation.ts',
  'export async function getMediaPrice(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal) {',
  'export async function getMediaPrice(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal) {\n  return null;\n}\nasync function unmanagedGetMediaPrice(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal) {');
patch('apps/server/src/routes/ai/media/generate.ts', '  const controller = new AbortController();', '  const controller = new AbortController();');
// Generation is owned by the durable service even when a synchronous caller disconnects.
patch('apps/server/src/routes/settings/get.ts', '  res.json(success({ ...settings, multiTenantEnabled: u.multiTenant.isEnabled() }));', '  const { customProviders, mediaProviderConfigs, mcp, network, toonflowAccount, toonflowProvider, multiTenantEnabled, ...creative } = settings;\n  res.json(success({ ...creative, multiTenantEnabled: false }));');
patch('apps/server/src/routes/settings/save.ts', '  const { settings } = req.body;', `  const { settings } = req.body;
  const protectedKeys = ['customProviders', 'mediaProviderConfigs', 'mcp', 'network', 'desktopUpdateCustomUrl', 'toonflowAccount', 'toonflowProvider'];
  if (protectedKeys.some(key => Object.hasOwn(settings, key)) || (settings.multiTenantEnabled !== undefined && settings.multiTenantEnabled !== false)) return res.status(403).json({ code: 403, data: null, message: '模型与连接配置由 Greenroom 管理员维护' });`);
patch('apps/server/src/routes/settings/save.ts', `    const previousAccount = previousSettings.toonflowAccount as { token?: unknown } | null | undefined;
    const nextAccount = settings.toonflowAccount as { token?: unknown } | null | undefined;
    if (!nextAccount?.token || nextAccount.token !== previousAccount?.token) settings.toonflowProvider = null;
    const network = settings.network !== undefined || previousSettings.network !== undefined
      ? await u.network.prepareNetwork(settings.network) : undefined;
    const commit = () => {
      // 开关只由超管接口修改；异步准备完成后读取最新值，避免其他页面的旧快照覆盖。
      settings.multiTenantEnabled = u.multiTenant.isEnabled();
      u.conf.set("settings", settings);
    };
    if (network) u.network.configureNetwork(network, undefined, commit);
    else commit();`, '    u.conf.set("settings", { ...previousSettings, ...settings });');
patch('apps/server/src/routes/settings/save.ts',
  '    return { customProviders: settings.customProviders ?? [], mediaProviderConfigs: settings.mediaProviderConfigs ?? {}, toonflowProvider: settings.toonflowProvider ?? null,',
  '    return {');
// Greenroom already owns member identity, storage and model billing. Do not enable a second account system.
patch('apps/server/src/utils/multiTenant/mode.ts',
  'export function isEnabled() { return conf.get("settings", {}).multiTenantEnabled === true; }',
  'export function isEnabled() { return false; }');
patch('apps/server/src/utils/ai/provider.ts',
  '  const account = getAccountProvider();', '  // Member models come only from Greenroom.');
patch('apps/server/src/utils/ai/provider.ts',
  '  return [...(account ? [account] : []), ...(Array.isArray(providers) ? providers.filter(item => typeof item?.id !== "string" || item.id.toLowerCase() !== "toonflow") : [])];',
  '  return Array.isArray(providers) ? providers.filter(item => item?.id === "greenroom") : [];');
patch('apps/web/src/bootstrap/multiTenant.ts',
  '  const session = await http<UserSession>({ method: "GET", url: "/api/multiTenant/user/session", headers: { "Accept-Language": locale.value } });',
  '  const session: UserSession = { user: null, publicWeb: false, host: false, enabled: false, registrationEnabled: false };');
patch('apps/web/src/bootstrap/multiTenant.ts',
  '  } else if (!session.publicWeb && (session.enabled || window.location.hash.startsWith("#/multiTenant"))) {',
  '  } else if (session.enabled) {');
patch('apps/server/src/routes/nodes/get.ts', 'url: `/api/nodes/files?name=${name}`,',
  'url: `/plugins/toonflow/api/nodes/files?name=${name}`,');
// Keep the checked file/access queue; a fixed root avoids treating private ancestors as requested dotfiles.
patch('apps/server/src/routes/nodes/files.ts', '  await sendFile(res, filePath);',
  '  await sendFile(res, `${name}.umd.js`, { root: nodesDirectory });');
patch('apps/server/src/routes/workspaces/files/write.ts',
  '    await u.workspaceFile.writeWorkspaceFile(path, bytes, req.query.exclusive === "true");',
  `    if (!req.query.encoding || req.query.encoding === "utf-8") {
      const { projectCanvasTaskMetadata } = await import("@/greenroom-managed");
      const { writeAtomicSync } = await import("@toonflow/file");
      // No await between the latest job snapshot and the native commit: fill shares this event loop.
      const canvasBytes = projectCanvasTaskMetadata(directory, bytes, path);
      if (canvasBytes !== undefined) {
        bytes = canvasBytes;
        writeAtomicSync(path, bytes, { exclusive: req.query.exclusive === "true" });
      } else await u.workspaceFile.writeWorkspaceFile(path, bytes, req.query.exclusive === "true");
    } else await u.workspaceFile.writeWorkspaceFile(path, bytes, req.query.exclusive === "true");`);
patch('apps/web/vite.config.ts', 'export default defineConfig(({ command }) => ({', 'export default defineConfig(({ command }) => ({\n  base: "/plugins/toonflow/",');
function prefix(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, item.name);
    if (item.isDirectory()) prefix(filename);
    else if (/\.(?:ts|vue)$/.test(item.name)) {
      const source = readFileSync(filename, 'utf8');
      writeFileSync(filename, source.replace(/(["'`])\/api(?=[/"'`])/g, '$1/plugins/toonflow/api'));
    }
  }
}
prefix(join(root, 'apps/web/src'));
prefix(join(root, 'packages/nodeScaffold/src'));
prefix(join(root, 'packages/nodes'));
// Upstream now detaches normal node disposal itself. Managed cancel remains a no-op for accepted jobs.
patch('apps/web/src/components/settings/index.vue', 'const settingsPanels = computed(() => allSettingsPanels.filter(item => {',
  `const settingsPanels = computed(() => allSettingsPanels.filter(item => {
  if (['account', 'multiTenant', 'languageModel', 'mediaModel', 'pluginMarket', 'mcp', 'network', 'deviceLink', 'developer'].includes(item.id)) return false;`);
patch('apps/web/src/pages/workspace/index.vue', 'const agentVisible = ref(true);', 'const agentVisible = ref(false);');
patch('apps/web/src/pages/workspace/index.vue', '<floatingAgent v-model="agentVisible"', '<floatingAgent v-if="false" v-model="agentVisible"');
patch('apps/web/src/pages/workspace/index.vue', '<el-tooltip v-if="!agentVisible" content="Toonflow Agent"', '<el-tooltip v-if="false" content="Toonflow Agent"');
for (const node of ['imageGenerationNode', 'videoGenerationNode', 'audioGenerationNode']) {
  const file = `packages/nodes/${node}/src/index.vue`;
  patch(file, '    <template #topActions>', '    <div v-if="data.greenroomTask?.error" role="alert" style="white-space:pre-wrap;color:var(--el-color-danger);padding:8px">{{ data.greenroomTask.error }}</div>\n    <div v-if="selectionConflict" role="alert" style="white-space:pre-wrap;color:var(--el-color-danger);padding:8px">生成已完成，但节点或引用已变化；原任务和产物已保留，未覆盖当前选择。</div>\n    <template #topActions>');
}

patch('apps/server/src/utils/ai/index.ts', '      let body = payload as Record<string, unknown>;', '      const { textDefaults } = await import("@/greenroom-managed");\n      let body = { ...textDefaults(), ...payload as Record<string, unknown> };');

patch('packages/nodes/audioGenerationNode/src/audioSettings.ts', 'export const formatOptions = ["wav", "mp3", "pcm", "ogg_opus"];', 'export const formatOptions = ["wav", "mp3", "flac", "opus"];');
patch('packages/nodes/audioGenerationNode/src/components/generationSettings.vue', 'pcm: "PCM", ogg_opus: "Ogg Opus"', 'flac: "FLAC", opus: "Opus"');
patch('packages/nodes/audioGenerationNode/src/index.vue', 'noDataText="请先在设置中添加音频模型"', 'noDataText="管理员尚未启用语音或音乐模型"');

// Managed synchronous text records must not replay an unconfirmed POST. Other callers retain native defaults.
patch('apps/server/src/utils/ai/index.ts', '  references: Awaited<ReturnType<typeof readAiReferences>> = [],\n)', '  references: Awaited<ReturnType<typeof readAiReferences>> = [],\n  maxRetries = 3,\n  onResponse?: (response: Response) => void,\n)');
patch('apps/server/src/utils/ai/index.ts', '    maxRetries: configured.route ? 0 : 3,', '    maxRetries: configured.route ? 0 : maxRetries,');

// pi-ai exposes a fetch hook; capture headers before its SSE parser consumes the body.
patch('apps/server/src/utils/ai/index.ts', '      return files.fetch(input, init);', `      const response = files.fetch(input, init);
      return onResponse ? response.then(value => { onResponse(value); return value; }) : response;`);

// New provider image/video outputs keep their original Asset identity. Native paths stay usable.
copyFileSync(new URL('mediaCache.ts', import.meta.url), join(root, 'apps/server/src/mediaCache.ts'));
copyFileSync(new URL('../../shared/media-storage.mjs', import.meta.url), join(root, 'apps/server/src/greenroomMediaStorage.mjs'));
patch('apps/server/src/routes/workspaces/files/read.ts',
  '  const file = await lstat(path);',
  `  const { mediaReference } = await import("@/greenroom-managed");
  const asset = req.query.snapshot === "true" ? null : await mediaReference(path);
  if (asset) { res.set("Cache-Control", "no-store").redirect(307, asset.fileUrl); return; }
  const file = await lstat(path);`);
patch('apps/server/src/routes/workspaces/files/list.ts',
  '  const entries = await readdir(path, { withFileTypes: true });',
  `  const { mediaListing } = await import("@/greenroom-managed");
  const entries = mediaListing(directory, path, await readdir(path, { withFileTypes: true }));`);
patch('apps/server/src/routes/workspaces/files/write.ts', '  try {\n    let bytes =',
  `  try {
    const { mutateMediaFiles, finishMediaCanvas } = await import("@/greenroom-managed");
    await mutateMediaFiles(directory, [path], [path], async () => {
    let bytes =`);
patch('apps/server/src/routes/workspaces/files/write.ts',
  '    if (req.query.expectedRevision) revision = createHash("sha256").update(bytes).digest("hex");\n  }',
  `    if (req.query.expectedRevision) revision = createHash("sha256").update(bytes).digest("hex");
    });
    await finishMediaCanvas(directory);
  }`);
for (const method of ['copy', 'rename']) {
  const name = method === 'copy' ? 'copyWorkspaceFile' : 'renameWorkspaceFile';
  patch(`apps/server/src/routes/workspaces/files/${method}.ts`,
    `  try { await u.workspaceFile.${name}(source.path, target.path); }`,
    `  try {
    const { mutateMediaFiles } = await import("@/greenroom-managed");
    await mutateMediaFiles(source.directory, [source.path, target.path], [${method === 'rename' ? 'source.path, ' : ''}target.path],
      () => u.workspaceFile.${name}(source.path, target.path));
  }`);
}
patch('apps/server/src/routes/workspaces/files/remove.ts',
  '    await u.workspaceFile.removeWorkspaceFile(directory, path, req.body.recursive === true);',
  `    const { mutateMediaFiles } = await import("@/greenroom-managed");
    await mutateMediaFiles(directory, [path], [path], () => u.workspaceFile.removeWorkspaceFile(directory, path, req.body.recursive === true));`);
patch('apps/server/src/routes/workspaces/files/export.ts',
  '  const files: Record<string, Uint8Array> = Object.create(null);',
  `  const { exportMediaFiles } = await import("@/greenroom-managed");
  return exportMediaFiles(directory, res, async () => {
  const files: Record<string, Uint8Array> = Object.create(null);`);
patch('apps/server/src/routes/workspaces/files/export.ts',
  '  res.set("Cache-Control", "no-store").attachment(`${basename(directory) || "项目"}.zip`).send(Buffer.from(bytes));',
  '  res.set("Cache-Control", "no-store").attachment(`${basename(directory) || "项目"}.zip`).send(Buffer.from(bytes));\n  });');
patch('apps/server/src/utils/media/generation.ts',
  '  const info = await stat(path);',
  '  const { withMediaFiles } = await import("@/greenroom-managed");\n  return withMediaFiles(cwd, async () => {\n  const info = await stat(path);');
patch('apps/server/src/utils/media/generation.ts',
  '  return { type: "base64", data: bytes.toString("base64"), mimeType, name: reference.path };',
  '  return { type: "base64" as const, data: bytes.toString("base64"), mimeType, name: reference.path };\n  }, [path]);');
patch('apps/server/src/utils/ffmpeg/index.ts',
  '  await executeFfmpegInWorker(cwd, tools, request, emit, signal);',
  `  const { withMediaFiles } = await import("@/greenroom-managed");
  // Restore the precise registered set, including indirect filter/concat inputs; native restrictions remain.
  await withMediaFiles(cwd, () => executeFfmpegInWorker(cwd, tools, request, emit, signal));`);
patch('packages/ffmpeg/src/workerClient.ts',
  '    for (const task of [...pending.values()]) task.finish(error);',
  '    for (const task of [...pending.values()]) task.finish(Object.assign(error, { mediaLeaseUnknown: true }));');
copyFileSync(new URL('mediaStorage.d.mts', import.meta.url), join(root, 'apps/server/src/greenroomMediaStorage.d.mts'));
