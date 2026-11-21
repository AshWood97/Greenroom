import { readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
const edit = (file, before, after) => {
  const filename = join(root, file);
  const source = readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
  if (!source.includes(before)) throw new Error(`LocalMiniDrama 适配位置已变化：${file}`);
  writeFileSync(filename, source.replace(before, after));
};
// Keep the pinned lockfile versions and integrity while using npm's official
// registry with TLS verification, without the upstream SQLite binary mirror.
for (const directory of ['backend-node', 'frontweb']) {
  const lockfile = join(root, directory, 'package-lock.json');
  writeFileSync(lockfile, readFileSync(lockfile, 'utf8').replaceAll('https://registry.npmmirror.com/', 'https://registry.npmjs.org/'));
  writeFileSync(join(root, directory, '.npmrc'), 'registry=https://registry.npmjs.org/\nstrict-ssl=true\n');
}
for (const [source, target] of [['managed.cjs', 'greenroom-managed.cjs'], ['start.cjs', 'greenroom-start.cjs'], ['final-archive.cjs', 'greenroom-final-archive.cjs'], ['final-cache.cjs', 'greenroom-final-cache.cjs']])
  copyFileSync(new URL(source, import.meta.url), join(root, 'backend-node', target));
copyFileSync(new URL('../../shared/media-storage.mjs', import.meta.url), join(root, 'backend-node/greenroom-media-storage.mjs'));
copyFileSync(new URL('../../shared/generation-error.ts', import.meta.url), join(root, 'backend-node/greenroom-generation-error.ts'));

edit('backend-node/src/config/index.js', '  return parsed;', `  const memberRoot = process.env.GREENROOM_PLUGIN_ROOT;
  parsed.app.debug = false;
  parsed.server = { ...parsed.server, host: '127.0.0.1', port: 18805, insecure_tls: false, cors_origins: [] };
  parsed.database.path = path.join(memberRoot, 'localminidrama.sqlite3');
  parsed.storage = { type: 'local', local_path: path.join(memberRoot, 'storage'), base_url: (process.env.GREENROOM_BASE_PATH || '/plugins/localminidrama/') + 'static' };
  parsed.vendor_lock = { enabled: false };
  parsed.image_proxy = { use_for_video: false };
  return parsed;`);
edit('backend-node/src/app.js', '  const log = logger;', `  const log = logger;
  const managed = require('../greenroom-managed.cjs');
  managed.seed(db, log);`);
edit('backend-node/src/app.js', "  app.use(express.urlencoded({ extended: true }));", "  app.use(express.urlencoded({ extended: true }));\n  managed.install(app, db, log);\n  managed.restore(db, log);");
edit('backend-node/src/services/imageClient.js', 'async function callImageApi(db, log, opts) {', `async function callImageApi(db, log, opts) {
  return require('../../greenroom-managed.cjs').image(db, log, opts);
}
async function unmanagedCallImageApi(db, log, opts) {`);
edit('backend-node/src/services/videoClient.js', 'async function callVideoApi(db, log, opts) {', `async function callVideoApi(db, log, opts) {
  return require('../../greenroom-managed.cjs').video(db, log, opts);
}
async function unmanagedCallVideoApi(db, log, opts) {`);
edit('backend-node/src/services/videoClient.js', 'async function pollVideoTask(db, log, videoGenId, taskId, config, maxAttempts = 300, intervalMs = 10000) {', `async function pollVideoTask(db, log, videoGenId, taskId, config, maxAttempts = 300, intervalMs = 10000) {
  return require('../../greenroom-managed.cjs').poll(db, log, videoGenId, taskId, config, maxAttempts, intervalMs);
}
async function unmanagedPollVideoTask(db, log, videoGenId, taskId, config, maxAttempts = 300, intervalMs = 10000) {`);
edit('backend-node/src/services/taskService.js', '  for (const row of rows) {\n    updateTaskError', `  for (const row of rows) {
    if (['image_generation', 'video_generation'].includes(row.type)) continue;
    if (row.type === 'video_merge' && db.prepare(\"SELECT 1 FROM greenroom_merge_delivery d JOIN video_merges m ON m.id=d.merge_id AND m.task_id=d.task_id WHERE d.task_id=? AND m.status='completed' AND m.deleted_at IS NULL\").get(row.id)) continue;
    updateTaskError`);
edit('backend-node/src/services/imageService.js', 'async function processImageGeneration(db, log, imageGenId) {', `function processImageGeneration(db, log, imageGenId) {
  return require('../../greenroom-managed.cjs').runImageWorker(imageGenId, () => processImageGenerationOnce(db, log, imageGenId));
}
async function processImageGenerationOnce(db, log, imageGenId) {`);
edit('backend-node/src/services/imageService.js', '    processImageGeneration(db, log, imageGenId);',
  "    require('../../greenroom-managed.cjs').observeImageWorker(processImageGeneration(db, log, imageGenId), log, imageGenId);");
edit('backend-node/src/services/imageService.js', '    if (result.error) {\n      db.prepare', `    if (result.query_incomplete) {
      db.prepare('UPDATE image_generations SET error_msg = ?, updated_at = ? WHERE id = ?').run(result.error, now2, imageGenId);
      if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 0, result.error);
      return;
    }
    if (result.error) {
      db.prepare`);
edit('backend-node/src/services/imageService.js', '    // 入库的 image_url：', `    if (!localPath) {
      const reason = '生成已完成，成员素材下载尚未完成；继续查询原任务不会重新生成';
      db.prepare('UPDATE image_generations SET error_msg = ?, updated_at = ? WHERE id = ?').run(reason, now2, imageGenId);
      if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 95, reason);
      return;
    }
    // 入库的 image_url：`);
edit('backend-node/src/services/videoService.js', '  const polledVideo = resolveRemoteVideoUrl(pollResult.video_url, pollResult.error);', `  if (pollResult.query_incomplete) {
    db.prepare('UPDATE video_generations SET error_msg = ?, updated_at = ? WHERE id = ?').run(pollResult.error, now, videoGenId);
    if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 0, pollResult.error);
    return;
  }
  const polledVideo = resolveRemoteVideoUrl(pollResult.video_url, pollResult.error);`);
edit('backend-node/src/services/videoService.js', '  // 低价 Seedance2：', `  if (!localPath) {
    const reason = '生成已完成，成员视频下载尚未完成；继续查询原任务不会重新生成';
    db.prepare('UPDATE video_generations SET error_msg = ?, updated_at = ? WHERE id = ?').run(reason, now, videoGenId);
    if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 95, reason);
    return { ok: false, error: reason };
  }
  videoUrl = '/static/' + localPath.replace(/^\\//, '');
  // 低价 Seedance2：`);

edit('backend-node/src/routes/index.js', '  const videoMerges = videoMergeRoutes(db, log);',
  '  const videoMerges = videoMergeRoutes(db, log, cfg);');
edit('backend-node/src/routes/videoMerges.js', 'function routes(db, log) {', 'function routes(db, log, cfg) {');
edit('backend-node/src/routes/videoMerges.js', '        const rec = videoMergeService.create(db, log, body);\n        response.success(res, { merge_id: rec.merge_id, task_id: rec.task_id, ...rec });', `        const rec = videoMergeService.create(db, log, body);
        setImmediate(() => {
          videoMergeService.processVideoMerge(db, log, rec.merge_id, cfg?.storage?.base_url || '').catch((error) => {
            if (db.prepare(\"SELECT 1 FROM greenroom_merge_delivery d JOIN video_merges m ON m.id=d.merge_id AND m.task_id=d.task_id WHERE d.merge_id=? AND d.task_id=? AND m.status='completed'\").get(rec.merge_id, rec.task_id)) {
              log.error('[Greenroom] 成片已合成，归档状态暂未保存；恢复原任务继续归档');
              return;
            }
            const reason = error.message || '视频合成失败';
            db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', reason, rec.merge_id);
            if (rec.task_id) require('../services/taskService').updateTaskError(db, rec.task_id, reason);
          });
        });
        response.success(res, { merge_id: rec.merge_id, task_id: rec.task_id, ...rec });`);
edit('backend-node/src/services/videoMergeService.js',
  '  const result = spawnSync(ffmpegBin, buildConcatArgs(listFile, outputPath, transcode), {',
  "  const result = spawnSync(ffmpegBin, ['-xerror', ...buildConcatArgs(listFile, outputPath, transcode)], {");
edit('backend-node/src/services/videoMergeService.js',
  '  if (localPaths.length > 0 && ffmpegAvailable && localPaths.length <= 100) {',
  '  if (localPaths.length === scenes.length && ffmpegAvailable && localPaths.length <= 100) {');
edit('backend-node/src/services/videoMergeService.js', '  const finalMergedUrl = mergedRelativePath || mergedUrlFallback;', `  if (!mergedRelativePath) {
    const reason = localPaths.length !== scenes.length ? '视频片段读取失败，无法完成合片'
      : !ffmpegAvailable ? 'FFmpeg 不可用' : localPaths.length > 100 ? '视频片段数量超过上限' : 'FFmpeg 合片失败';
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', reason, mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, reason);
    return;
  }
  const finalMergedUrl = mergedRelativePath;`);

edit('backend-node/src/services/videoMergeService.js', '  const u = videoUrl.trim();', `  let u = videoUrl.trim();
  if (/^\\/api\\/media\\/[^/?#]+$/.test(u)) {
    u = (process.env.GREENROOM_MANAGED_URL || 'http://127.0.0.1:18767/managed') + '/media/' + u.slice('/api/media/'.length);
  }`);
// Bind only newly completed final outputs; historical merge rows are not adopted.
edit('backend-node/src/services/videoMergeService.js', '  if (!r) return;',
  "  if (!r || r.status !== 'pending') return;");
edit('backend-node/src/services/videoMergeService.js', 'const outputFileName = `merged_${Date.now()}.mp4`;',
  "const outputFileName = `merged_${mergeId}_${require('node:crypto').randomUUID()}.mp4`;");
const mergeService = join(root, 'backend-node/src/services/videoMergeService.js');
let mergeSource = readFileSync(mergeService, 'utf8');
const completionStart = mergeSource.indexOf('  db.prepare(\n    \'UPDATE video_merges SET status = ?, merged_url = ?');
const completionEnd = mergeSource.indexOf('\n  if (!mergedRelativePath) {', completionStart);
if (completionStart < 0 || completionEnd < 0) throw new Error('LocalMiniDrama 合片完成入口已变化');
mergeSource = mergeSource.slice(0, completionStart)
  + "  await require('../../greenroom-final-archive.cjs').complete(db, r, finalMergedUrl, Math.round(totalDuration) || null, log);"
  + mergeSource.slice(completionEnd);
mergeSource = mergeSource.replace('return rows.map(rowToItem);', "return rows.map(row => require('../../greenroom-final-archive.cjs').projection(db, rowToItem(row)));")
  .replace('return r ? rowToItem(r) : null;', "return r ? require('../../greenroom-final-archive.cjs').projection(db, rowToItem(r)) : null;");
writeFileSync(mergeService, mergeSource);

edit('frontweb/vite.config.js', 'export default defineConfig({', "export default defineConfig({\n  base: '/plugins/localminidrama/',");
function prefix(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) prefix(filename);
    else if (/\.(?:js|vue)$/.test(entry.name)) {
      let source = readFileSync(filename, 'utf8');
      source = source.replaceAll("'/api/v1", "'/plugins/localminidrama/api/v1").replaceAll('"/api/v1', '"/plugins/localminidrama/api/v1')
        .replaceAll('`/api/v1', '`/plugins/localminidrama/api/v1')
        .replaceAll("'/static/", "'/plugins/localminidrama/static/").replaceAll('`/static/', '`/plugins/localminidrama/static/');
      writeFileSync(filename, source);
    }
  }
}
prefix(join(root, 'frontweb/src'));
// Keep member-local references relative so the managed backend uploads scoped bytes.
edit('frontweb/src/views/FilmCreate.vue', "function toAbsoluteImageUrl(url) {\n  if (!url || !String(url).trim()) return ''\n  const s = String(url).trim()\n  if (s.startsWith('http://') || s.startsWith('https://')) return s", `function toAbsoluteImageUrl(url) {
  if (!url || !String(url).trim()) return ''
  const s = String(url).trim()
  if (s.startsWith('/plugins/localminidrama/static/')) return s
  if (s.startsWith('/static/')) return '/plugins/localminidrama' + s
  if (s.startsWith('http://') || s.startsWith('https://')) {
    const parsed = new URL(s)
    if (typeof window !== 'undefined' && parsed.origin === window.location.origin && parsed.pathname.startsWith('/plugins/localminidrama/static/') && !parsed.search && !parsed.hash) return parsed.pathname
    return s
  }`);
