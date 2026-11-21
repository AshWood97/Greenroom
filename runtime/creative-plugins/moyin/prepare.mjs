import { patchManagedShotWriteback } from './shot-writeback-patch.mjs';
import { patchManagedAngles } from './angle-switch-patch.mjs';
import { readFileSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
function edit(file, before, after) { const filename = join(root, file); const source = readFileSync(filename, 'utf8').replaceAll('\r\n', '\n'); if (!source.includes(before)) throw new Error(`魔因适配位置已变化：${file}`); writeFileSync(filename, source.replace(before, after)); }
for (const [source, target] of [['startup.mjs','greenroom-startup.mjs'], ['server.mjs','greenroom-server.mjs'], ['worker.ts','src/greenroom-worker.ts'], ['web.ts','src/greenroom-web.ts']]) copyFileSync(new URL(source, import.meta.url), join(root, target));
copyFileSync(new URL('quad-context.ts', import.meta.url), join(root, 'src/lib/ai/greenroom-quad-context.ts'));
copyFileSync(new URL('../../shared/generation-error.ts', import.meta.url), join(root, 'greenroom-generation-error.ts'));
cpSync(new URL('.', import.meta.url), join(root, 'greenroom-integration'), { recursive: true });
edit('src/main.tsx', "import App from './App.tsx'", "import './greenroom-web';\nconst { default: App } = await import('./App.tsx');");
// The browser has no Electron local-image protocol. Keep persisted private refs,
// but display them through the existing authenticated member media route.
edit('src/hooks/use-resolved-image-url.ts', 'export function useResolvedImageUrl(', `export function resolveLocalMediaUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  return rawUrl.startsWith('local-image://') ? import.meta.env.BASE_URL + 'media/' + rawUrl.slice('local-image://'.length) : rawUrl;
}

export function useResolvedImageUrl(`);
edit('src/hooks/use-resolved-image-url.ts', '    return rawUrl;', '    return resolveLocalMediaUrl(rawUrl);');
edit('src/components/ui/local-image.tsx', 'import { useState } from "react";', 'import { useEffect, useState } from "react";\nimport { useResolvedImageUrl } from "@/hooks/use-resolved-image-url";');
edit('src/components/ui/local-image.tsx', '  const [currentSrc, setCurrentSrc] = useState(src);', '  const [currentSrc, setCurrentSrc] = useState(src);\n  const displaySrc = useResolvedImageUrl(currentSrc);');
edit('src/components/ui/local-image.tsx', '      src={currentSrc}', '      src={displaySrc || undefined}');
edit('src/components/ui/local-image.tsx', '  if (src !== currentSrc && !error) {\n    setCurrentSrc(src);\n  }', '  useEffect(() => { setError(false); setCurrentSrc(src); }, [src]);');
for (const file of ['characters/character-card.tsx', 'characters/character-detail.tsx', 'characters/character-gallery.tsx', 'characters/wardrobe-modal.tsx', 'scenes/generation-panel.tsx', 'director/media-preview-modal.tsx']) {
 const path = join(root, 'src/components/panels', file);
 let source = readFileSync(path, 'utf8');
 if (!source.includes('"@/components/ui/local-image"')) source = source.replace('"use client";', '"use client";\nimport { LocalImage } from "@/components/ui/local-image";');
 if (!source.includes('"@/components/ui/local-image"') || !/<img\b/.test(source)) throw new Error('魔因图片展示适配位置已变化：' + file);
 writeFileSync(path, source.replace(/<img\b/g, '<LocalImage'));
}
// Native videos use the same persisted local-image protocol. Resolve at display
// boundaries without changing refs, playback controls, or timeline/drag state.
for (const [file, fields] of [
 ['PreviewPanel.tsx', ['previewItem.url']], ['SimpleTimeline.tsx', ['clip.thumbnailUrl']], ['ui/video-player.tsx', ['src', 'poster']],
 ['panels/director/media-preview-modal.tsx', ['videoUrl']], ['panels/director/split-scene-card.tsx', ['scene.videoUrl']],
 ['panels/director/shot-grid-view.tsx', ['activeShot.videoUrl || activeShot.interval?.videoUrl']],
 ['panels/sclass/sclass-scene-card.tsx', ['scene.videoUrl']], ['panels/sclass/shot-group.tsx', ['group.videoUrl']],
 ['panels/sclass/extend-edit-dialog.tsx', ['sourceGroup.videoUrl']], ['panels/freedom/GenerationHistory.tsx', ['entry.resultUrl']],
 ['panels/freedom/VideoStudio.tsx', ['videoResult']],
]) {
 const path = join(root, 'src/components', file);
 let source = readFileSync(path, 'utf8');
 if (!/^import /m.test(source)) throw new Error('魔因视频展示导入位置已变化：' + file);
 source = source.replace(/^import /m, 'import { resolveLocalMediaUrl } from "@/hooks/use-resolved-image-url";\nimport ');
 for (const field of fields) {
  const attribute = field === 'poster' ? 'poster' : 'src';
  const original = attribute + '={' + field + '}';
  if (!source.includes(original)) throw new Error('魔因视频展示引用位置已变化：' + file + ':' + field);
  source = source.replaceAll(original, attribute + '={resolveLocalMediaUrl(' + field + ') || undefined}');
 }
 writeFileSync(path, source);
}
// Preserve partial exports, but never turn a failed file into a full-success toast
// or silently replay the folder export as downloads after files were already written.
{
 const path = join(root, 'src/lib/script/export-service.ts');
 let source = readFileSync(path, 'utf8');
 for (const [line, filename, count] of [
  ['console.error(`Failed to download ${file.filename}:`, error);', 'file.filename', 1],
  ['console.error(`Failed to save ${filename}:`, error);', 'filename', 2],
  ['console.error(`[ExportService] Failed to save ${filename}:`, error);', 'filename', 3],
  ['console.error(`[ExportService] Failed to download ${file.filename}:`, error);', 'file.filename', 1],
 ]) {
  if (source.split(line).length - 1 !== count) throw new Error('魔因导出错误位置已变化：' + line);
  source = source.replaceAll(line, line + "\n          throw Object.assign(new Error('部分素材未导出：' + " + filename + " + '；已导出文件保留。原因：' + ((error as Error).message || '未知错误')), { code: 'GREENROOM_EXPORT_PARTIAL' });");
 }
 for (const line of ["console.error('[ExportService] Export failed:', error);", "console.error('[ExportService] Director export failed:', error);"]) {
  if (!source.includes(line)) throw new Error('魔因导出回退位置已变化');
  source = source.replace(line, "if ((error as { code?: string }).code === 'GREENROOM_EXPORT_PARTIAL') throw error;\n    " + line);
 }
 writeFileSync(path, source);
}
// Both the renderer and headless worker resolve the same member-authorized model bindings.
edit('src/lib/ai/feature-router.ts', '  const store = useAPIConfigStore.getState();\n  const providersWithModels', `  const controlled = (globalThis as any).greenroomCatalog;
  if (controlled) {
    const kind = ['character_generation','scene_generation','freedom_image'].includes(feature) ? 'image' : ['video_generation','freedom_video'].includes(feature) ? 'video' : 'llm';
    const ids = controlled.models[kind] || [];
    const baseUrl = (globalThis as any).greenroomWorker ? 'http://127.0.0.1:18803/managed/v1' : import.meta.env.BASE_URL + 'managed/v1';
    const provider = { id: 'greenroom', name: 'Greenroom 托管', platform: 'memefast', apiKey: 'greenroom-managed', baseUrl, model: ids, enabled: true };
    return ids.map((model: string) => ({ feature, featureName: AI_FEATURES.find(item => item.key === feature)?.name || feature, provider, apiKey: 'greenroom-managed', allApiKeys: ['greenroom-managed'], keyManager: getProviderKeyManager('greenroom', 'greenroom-managed', feature), platform: 'memefast', baseUrl, models: [model], model })) as FeatureConfig[];
  }
  const store = useAPIConfigStore.getState();
  const providersWithModels`);
edit('src/lib/ai/feature-router.ts', '  if (configs.length === 0) {', "  if ((globalThis as any).greenroomCatalog) return configs[0] || null;\n  if (configs.length === 0) {");
// UI calls submit the same durable operations that MCP uses. The worker executes upstream services.
edit('src/lib/script/full-script-service.ts', '): Promise<ImportResult> {\n  try {', "): Promise<ImportResult> {\n  if (!(globalThis as any).greenroomWorker) return (globalThis as any).greenroomBusiness('import_script', { projectId, text: fullText, options: importSettings });\n  try {");
edit('src/lib/script/full-script-service.ts', '): Promise<GenerateEpisodeShotsResult> {\n  const store', "): Promise<GenerateEpisodeShotsResult> {\n  if (!(globalThis as any).greenroomWorker) return (globalThis as any).greenroomBusiness('generate_episode_shots', { projectId, episodeIndex, options });\n  const store");
edit('src/lib/script/full-script-service.ts', '): Promise<ShotCalibrationResult> {\n  const store', "): Promise<ShotCalibrationResult> {\n  if (!(globalThis as any).greenroomWorker) return (globalThis as any).greenroomBusiness('calibrate_shots', { projectId, episodeIndex, options, sceneId: filterSceneId });\n  const store");
edit('src/lib/script/full-script-service.ts', '): Promise<CalibrationResult> {\n  const store', "): Promise<CalibrationResult> {\n  if (!(globalThis as any).greenroomWorker) return (globalThis as any).greenroomBusiness('calibrate_titles', { projectId, options: _options });\n  const store");
edit('src/lib/script/full-script-service.ts', '): Promise<SynopsisGenerationResult> {\n  const store', "): Promise<SynopsisGenerationResult> {\n  if (!(globalThis as any).greenroomWorker) return (globalThis as any).greenroomBusiness('episode_synopses', { projectId, options: _options });\n  const store");
edit('src/lib/script/script-parser.ts', '): Promise<ScriptData> {\n  // 构建场景数量限制提示', "): Promise<ScriptData> {\n  if (!(globalThis as any).greenroomWorker) return (globalThis as any).greenroomBusiness('parse_script', { text: rawScript, options });\n  // 构建场景数量限制提示");
edit('src/components/panels/script/index.tsx', '      // 1. 规则解析导入（把用户选的风格和语言一起传进去）', `      if (!(globalThis as any).greenroomWorker) {
        const result = await (globalThis as any).greenroomBusiness('import_script', { projectId, text, options: { styleId, promptLanguage, targetDuration }, completeWorkflow: true });
        setImportStatus('ready');
        toast.success(\`导入完成: \${result.episodes.length} 集, \${result.scriptData?.characters.length || 0} 角色, \${result.scriptData?.scenes.length || 0} 场景\`);
        return;
      }
      // 1. 规则解析导入（把用户选的风格和语言一起传进去）`);
edit('src/components/panels/script/index.tsx', '      // Pass all API keys (comma-separated) for rotation\n      const allKeysString', `      if (!(globalThis as any).greenroomWorker) {
        const result = await (globalThis as any).greenroomBusiness('parse_script', { projectId, text: rawScript, options: { language, sceneCount: sceneCount ? parseInt(sceneCount) : undefined, shotCount: shotCount ? parseInt(shotCount) : undefined, targetDuration, styleId }, generateShots: true });
        setParseStatus(projectId, "ready");
        toast.success(\`解析与分镜完成: \${result.characters.length} 角色, \${result.scenes.length} 场景\`);
        return;
      }
      // Pass all API keys (comma-separated) for rotation
      const allKeysString`);
edit('src/components/panels/script/index.tsx', "    const state = useScriptStore.getState().projects[activeProjectId]?.calibrationState;", "    if ((globalThis as any).greenroomCatalog) return;\n    const state = useScriptStore.getState().projects[activeProjectId]?.calibrationState;");
// Intercept paid submission before the original retry loops. Prompt composition stays native; shot selection uses the member compare-and-write boundary.
edit('src/lib/script/shot-generator.ts', 'export interface ShotGenerationConfig {', 'export interface ShotGenerationConfig {\n  greenroomProjectId?: string;');
edit('src/lib/script/shot-generator.ts', "  const { apiKey, baseUrl, model, aspectRatio = '16:9', styleTokens", "  if (!(globalThis as any).greenroomWorker) return (await (globalThis as any).greenroomBusiness('shot_image', { ...(config.greenroomProjectId ? { projectId: config.greenroomProjectId } : {}), shot, config })).url;\n  const { apiKey, baseUrl, model, aspectRatio = '16:9', styleTokens");
edit('src/lib/script/shot-generator.ts', "  const { apiKey, baseUrl, model, aspectRatio = '16:9', referenceImages", "  if (!(globalThis as any).greenroomWorker) return (await (globalThis as any).greenroomBusiness('shot_video', { ...(config.greenroomProjectId ? { projectId: config.greenroomProjectId } : {}), shot, imageUrl, config })).url;\n  const { apiKey, baseUrl, model, aspectRatio = '16:9', referenceImages");
edit('src/lib/script/shot-generator.ts', '  // Use retry wrapper for 429 rate limit handling', "  if ((globalThis as any).greenroomWorker) return (await (globalThis as any).greenroomGenerate('image', requestData)).url;\n  // Use retry wrapper for 429 rate limit handling");
const shotFile = join(root, 'src/lib/script/shot-generator.ts');
let shotSource = readFileSync(shotFile, 'utf8');
const videoIndex = shotSource.indexOf('export async function generateShotVideo');
shotSource = shotSource.slice(0, videoIndex) + shotSource.slice(videoIndex).replace('  // Use retry wrapper for 429 rate limit handling', "  if ((globalThis as any).greenroomWorker) return (await (globalThis as any).greenroomGenerate('video', requestBody)).url;\n  // Use retry wrapper for 429 rate limit handling");
writeFileSync(shotFile, shotSource);
edit('src/lib/ai/image-generator.ts', '  const featureConfig = getFeatureConfig(feature);', "  if ((globalThis as any).greenroomWorker) { const result = await (globalThis as any).greenroomGenerate('image', params); return { imageUrl: result.url, taskId: result.taskId }; }\n  return (globalThis as any).greenroomMedia('image', params);\n  const featureConfig = getFeatureConfig(feature);");
edit('src/lib/ai/image-generator.ts', '  const { model, prompt, apiKey, baseUrl, aspectRatio, resolution, referenceImages, keyManager, signal } = params;', "  if ((globalThis as any).greenroomWorker) { const result = await (globalThis as any).greenroomGenerate('image', params); return { imageUrl: result.url, taskId: result.taskId }; }\n  return (globalThis as any).greenroomMedia('image', params);\n  const { model, prompt, apiKey, baseUrl, aspectRatio, resolution, referenceImages, keyManager, signal } = params;");
edit('src/components/panels/SettingsPanel.tsx', 'useState<string>("api")', 'useState<string>("advanced")');
const settingsFile = join(root, 'src/components/panels/SettingsPanel.tsx');
writeFileSync(settingsFile, readFileSync(settingsFile, 'utf8').replace(/(<TabsTrigger\s+value="(?:api|imagehost|storage)")/g, '$1 style={{display:"none"}}').replace(/(<TabsContent value="(?:api|imagehost|storage)")/g, '$1 style={{display:"none"}}'));
const indexed = `// Member-persistent replacement of the desktop IndexedDB store.\nimport { StorageAdapter } from './types';\nexport class IndexedDBAdapter<T> implements StorageAdapter<T> {\n constructor(private dbName: string, private storeName: string, _version = 1) {}\n private get namespace() { return this.dbName + '/' + this.storeName; }\n get(key: string): Promise<T | null> { return (globalThis as any).greenroomDb.get(this.namespace, key); }\n async set(key: string, value: T): Promise<void> { await (globalThis as any).greenroomDb.set(this.namespace, key, value); }\n async remove(key: string): Promise<void> { await (globalThis as any).greenroomDb.remove(this.namespace, key); }\n list(): Promise<string[]> { return (globalThis as any).greenroomDb.list(this.namespace); }\n async clear(): Promise<void> { await (globalThis as any).greenroomDb.clear(this.namespace); }\n}\n`;
writeFileSync(join(root, 'src/lib/storage/indexeddb-adapter.ts'), indexed);
writeFileSync(join(root, 'src/lib/storage/opfs-adapter.ts'), `// Member-private binary storage used by the original editor.\nimport { StorageAdapter } from './types';\nexport class OPFSAdapter implements StorageAdapter<File> {\n constructor(private directoryName = 'media') {}\n private url(key = '') { return import.meta.env.BASE_URL + 'api/greenroom/files?directory=' + encodeURIComponent(this.directoryName) + '&key=' + encodeURIComponent(key); }\n async get(key: string): Promise<File | null> { const response = await fetch(this.url(key)); if (response.status === 404) return null; if (!response.ok) throw new Error('媒体读取失败：' + response.status); return new File([await response.blob()], response.headers.get('x-file-name') ? decodeURIComponent(response.headers.get('x-file-name')!) : key, { type: response.headers.get('content-type') || '' }); }\n async set(key: string, file: File): Promise<void> { const response = await fetch(this.url(key), { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file }); if (!response.ok) throw new Error('媒体保存失败：' + response.status); }\n async remove(key: string): Promise<void> { const response = await fetch(this.url(key), { method: 'DELETE' }); if (!response.ok) throw new Error('媒体删除失败：' + response.status); }\n async list(): Promise<string[]> { const response = await fetch(this.url()); if (!response.ok) throw new Error('媒体目录读取失败：' + response.status); return response.json(); }\n async clear(): Promise<void> { for (const key of await this.list()) await this.remove(key); }\n static isSupported() { return true; }\n}\n`);
writeFileSync(join(root, 'vite.greenroom.config.ts'), `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport path from 'node:path';\nexport default defineConfig({ base: '/plugins/moyin/', plugins: [react()], build: { target: 'esnext' }, resolve: { alias: { '@': path.resolve(__dirname, 'src'), '@opencut/ai-core': path.resolve(__dirname, 'src/packages/ai-core') } } });\n`);

// Engineering data always comes from the authenticated member service; browser migration is disabled.
writeFileSync(join(root, 'src/lib/indexed-db-storage.ts'), `import type { StateStorage } from 'zustand/middleware';
export const fileStorage: StateStorage = {
 getItem: (key: string) => window.fileStorage!.getItem(key),
 setItem: async (key: string, value: string) => { await window.fileStorage!.setItem(key, value); },
 removeItem: async (key: string) => { await window.fileStorage!.removeItem(key); },
};
export const indexedDBStorage = fileStorage;
`);
for (const store of ['freedom-store', 'props-library-store', 'theme-store', 'panel-store']) {
 const filename = join(root, 'src/stores/' + store + '.ts');
 let source = readFileSync(filename, 'utf8');
 source = "import { fileStorage } from '@/lib/indexed-db-storage';\nimport { createJSONStorage as greenroomJSONStorage } from 'zustand/middleware';\n" + source;
 source = source.replace(/(name: ["'](?:moyin-freedom|moyin-props-library|moyin-theme|panel-sizes)["'],)/, '$1\n      storage: greenroomJSONStorage(() => fileStorage),');
 writeFileSync(filename, source);
}
edit('src/stores/custom-style-store.ts', 'createJSONStorage(() => localStorage)', 'createJSONStorage(() => greenroomFileStorage)');
const styleFile = join(root, 'src/stores/custom-style-store.ts');
writeFileSync(styleFile, "import { fileStorage as greenroomFileStorage } from '@/lib/indexed-db-storage';\n" + readFileSync(styleFile, 'utf8'));
// The image selector reads the member catalog so unknown channel IDs show their directory names; IDs and calls stay native.
edit('src/components/panels/freedom/ModelSelector.tsx', "import { getModelDisplayName } from '@/lib/freedom/model-display-names';", "import { getModelDisplayName } from '@/lib/freedom/model-display-names';\nfunction greenroomLabel(type: 'image' | 'video', model: string): string | undefined {\n  if (type !== 'image') return undefined;\n  const rows = (globalThis as any).greenroomCatalog?.catalog?.image || [];\n  const row = rows.find((item: { id: string }) => item.id === model);\n  if (!row?.label) return undefined;\n  const same = rows.filter((item: { label?: string }) => item.label === row.label);\n  if (same.length < 2) return row.label;\n  const channel = row.provider_label && same.filter((item: { provider_label?: string }) => item.provider_label === row.provider_label).length === 1 ? row.provider_label : row.id;\n  return `${row.label} (${channel})`;\n}");
edit('src/components/panels/freedom/ModelSelector.tsx', "name: getModelDisplayName(expandedModel),", "name: greenroomLabel(type, expandedModel) || getModelDisplayName(expandedModel),");
edit('src/components/panels/freedom/ModelSelector.tsx', "{selectedModel ? selectedModel.name : value ? getModelDisplayName(value) : '选择模型...'}", "{selectedModel ? selectedModel.name : value ? greenroomLabel(type, value) || getModelDisplayName(value) : '选择模型...'}");
// Keep creative defaults in the member profile; provider credentials and bindings are server-controlled.
edit('src/stores/api-config-store.ts', "import { persist } from 'zustand/middleware';", "import { persist, createJSONStorage } from 'zustand/middleware';\nimport { fileStorage } from '@/lib/indexed-db-storage';");
edit('src/stores/api-config-store.ts', "name: 'opencut-api-config',", "name: 'moyin-creative-settings',\n      storage: createJSONStorage(() => fileStorage),");
const apiConfigFile = join(root, 'src/stores/api-config-store.ts');
writeFileSync(apiConfigFile, readFileSync(apiConfigFile, 'utf8').replace(/^\s*(?:providers|featureBindings|apiKeys|imageHostProviders): state\.[^\n]+\n/gm, ''));
edit('src/lib/image-host.ts', "  const store = useAPIConfigStore.getState();\n  const targetProvider", "  return (window as any).imageHostUploader.upload({ imageData, options });\n  const store = useAPIConfigStore.getState();\n  const targetProvider");
edit('src/lib/image-host.ts', '  return useAPIConfigStore.getState().isImageHostConfigured();', '  return true; // The authenticated member media service is always available.');
edit('src/stores/api-config-store.ts', '      isImageHostConfigured: () => {', '      isImageHostConfigured: () => {\n        return true;');
edit('src/components/panels/director/use-video-generation.ts', "  const featureConfig = getFeatureConfig('video_generation');\n  const resolvedPlatform", `  const managed = await (globalThis as any).greenroomMedia('video', { prompt, duration, aspectRatio, image_with_roles: imageWithRoles, resolution: videoResolution, reference_video_urls: videoRefs, reference_audio_urls: audioRefs, generate_audio: enableAudio });
  onProgress?.(100);
  return managed.videoUrl;
  const featureConfig = getFeatureConfig('video_generation');
  const resolvedPlatform`);
edit('src/components/panels/director/use-video-generation.ts', "  const apiBaseUrl = baseUrl?.replace(/\\/+$/, '');", "  const managed = await (globalThis as any).greenroomMedia('video', { prompt, aspectRatio, model, image_with_roles: imageWithRoles });\n  onProgress?.(100);\n  return managed.videoUrl;\n  const apiBaseUrl = baseUrl?.replace(/\\/+$/, '');");
edit('src/components/panels/director/use-video-generation.ts', "  const resolvedUrl = videoUrl;\n  console.log('[VideoGen] Loading video for frame extraction:', resolvedUrl);", "  const resolvedUrl = videoUrl.startsWith('local-image://') ? await window.imageStorage?.getImagePath(videoUrl) || videoUrl : videoUrl;\n  console.log('[VideoGen] Loading video for frame extraction:', resolvedUrl);");
edit('src/lib/freedom/freedom-api.ts', "  const { config } = resolveFreedomFeatureConfig('freedom_image', 'character_generation', params.model);", "  const output = await (globalThis as any).greenroomBusiness('generate_image', { prompt: params.prompt, options: { ...params.extraParams, ...params } });\n  return { url: output.url, taskId: output.taskId, mediaId: output.mediaId };\n  const { config } = resolveFreedomFeatureConfig('freedom_image', 'character_generation', params.model);");
edit('src/lib/freedom/freedom-api.ts', "  const { config } = resolveFreedomFeatureConfig('freedom_video', 'video_generation', params.model);", "  const output = await (globalThis as any).greenroomBusiness('generate_video', { prompt: params.prompt, options: params });\n  return { url: output.url, taskId: output.taskId, mediaId: output.mediaId };\n  const { config } = resolveFreedomFeatureConfig('freedom_video', 'video_generation', params.model);");
edit('src/stores/character-library-store.ts', "import { migrateFromLocalStorage } from '@/lib/indexed-db-storage';", '// Member data is read from the authenticated file store.');
edit('src/stores/character-library-store.ts', "        migrateFromLocalStorage('moyin-character-library');", '        // Browser migration is disabled for member isolation.');
edit('src/lib/ai/feature-router.ts', '  return `请先在设置中为「${featureName}」功能绑定 API 供应商`;', '  return `管理员尚未启用「${featureName}」模型，请联系管理员`;');

patchManagedAngles(root);
patchManagedShotWriteback(root);
for (const file of ['local-outputs.mjs', 'quad-split.mjs', 'shot-writeback.mjs']) copyFileSync(new URL(file, import.meta.url), join(root, file));
edit('src/lib/script/export-service.ts', 'async function downloadFile(url: string): Promise<Blob> {', `async function downloadFile(url: string): Promise<Blob> {\n  if ((globalThis as any).greenroomReadExport) return (globalThis as any).greenroomReadExport(url);`);