edit('frontweb/src/utils/canvasWorkflow.js', "export function toAbsoluteMediaUrl(url) {\n  if (!url) return ''", `export function toAbsoluteMediaUrl(url) {
  if (!url) return ''
  if (url.startsWith('/plugins/localminidrama/static/')) return url
  if (url.startsWith('/static/')) return '/plugins/localminidrama' + url
  if (/^https?:\\/\\//i.test(url) && typeof window !== 'undefined') {
    const parsed = new URL(url)
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/plugins/localminidrama/static/') && !parsed.search && !parsed.hash) return parsed.pathname
  }`);
edit('frontweb/src/components/AIConfigContent.vue', '<el-tab-pane label="AI 配置" name="configs">', '<el-tab-pane v-if="false" label="AI 配置" name="configs">');
edit('frontweb/src/components/AIConfigContent.vue', "const activeTab = ref('configs')", "const activeTab = ref('prompts')");
for (const file of ['frontweb/src/views/FilmList.vue', 'frontweb/src/views/FilmCreate.vue', 'frontweb/src/views/AiConfig.vue']) {
  const filename = join(root, file);
  writeFileSync(filename, readFileSync(filename, 'utf8').replaceAll('AI 配置', '创作设置'));
}
// API management is not a member navigation entry. Keep the existing business settings link.
edit('frontweb/src/views/FilmList.vue', `<el-button class="btn-settings" @click="showAiConfigDialog = true">
            <el-icon><Setting /></el-icon>AI配置
          </el-button>`, '');
edit('frontweb/src/views/FilmCreate.vue', `<el-button class="btn-ai-config" @click="showAiConfigDialog = true">
            <el-icon><Setting /></el-icon>
            AI配置
          </el-button>`, '');
edit('frontweb/src/views/FilmCreate.vue', '<el-link type="primary" underline="never" @click="showAiConfigDialog = true">创作设置</el-link>',
  '<el-link type="primary" underline="never" @click="showAiConfigDialog = true">创作参数</el-link>');
edit('frontweb/src/views/AiConfig.vue', '<AIConfigContent />',
  '<p role="status">API 接入由 Greenroom 管理员统一管理，请返回工作台联系管理员。</p>');
edit('frontweb/src/views/AiConfig.vue', "import AIConfigContent from '@/components/AIConfigContent.vue'", '');
edit('frontweb/src/components/AIConfigContent.vue', `<el-tab-pane label="SD2 资产管理" name="sd2_assets">
        <div class="tab-content">
          <Sd2AssetManagement :configs="list" @saved="loadList" />
        </div>
      </el-tab-pane>`, '');
edit('frontweb/src/components/AIConfigContent.vue', "import Sd2AssetManagement from '@/components/Sd2AssetManagement.vue'", '');

// The embedded assistant remains a business UI; all its model access uses the same seeded managed text config.

edit('frontweb/src/api/ai.js', "request.get('/ai-configs',", "request.get('/greenroom/models',");
edit('frontweb/src/api/ai.js', "request.get('/ai-configs/vendor-lock')", "request.get('/greenroom/vendor-lock')");

for (const fn of ['generateText', 'streamGenerateText', 'generateTextWithVision']) {
 const file = join(root, 'backend-node/src/services/aiClient.js');
 const source = readFileSync(file, 'utf8');
 const expression = new RegExp('(async function ' + fn + '\\([^\\n]+options = \\{\\}[^\\n]*\\) \\{)');
 if (!expression.test(source)) throw new Error('LocalMiniDrama 文本入口已变化：' + fn);
 writeFileSync(file, source.replace(expression, '$1\n  options = { ...await require("../../greenroom-managed.cjs").parameters(db, log, "llm"), ...options };'));
}
const aiClient = join(root, 'backend-node/src/services/aiClient.js');
writeFileSync(aiClient, readFileSync(aiClient, 'utf8').replaceAll('temperature: Number(temperature),', 'temperature: Number(temperature),\n    ...(options.top_p != null ? { top_p: options.top_p } : {}),'));

edit('frontweb/src/views/FilmCreate.vue', "  const s = String(url).trim()\n  if (s.startsWith('http://') || s.startsWith('https://')) return s\n  return '/plugins/localminidrama/static/' + s.replace(/^\\//, '')", "  const s = String(url).trim()\n  if (/^\\/api\\/media\\/[^/?#]+$/.test(s)) return s\n  if (s.startsWith('http://') || s.startsWith('https://')) return s\n  return '/plugins/localminidrama/static/' + s.replace(/^\\//, '')");

// Final-cache consumption stays on the original merge API/FFmpeg path; restoration
// completes before the native resolver's exists checks and never starts a producer.
edit('backend-node/src/services/videoMergeService.js',
  'async function resolveVideoToLocalPath(videoUrl, baseUrl, storageRoot, tempDir, index, log) {',
  `async function resolveVideoToLocalPath(db, videoUrl, baseUrl, storageRoot, tempDir, index, log) {
  const cached = await require('../../greenroom-final-cache.cjs').restoreInput(db, videoUrl);
  if (cached) return cached;`);
edit('backend-node/src/services/videoMergeService.js', 'const p = await resolveVideoToLocalPath(\n      scenes[i].video_url,', 'const p = await resolveVideoToLocalPath(\n      db, scenes[i].video_url,');
edit('backend-node/src/services/videoMergeService.js',
  'async function processVideoMerge(db, log, mergeId, baseUrl) {',
  `async function processVideoMerge(db, log, mergeId, baseUrl) {
  return require('../../greenroom-final-cache.cjs').consume(db, mergeId, () => nativeProcessVideoMerge(db, log, mergeId, baseUrl));
}
async function nativeProcessVideoMerge(db, log, mergeId, baseUrl) {`);
edit('backend-node/src/app.js', '  managed.install(app, db, log);', `  managed.install(app, db, log);
  app.use('/static', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      const asset = await require('../greenroom-final-cache.cjs').staticReference(db, '/static' + decodeURIComponent(req.path));
      if (asset) return res.redirect(307, asset);
      next();
    } catch (error) { next(error); }
  });`);

edit('backend-node/greenroom-managed.cjs', "busy: Boolean(activeRequests || recovering.size || imageWorkers.size || require('./greenroom-final-archive.cjs').busy())", "busy: Boolean(activeRequests || recovering.size || imageWorkers.size || require('./greenroom-final-archive.cjs').busy() || require('./greenroom-final-cache.cjs').busy())");
