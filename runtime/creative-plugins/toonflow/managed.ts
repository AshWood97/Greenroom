import { Database } from 'bun:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { createMediaCache } from './mediaCache';
import { writeAtomicSync } from '@toonflow/file';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync, renameSync, unlinkSync, lstatSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { resolve, join, relative, dirname, extname, sep } from 'node:path';
import { formatGenerationError } from './greenroom-generation-error';
import conf from '@/utils/conf';
import { lockWorkspaceFiles } from '@/utils/workspace/files';
import { success, error } from '@/lib/responseFormat';
import type { Express } from 'express';
import type { GeneratedMedia, MediaGenerationRequest, MediaModel } from '@toonflow/tools-scaffold/runtime';

const configuredRoot = resolve(process.env.GREENROOM_PLUGIN_ROOT!);
mkdirSync(configuredRoot, { recursive: true });
const root = realpathSync(configuredRoot);
const workspaces = join(root, 'workspaces');
const bridge = process.env.GREENROOM_MANAGED_URL || 'http://127.0.0.1:18767/managed';
mkdirSync(workspaces, { recursive: true });
mkdirSync(join(root, 'tmp'), { recursive: true });
process.env.TMPDIR = join(root, 'tmp');
const db = new Database(join(root, 'greenroom-jobs.sqlite3'), { create: true });
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, cwd TEXT, kind TEXT, request TEXT, upstream_id TEXT,
  state TEXT, result TEXT, error TEXT, node_id TEXT
); CREATE TABLE IF NOT EXISTS job_aliases (id TEXT PRIMARY KEY, job_id TEXT NOT NULL)`);
// Old rows stay unknown; do not derive the original request from current defaults.
db.exec('BEGIN IMMEDIATE');
try {
  if (!(db.query('PRAGMA table_info(jobs)').all() as any[]).some(column => column.name === 'original_request')) {
    db.exec('ALTER TABLE jobs ADD COLUMN original_request TEXT');
  }
  db.exec('COMMIT');
} catch (failure) { db.exec('ROLLBACK'); throw failure; }
const active = new Set<string>();
let activeRequests = 0, activeHandlers = 0, shuttingDown = false;
const mediaCache = createMediaCache({ db, root, workspaces, bridge, referenced: cacheReferenced });
let catalog: Record<string, any[]> = {};
let settings: any = { models: {}, parameters: {} };

async function call(route: string, body?: unknown, submission?: string) {
  const response = await fetch(bridge + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(submission ? { 'X-T8-Provider-Submission': submission } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const result = await response.json() as any;
  if (!response.ok || result.success === false) throw Object.assign(new Error(formatGenerationError({ ...result, httpStatus: response.status })), {
    status: response.status,
    submissionNotSent: Boolean(submission && result.submitted === false
      && ['greenroom.submission_not_sent', 'greenroom.managed_route_not_found'].includes(result.code)),
  });
  return result.data ?? result;
}
function ids(kind: string): string[] { return settings.models?.[kind] ?? (catalog[kind] || []).map(item => typeof item === 'string' ? item : item.id); }
export async function refresh() {
  catalog = await call('/models');
  settings = await call('/plugins/toonflow/settings');
  const previous = conf.get('settings', {});
  conf.set('settings', { ...previous, helloCompleted: true, mcp: { enabled: false },
    customProviders: [{ id: 'greenroom', label: 'Greenroom 托管', apiUrl: (process.env.GREENROOM_BROKER_URL || 'http://127.0.0.1:3081') + '/v1', protocol: 'openai-completions', apiKey: 'greenroom-managed',
      models: ids('llm').map(id => ({ id, label: (catalog.llm || []).find(item => item.id === id)?.label || id })) }], mediaProviderConfigs: {} });
}
export function textDefaults() { return settings.parameters?.llm || {}; }
export async function models(): Promise<MediaModel[]> {
  await refresh();
  const visual = (['image', 'video'] as const).flatMap(kind => ids(kind).map(id => {
    const item = (catalog[kind] || []).find(item => item.id === id) || {};
    const caps = item.capabilities || {};
    return { providerId: 'greenroom', providerLabel: 'Greenroom 托管', modelId: id, label: item.label || id, type: kind,
      ...(kind === 'image' ? { imageSizes: caps.sizes || ['2K'], imageRatios: caps.aspect_ratios || ['16:9', '9:16', '1:1'] } : { mode: ['text', 'singleImage', 'startFrameOptional', 'endFrameOptional', ['imageReference:1']], durationResolutionMap: caps.durationResolutionMap }) };
  }));
  return [...visual, ...['tts', 'music'].flatMap(kind => ids(kind).map(id => ({ providerId: 'greenroom', providerLabel: 'Greenroom 托管', modelId: id, label: ((catalog[kind] || []).find(item => item.id === id)?.label || id) + (kind === 'tts' ? ' · 语音' : ' · 音乐'), type: 'audio' as const })))];
}
function inside(base: string, path: string) {
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(base + sep)) throw new Error('路径超出成员工作区');
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!realpathSync(ancestor).startsWith(realpathSync(base) + sep) && realpathSync(ancestor) !== realpathSync(base)) throw new Error('路径超出成员工作区');
  return target;
}
function workspace(name: string) {
  if (!name || /[\\/\0]|^\.{1,2}$/.test(name)) throw new Error('项目名称必须是一个目录名');
  const directory = inside(workspaces, name);
  if (!existsSync(directory)) throw new Error('项目不存在');
  return directory;
}
// Native textNode deliberately serializes neither textSnapshot nor outputs.text.
// DSH reads only that node's canonical document; cached inline values never rescue an invalid file.
function textNodeReference(directory: string, node: any) {
  if (typeof node.id !== 'string' || !node.id || /[\\/\0]|^\.{1,2}$/.test(node.id)) throw new Error('文本节点 ID 无效');
  const path = `assets/${node.id}/content.md`;
  if (node.data?.textPath !== path) throw new Error('文本文件路径无效');
  const filename = inside(directory, path);
  if (realpathSync(directory) !== directory || realpathSync(filename) !== filename) throw new Error('文本文件经过符号链接');
  for (const part of [directory, join(directory, 'assets'), dirname(filename), filename]) if (lstatSync(part).isSymbolicLink()) throw new Error('文本文件经过符号链接');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd), limit = 20 * 1024 * 1024;
    if (!info.isFile()) throw new Error('只能读取文本文件');
    if (info.size > limit) throw new Error('文本文件超过 20 MiB 读取限制');
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new Error('文本文件超过 20 MiB 读取限制');
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    let text: string;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); if (text.includes('\0')) throw new Error('binary'); }
    catch { throw new Error('文件不是受支持的 UTF-8 或带 BOM 的 UTF-16 文本'); }
    return { dataType: 'STRING', value: text };
  } finally { closeSync(fd); }
}
function nodeInputs(directory: string, canvas: any, node: any): any[] {
  const order = new Map<string, number>((node.data.referenceOrder?.in || []).map((key: string, index: number) => [key, index]));
  return canvas.edges.filter((edge: any) => edge.target === node.id && edge.targetHandle === 'in').flatMap((edge: any) => {
        const source = canvas.nodes.find((item: any) => item.id === edge.source);
        if (!source) return [];
        const output = source.type === 'remote-textNode' && edge.sourceHandle === 'text'
          ? textNodeReference(directory, source) : source?.data?.outputs?.[edge.sourceHandle];
        return [{ ...output, source: source.id, sourceHandle: edge.sourceHandle }];
      }).sort((left: any, right: any) => (order.get(encodeURIComponent(JSON.stringify([left.source, left.sourceHandle]))) ?? order.size) - (order.get(encodeURIComponent(JSON.stringify([right.source, right.sourceHandle]))) ?? order.size));
}
function canvases(directory: string): { path: string; data: any }[] {
  const result: { path: string; data: any }[] = [];
  const walk = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (item.name === 'assets' || item.isSymbolicLink()) continue;
      const filename = inside(directory, relative(directory, join(folder, item.name)));
      if (item.isDirectory()) walk(filename);
      else if (extname(item.name) === '.json') {
        try { const data = JSON.parse(readFileSync(filename, 'utf8')); if (data.toonflowCanvas === true) result.push({ path: filename, data }); }
        catch (failure) { if (!(failure instanceof SyntaxError)) throw failure; }
      }
    }
  };
  walk(directory);
  return result;
}
function canvasSelection(data: any) {
  const { greenroomTask, mediaTask, ...selection } = data || {};
  return JSON.stringify(selection);
}
function mediaCanvasSelection(data: any) {
  const { label, greenroomTask, mediaTask, ...selection } = data || {};
  return selection;
}
function mediaCanvasInputs(directory: string, canvas: any, node: any) {
  const inputs = nodeInputs(directory, canvas, node).map(({ source, sourceHandle, dataType, value }) => ({
    source, sourceHandle, dataType, value,
  }));
  return JSON.parse(JSON.stringify(inputs));
}
function jobCanvasPath(row: any): string | undefined {
  const stored = JSON.parse(row.request).canvasPath;
  if (stored) return inside(row.cwd, stored);
  const matches = canvases(row.cwd).filter(canvas => canvas.data.nodes.some((node: any) => node.id === row.node_id));
  if (matches.length > 1) throw new Error('原任务缺少画布归属且存在同 ID 节点，保留结果，不猜测回填目标');
  return matches[0]?.path;
}
function latestCanvasJob(cwd: string, nodeId: string, filename: string) {
  const rows = db.query("SELECT * FROM jobs WHERE cwd=? AND node_id=? AND kind IN ('image','video','audio') ORDER BY rowid DESC").all(cwd, nodeId) as any[];
  return rows.find(row => {
    try { return jobCanvasPath(row) === filename; }
    catch { return false; } // Ambiguous legacy jobs never shadow a correctly bound task.
  });
}
function cacheReferenced(row: any, output: any) {
  if (!row.node_id) return true;
  let filename: string | undefined;
  try { filename = jobCanvasPath(row); } catch { return false; }
  if (!filename || !existsSync(filename) || latestCanvasJob(row.cwd, row.node_id, filename)?.id !== row.id) return false;
  const canvas = JSON.parse(readFileSync(filename, 'utf8'));
  return canvas.toonflowCanvas === true && canvas.nodes.some((node: any) => node.id === row.node_id
    && node.data?.greenroomTask?.id === row.id && node.data?.outputs?.[row.kind]?.value?.url === output.path
    && node.data?.outputs?.[row.kind]?.value?.mimeType === output.mimeType);
}
function fill(row: any) {
  if (!row.node_id) return;
  const filename = jobCanvasPath(row);
  if (!filename || !existsSync(filename) || latestCanvasJob(row.cwd, row.node_id, filename)?.id !== row.id) {
    if (row.state === 'succeeded' && row.result) throw new Error('原节点内容已变化或原选择记录缺失，保留产物，不覆盖人工内容');
    return;
  }
  const request = JSON.parse(row.request);
  const release = lockWorkspaceFiles([filename]);
  try {
    const canvas = JSON.parse(readFileSync(filename, 'utf8'));
    if (canvas.toonflowCanvas !== true) throw new Error('原回填文件不再是 Toonflow 画布');
    const node = canvas.nodes.find((item: any) => item.id === row.node_id);
    if (!node) {
      if (row.state === 'succeeded' && row.result) throw new Error('原节点内容已变化或原选择记录缺失，保留产物，不覆盖人工内容');
      return;
    }
    node.data ||= {};
    node.data.greenroomTask = { id: row.id, status: row.state, error: row.error || '' };
    if (row.state === 'succeeded' && row.result) {
      const output = JSON.parse(row.result)[0];
      const before = request.mediaCanvasBefore?.find((entry: any) => entry.path === filename);
      const applied = (output && node.data.outputs?.[row.kind]?.value?.url === output.path && node.data.outputs?.[row.kind]?.value?.mimeType === output.mimeType)
        || (row.kind === 'image' && request.outputDirectory === `assets/${row.node_id}/generation`
          && node.data.mediaTask?.applied === true && typeof node.data.mediaTask?.taskId === 'string'
          && (node.data.mediaTask.taskId === row.id || mediaJob(node.data.mediaTask.taskId)?.id === row.id)
          && typeof before?.selection === 'string' && Boolean(JSON.parse(before.selection).inpaint));
      if (!applied) {
        const unchanged = typeof before?.selection === 'string' && Array.isArray(before.inputs)
          && isDeepStrictEqual(mediaCanvasSelection(JSON.parse(before.selection)), mediaCanvasSelection(node.data))
          && isDeepStrictEqual(before.inputs, mediaCanvasInputs(row.cwd, canvas, node));
        if (!unchanged) throw new Error('原节点内容或引用已变化，或原选择记录缺失，保留产物，不覆盖人工内容');
        // The native inpaint result still needs browser-side mask composition.
        const nativeInpaint = row.kind === 'image' && Boolean(JSON.parse(before.selection).inpaint)
          && request.outputDirectory === `assets/${row.node_id}/generation`;
        if (output && !nativeInpaint) { node.data.outputs ||= {}; node.data.outputs[row.kind] = { dataType: row.kind.toUpperCase(), value: { url: output.path, mimeType: output.mimeType } }; }
      }
    }
    writeAtomicSync(filename, JSON.stringify(canvas));
  } finally { release(); }
}
function finishMediaReference(row: any) {
  try {
    if (row.state === 'succeeded') { db.query('UPDATE jobs SET error=NULL WHERE id=?').run(row.id); row = { ...row, error: null }; }
    fill(row); if (JSON.parse(row.request).mediaStorageVersion === 1) mediaCache.finalize(row.id);
  } catch (failure: any) {
    // Native completion and the original Asset survive a failed canvas commit. Resume only rebinds.
    db.query('UPDATE jobs SET error=? WHERE id=?').run(formatGenerationError(failure.message), row.id);
  }
}
// Called immediately before the native synchronous canvas writer; never change user outputs.
export function projectCanvasTaskMetadata(directory: string, bytes: Uint8Array, path?: string): Buffer | undefined {
  let canvas: any;
  try { canvas = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return undefined; }
  if (canvas?.toonflowCanvas !== true || !Array.isArray(canvas.nodes)) return undefined;
  directory = realpathSync(inside(realpathSync(workspaces), directory));
  for (const node of canvas.nodes) {
    if (!node || typeof node.id !== 'string') continue;
    const matches = path ? [inside(directory, path)] : canvases(directory).filter(item => item.data.nodes.some((entry: any) => entry.id === node.id)).map(item => item.path);
    if (matches.length !== 1) continue;
    const latest = latestCanvasJob(directory, node.id, matches[0]);
    if (!latest) continue;
    node.data ||= {};
    node.data.greenroomTask = { id: latest.id, status: latest.state, error: latest.error || '' };
  }
  return Buffer.from(JSON.stringify(canvas));
}
export async function withMediaFiles<T>(directory: string, action: () => Promise<T>, paths = [directory]) {
  return mediaCache.withLease(directory, async () => {
    await mediaCache.restore(directory, paths);
    try { return await action(); }
    finally { await mediaCache.invalidateChanged(directory, paths); }
  });
}
export async function mutateMediaFiles<T>(directory: string, paths: string[], invalidated: string[], action: () => Promise<T>) {
  if (!mediaCache.hasFiles(directory, paths)) return action();
  return mediaCache.withLease(directory, async () => {
    await mediaCache.restore(directory, paths);
    try { return await action(); }
    finally { mediaCache.invalidate(directory, invalidated); }
  });
}
export async function exportMediaFiles(directory: string, res: any, action: () => Promise<void>) {
  return withMediaFiles(directory, async () => {
    let finish: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const done = () => finish();
    res.once('finish', done); res.once('close', done);
    try {
      await action();
      if (!res.writableFinished && !res.destroyed) await completed;
    } finally { res.off('finish', done); res.off('close', done); }
  });
}
export async function finishMediaCanvas(directory: string) {
  for (const row of db.query("SELECT id FROM jobs WHERE cwd=? AND state='succeeded' AND kind IN ('image','video')").all(directory) as any[]) mediaCache.finalize(row.id);
  await mediaCache.prune().catch(() => {});
}
export const mediaReference = (path: string) => mediaCache.reference(path);
export const mediaListing = (directory: string, path: string, entries: any[]) => mediaCache.listing(directory, path, entries);
async function upload(directory: string, input: any) {
  const filename = inside(directory, input.path);
  return withMediaFiles(directory, async () => {
    const original = await mediaCache.reference(filename);
    if (original) return original.fileUrl; // already durable; no duplicate reference upload
    const response = await fetch(bridge + '/media/uploads', { method: 'POST', body: Bun.file(filename),
      headers: { 'Content-Type': input.mimeType, 'X-File-Name': encodeURIComponent(filename.split(sep).at(-1)!), 'X-Asset-Type': input.mimeType.split('/')[0] }, signal: AbortSignal.timeout(120000) });
    const result = await response.json() as any;
    if (!response.ok || result.success === false) throw new Error(formatGenerationError({ ...result, httpStatus: response.status }));
    return (result.data ?? result).fileUrl;
  }, [filename]);
}
function orderedVideoInputs(request: any) {
  if (!Array.isArray(request.referenceOrder)) return undefined; // Old persisted jobs retain their original input contract.
  const grouped: Record<string, any[]> = { image: request.images || [], video: request.videos || [], audio: request.audios || [],
    firstFrame: request.firstFrame ? [request.firstFrame] : [], lastFrame: request.lastFrame ? [request.lastFrame] : [] };
  const roles: Record<string, string> = { image: 'reference_image', video: 'reference_video', audio: 'reference_audio', firstFrame: 'first_frame', lastFrame: 'last_frame' };
  const seen = new Set<string>();
  const ordered = request.referenceOrder.flatMap((item: any) => {
    if (item?.type === 'text') return [];
    const values = grouped[item?.type], index = ['firstFrame','lastFrame'].includes(item?.type) ? 0 : item?.index;
    if (!values || !Number.isInteger(index) || index < 0 || !values[index]) throw new Error('视频参考顺序与原素材不一致');
    const key = item.type + ':' + index;
    if (seen.has(key)) throw new Error('视频参考顺序包含重复索引');
    seen.add(key);
    return [{ role: roles[item.type], reference: values[index] }];
  });
  if (seen.size !== Object.values(grouped).reduce((count, values) => count + values.length, 0)) throw new Error('视频参考顺序遗漏原素材');
  return ordered;
}
async function run(id: string, initialInsert = false) {
  if (active.has(id)) return;
  active.add(id);
  let row = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
  try {
    if (!row || ['succeeded', 'failed'].includes(row.state)) return;
    const request = JSON.parse(row.request);
    let taskId = row.upstream_id;
    if (!taskId && !initialInsert) {
      db.query('UPDATE jobs SET error=? WHERE id=?').run('原媒体尚无已受理任务编号；恢复仅查询原任务，未重新提交。原任务 ID：' + id, id);
      return;
    }
    if (!taskId) {
      if (row.state !== 'pending') throw Object.assign(new Error('原媒体提交结果未知，保留原业务编号，不自动重发'), { queryPending: true });
      if (request.mediaStorageVersion === 1) await mediaCache.admit(row.cwd);
      let payload: any;
      const managedKind = row.kind === 'audio' ? request.managedKind : row.kind;
      if (row.kind === 'audio') {
        if (request.images?.length || request.audios?.length) throw new Error('当前托管语音和音乐模型仅接受文本，不接受图片或音频参考');
        payload = managedKind === 'tts'
          ? { model: request.modelId, text: request.prompt, ...(request.voice ? { voice: request.voice } : {}), ...(request.speed != null ? { speed: request.speed } : {}), ...(request.format ? { response_format: request.format } : {}) }
          : { model: request.modelId, prompt: request.prompt, ...(request.duration != null ? { duration: request.duration } : {}), ...(request.instrumental != null ? { instrumental: request.instrumental } : {}) };
      } else {
        payload = { model: request.modelId, prompt: request.prompt,
          ...(request.ratio ? { aspect_ratio: request.ratio } : {}), ...(request.size ? { size: request.size } : {}),
          ...(request.duration ? { duration: request.duration } : {}), ...(request.resolution ? { resolution: request.resolution } : {}),
          ...(request.generateAudio !== undefined ? { generate_audio: request.generateAudio } : {}),
          ...(request.seed !== undefined ? { seed: request.seed } : {}) };
        const providerParams = Object.fromEntries(['quality', 'negative_prompt'].filter(key => request[key] !== undefined).map(key => [key, request[key]]));
        if (Object.keys(providerParams).length) payload.providerParams = providerParams;
        if (row.kind === 'image') payload.n = 1;
        const ordered = row.kind === 'video' ? orderedVideoInputs(request) : undefined;
        if (ordered) {
          payload.input_refs = [];
          for (const item of ordered) payload.input_refs.push({ role: item.role, url: await upload(row.cwd, item.reference) });
        } else {
          for (const [field, remote] of [['images', row.kind === 'image' ? 'reference_images' : 'reference_image_urls'], ['videos', 'reference_video_urls'], ['audios', 'reference_audio_urls']])
            if (request[field]?.length) payload[remote] = await Promise.all(request[field].map((item: any) => upload(row.cwd, item)));
          for (const [field, remote] of [['firstFrame', 'first_frame_url'], ['lastFrame', 'last_frame_url']]) if (request[field]) payload[remote] = await upload(row.cwd, request[field]);
        }
      }
      if (!db.query("UPDATE jobs SET state='submitting' WHERE id=? AND state='pending' AND upstream_id IS NULL").run(id).changes)
        throw Object.assign(new Error('原媒体提交正在进行或结果未知，不自动重发'), { queryPending: true });
      taskId = (await call('/' + managedKind + '/submit', payload, 'toonflow:' + id)).taskId;
      if (!taskId) throw new Error('平台未返回生成任务编号');
      db.query("UPDATE jobs SET upstream_id=?, state='running', error=NULL WHERE id=?").run(taskId, id);
    }
    let lastError = '';
    for (let attempt = 0; attempt < 180; attempt++) {
      let task;
      try { task = await call('/tasks/' + encodeURIComponent(taskId)); }
      catch (failure) { lastError = formatGenerationError((failure as Error).message); db.query('UPDATE jobs SET error=? WHERE id=?').run(lastError, id); await Bun.sleep(10000); continue; }
      if (task.status === 'failed' || task.status === 'cancelled') {
        db.query("UPDATE jobs SET state='failed', error=? WHERE id=?").run(formatGenerationError(task.error), id);
        return;
      }
      if (task.status === 'succeeded') {
        await mediaCache.withLease(row.cwd, async () => {
        const outputs = [];
        for (const output of task.outputs || []) {
          if (!output.mimeType?.startsWith(row.kind + '/')) continue;
          const assetId = output.assetId || output.url.split('/').at(-1);
          const extension = output.mimeType === 'image/jpeg' ? 'jpg' : output.mimeType.split('/')[1] || (row.kind === 'video' ? 'mp4' : 'png');
          let local = join(request.outputDirectory || 'assets/generated', `${id}-${outputs.length}.${extension}`);
          let filename = inside(row.cwd, local);
          mkdirSync(dirname(filename), { recursive: true });
          if (request.mediaStorageVersion === 1) {
            outputs.push(await mediaCache.capture(row, outputs.length, local.split(sep).join('/'), assetId, output.mimeType));
            continue;
          }
          const response = await fetch(bridge + '/media/' + encodeURIComponent(assetId), { signal: AbortSignal.timeout(120000) });
          if (!response.ok) throw Object.assign(new Error(`生成已完成，素材读取失败（HTTP ${response.status}）；原任务编号：${taskId}`), { queryPending: true });
          await Bun.write(filename, response);
          let mimeType = output.mimeType;
          if (row.kind === 'audio' && (request.format || request.sampleRate)) {
            const formatByMime: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/ogg': 'opus', 'audio/flac': 'flac' };
            const format = request.format || formatByMime[output.mimeType] || 'wav';
            const converted = inside(row.cwd, join(request.outputDirectory || 'assets/generated', `${id}-${outputs.length}-converted.${format}`));
            const child = Bun.spawn(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', filename, ...(request.sampleRate ? ['-ar', String(request.sampleRate)] : []), converted], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
            const reason = await new Response(child.stderr).text();
            if (await child.exited) throw Object.assign(new Error('成员音频保存未完成：' + reason.slice(0, 500) + '；原任务编号：' + taskId), { queryPending: true });
            const previous = filename; local = join(request.outputDirectory || 'assets/generated', `${id}-${outputs.length}.${format}`); filename = inside(row.cwd, local);
            renameSync(converted, filename); if (previous !== filename) unlinkSync(previous);
            const mimeByFormat: Record<string, string> = { mp3: 'audio/mpeg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav' };
            mimeType = mimeByFormat[format];
          }
          outputs.push({ path: local.split(sep).join('/'), mimeType, mediaType: row.kind, assetId, url: output.url });
        }
        if (!outputs.length) throw Object.assign(new Error('平台尚未返回可读取的产物；原任务编号：' + taskId), { queryPending: true });
        db.query("UPDATE jobs SET state='succeeded', result=?, error=NULL WHERE id=?").run(JSON.stringify(outputs), id);
        finishMediaReference(db.query('SELECT * FROM jobs WHERE id=?').get(id));
        });
        return;
      }
      await Bun.sleep(10000);
    }
    db.query("UPDATE jobs SET state='waiting', error=? WHERE id=?").run(lastError || '查询达到上限，生成结果尚未确认；原任务编号：' + taskId, id);
  } catch (failure: any) {
    row = db.query('SELECT * FROM jobs WHERE id=?').get(id);
    // Only the bridge's explicit pre-forward rejection can close a claimed submission.
    // Lost responses, unmarked upstream failures and every known task ID remain recoverable.
    const rejected = failure.submissionNotSent === true && row?.state === 'submitting' && !row?.upstream_id;
    db.query('UPDATE jobs SET state=?, error=? WHERE id=?').run(row?.state === 'succeeded' ? 'succeeded' : rejected ? 'failed' : row?.upstream_id || row?.state === 'submitting' || failure.queryPending ? 'waiting' : 'failed', formatGenerationError(failure.message), id);
  } finally {
    row = db.query('SELECT * FROM jobs WHERE id=?').get(id);
    try { if (row) finishMediaReference(row); } finally { active.delete(id); }
  }
}
// Target-node outputs and label are display/selection state. Incoming
// references remain in images/videos/audios/frames and the resolved prompt.
function mediaRequestInput(request: any) {
  const input = JSON.parse(JSON.stringify(request));
  for (const key of ['mediaStorageVersion', 'mediaCanvasBefore', 'greenroomTask', 'mediaTask', 'outputs', 'label']) delete input[key];
  return input;
}
function mediaJob(id: string) {
  return db.query('SELECT * FROM jobs WHERE id=COALESCE((SELECT job_id FROM job_aliases WHERE id=?),?)').get(id, id) as any;
}
export function start(cwd: string, id: string, kind: string, request: any, context?: { nodeId?: string; canvasPath?: string; observedJobId?: string; greenroomCanvasBefore?: { selection: string; inputs: any[] } }, _owner?: unknown) {
  cwd = realpathSync(cwd);
  if (!cwd.startsWith(realpathSync(workspaces) + sep)) throw new Error('工作目录超出成员范围');
  if (!['image', 'video', 'audio'].includes(kind)) throw new Error('管理员尚未启用该媒体生成服务');
  const originalRequest = mediaRequestInput(request);
  const previous = mediaJob(id);
  if (previous) {
    if (previous.cwd !== cwd || previous.kind !== kind || (context?.nodeId && previous.node_id !== context.nodeId) || (context?.canvasPath && jobCanvasPath(previous) !== inside(cwd, context.canvasPath))) throw new Error('原任务不属于当前工作区或画布');
    if (!previous.original_request || !isDeepStrictEqual(mediaRequestInput(JSON.parse(previous.original_request)), originalRequest)) {
      throw new Error('原任务输入无法确认或与本次不同；原任务和产物已保留，请查询原任务或明确使用新编号生成：' + id);
    }
    return previous.id; // Existing unknown/accepted jobs are never submitted again by this entrypoint.
  }
  if (kind === 'image' && request.inpaint) throw new Error('后台局部重绘尚未接入官方 guide/mask 合成合同；不会作为普通图片生成提交');
  const available = kind === 'audio' ? [...ids('tts'), ...ids('music')] : ids(kind);
  const modelId = request.modelId || available[0];
  const managedKind = kind === 'audio' ? ids('tts').includes(modelId) ? 'tts' : 'music' : kind;
  const defaults = settings.parameters?.[managedKind] || {};
  const input = { ...defaults, ratio: defaults.aspect_ratio, generateAudio: defaults.generate_audio, format: defaults.response_format, ...request, providerId: 'greenroom', modelId, managedKind };
  delete input.mediaStorageVersion; delete input.mediaCanvasBefore;
  if (kind === 'audio' && input.format === 'ogg_opus') input.format = 'opus';
  const inferredNode = input.outputDirectory === 'assets/generated' ? null : /^assets\/([^/]+)$/.exec(input.outputDirectory || '')?.[1] || null;
  const nodeId = context?.nodeId || inferredNode;
  if (context?.nodeId && inferredNode && inferredNode !== context.nodeId) throw new Error('生成节点与输出目录不一致');
  if (nodeId && /[\\/\0]|^\.{1,2}$/.test(nodeId)) throw new Error('节点 ID 无效');
  delete input.canvasPath;
  const matched = nodeId ? canvases(cwd).filter(canvas => canvas.data.nodes.some((node: any) => node.id === nodeId)) : [];
  const selected = context?.canvasPath ? matched.filter(canvas => canvas.path === inside(cwd, context.canvasPath!)) : matched;
  if ((context?.canvasPath && selected.length !== 1) || selected.length > 1) throw new Error('请提供准确的原画布归属，不能向同 ID 的多个画布提交或回填');
  if (selected.length) {
    // Recheck after callers' awaits, in the same synchronous section as INSERT.
    // Different concurrent callIds cannot each submit a task for the same node.
    const observed = context?.observedJobId ? mediaJob(context.observedJobId) : null;
    const pending = observed || latestCanvasJob(cwd, nodeId!, selected[0].path);
    if (context?.observedJobId && !observed) throw new Error('原任务不存在，未创建新的生成任务');
    if (pending && (observed || !['succeeded', 'failed'].includes(pending.state))) {
      if (pending.cwd !== cwd || pending.node_id !== nodeId || jobCanvasPath(pending) !== selected[0].path) throw new Error('原任务不属于当前工作区或画布');
      if (observed && pending.kind !== kind) throw new Error('原任务不属于当前工作区或画布');
      if (pending.kind === kind && pending.original_request && isDeepStrictEqual(mediaRequestInput(JSON.parse(pending.original_request)), originalRequest)) {
        db.query('INSERT INTO job_aliases(id,job_id) VALUES(?,?)').run(id, pending.id);
        return pending.id;
      }
      if (observed) throw new Error('原任务输入无法确认或与本次不同；原任务和产物已保留，请查询原任务或明确使用新编号生成：' + pending.id);
      throw Object.assign(new Error('该节点已有不同输入或输入未知的原任务；未复用旧结果或创建新任务，请先查看原任务：' + pending.id), { status: 422 });
    }
    input.canvasPath = relative(cwd, selected[0].path);
    input.mediaCanvasBefore = selected.map(canvas => ({ path: canvas.path, ...(context?.greenroomCanvasBefore || {}) }));
  }
  if (!available.includes(modelId)) throw new Error('该生成模型未获得管理员授权');
  if (kind === 'audio' && input.format && !['wav', 'mp3', 'flac', 'opus'].includes(input.format)) throw new Error('托管音频支持 wav、mp3、flac、opus 格式');
  if (['image','video'].includes(kind) && ((!nodeId && (!input.outputDirectory || input.outputDirectory === 'assets/generated'))
    || selected.some(canvas => canvas.data.nodes.some((node: any) => node.id === nodeId && node.type === 'remote-' + kind + 'GenerationNode' && !node.data?.inpaint)))) input.mediaStorageVersion = 1;
  db.query("INSERT INTO jobs(id,cwd,kind,request,state,node_id,original_request) VALUES(?,?,?,?,'pending',?,?)").run(id, cwd, kind, JSON.stringify(input), nodeId, JSON.stringify(originalRequest));
  fill(db.query('SELECT * FROM jobs WHERE id=?').get(id));
  void run(id, true);
  return id;
}
export function status(cwd: string, taskIds: string[], resume = false, _owner?: unknown) {
  return taskIds.map(taskId => {
    const row = mediaJob(taskId);
    if (!row || row.cwd !== cwd) return { taskId, result: error('任务不存在', null, 404) };
    if (resume && row.upstream_id && row.state === 'waiting') void run(row.id);
    const request = JSON.parse(row.request);
    const before = request.mediaCanvasBefore?.length === 1 ? request.mediaCanvasBefore[0] : undefined;
    return { taskId: row.id, status: row.state, error: row.error, state: ['succeeded', 'failed'].includes(row.state) ? row.state : row.state === 'waiting' || (['pending','submitting'].includes(row.state) && !row.upstream_id && row.error && !active.has(row.id)) ? 'interrupted' : 'running',
      resumable: row.state === 'waiting' && Boolean(row.upstream_id), nodeId: row.node_id || undefined, canvasPath: request.canvasPath,
      ...(row.state === 'succeeded' && row.node_id ? { greenroomSelectionConflict: Boolean(row.error),
        ...(typeof before?.selection === 'string' && Array.isArray(before.inputs) ? { greenroomCanvasBefore: { selection: before.selection, inputs: before.inputs } } : {}) } : {}),
      ...(row.state === 'failed' ? { result: error(row.error, null, 502) } : row.state === 'succeeded' ? { result: success(JSON.parse(row.result)) } : {}) };
  });
}
export function cancel(_cwd: string, _taskIds: string[], _owner?: unknown) { /* UI polling detaches client-side; accepted jobs are never cancelled here. */ }
export function restore() {
  const rows = db.query("SELECT * FROM jobs WHERE state != 'failed' AND kind IN ('image','video','audio')").all() as any[];
  for (const row of rows) { if (row.state === 'succeeded') finishMediaReference(row); else void run(row.id); }
  const saved = db.query("SELECT * FROM jobs WHERE state='save_pending' AND kind IN ('local-media','scene-ai')").all() as any[];
  for (const row of saved) finishSavedCanvas(row.id);
  return { restoring: rows.filter(row => row.state !== 'succeeded').length, savePending: saved.length };
}
export async function generate(cwd: string, kind: 'image' | 'video' | 'audio', request: MediaGenerationRequest, signal?: AbortSignal): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  const id = start(cwd, crypto.randomUUID(), kind, request);
  await run(id);
  return wait(cwd, id, undefined, signal);
}
export async function wait(cwd: string, id: string, _owner?: unknown, signal?: AbortSignal): Promise<GeneratedMedia[]> {
  const owned = db.query('SELECT id FROM jobs WHERE id=? AND cwd=?').get(id, cwd);
  if (!owned) throw new Error('任务不存在');
  // Disconnecting only stops this waiter; run(id) retains the accepted job and original task ID.
  while (active.has(id)) {
    signal?.throwIfAborted();
    await Bun.sleep(250);
  }
  signal?.throwIfAborted();
  const row = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
  if (row.state !== 'succeeded') throw new Error(row.error || '生成结果尚未确认；原业务任务编号：' + id);
  return JSON.parse(row.result);
}
const emptyCanvas = () => ({ toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
function textTargetPath(filename: string) {
  let ancestor = filename;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, filename));
}
function textTargetState(filename: string) {
  const path = textTargetPath(filename);
  try {
    const info = statSync(filename);
    return info.isFile() ? { path, kind: 'file', content: readFileSync(filename).toString('base64') } : { path, kind: 'nonfile' };
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return { path, kind: 'missing' };
    throw failure;
  }
}
// Compare only the business inputs consumed by the local processor, not the call ID or output directory.
function localMediaSelection(directory: string, request: any) {
  if (typeof request.source !== 'string' || !request.source) return undefined;
  // Match native analysisPath: relative paths only; dot/duplicate separators are aliases, case is not.
  if (/[\x00-\x1f]/.test(request.source) || /^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(request.source)
    || request.source.split(/[\\/]+/).includes('..')) throw new Error('拉片素材必须使用工作区内的相对路径');
  const source = request.source.split(/[\\/]+/).filter((part: string) => part && part !== '.').join('/');
  if (!source) throw new Error('媒体输入必须使用工作区内的相对路径');
  const common = { kind: request.kind, source: inside(directory, source) };
  if (request.kind === 'frames') {
    const method = request.method ?? 'adaptive';
    return JSON.stringify({ ...common, method, threshold: request.threshold ?? (method === 'content' ? 27 : 3),
      minSceneSeconds: request.minSceneSeconds ?? 0.6, frames: request.frames ?? true, clips: request.clips ?? true, audio: request.audio ?? true });
  }
  if (request.kind === 'video') return JSON.stringify({ ...common, action: request.action,
    ...(request.action === 'trim' ? { start: request.start, end: request.end } : {}) });
  if (request.kind === 'image-grid') return JSON.stringify({ ...common, rows: request.rows, columns: request.columns });
  return undefined;
}
function canvasInputsSnapshot(canvas: any, nodeId: string) {
  return JSON.stringify(canvas.edges.filter((edge: any) => edge.target === nodeId && edge.targetHandle === 'in').map((edge: any) => ({
    edge, output: canvas.nodes.find((node: any) => node.id === edge.source)?.data?.outputs?.[edge.sourceHandle],
  })));
}
// Both the first commit and recovery consume the durable result. Never rerun FFmpeg or a model here.
function finishSavedCanvas(id: string) {
  if (active.has(id)) return;
  active.add(id);
  try {
    const row = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
    if (!row || row.state !== 'save_pending' || !['local-media','scene-ai'].includes(row.kind)) return;
    const request = JSON.parse(row.request), snapshot = request.canvasBefore;
    // Old records have no trustworthy before-image. Leave them and their result untouched.
    if (snapshot?.version !== 1 || snapshot.node?.id !== row.node_id || typeof snapshot.input !== 'string' || !request.canvasPath || !row.result) return;
    const directory = realpathSync(row.cwd);
    if (directory !== row.cwd || !directory.startsWith(realpathSync(workspaces) + sep)) throw new Error('原任务目录超出成员范围或已变化');
    const filename = inside(directory, request.canvasPath), result = JSON.parse(row.result);
    if (row.kind === 'local-media' && (!Array.isArray(result.media) || !result.details || !Array.isArray(result.node_ids)
      || result.node_ids.length !== result.media.length || new Set(result.node_ids).size !== result.node_ids.length
      || request.kind === 'frames' && typeof result.details.manifest !== 'string')) return;
    if (row.kind === 'scene-ai' && (!Array.isArray(snapshot.affected) || typeof snapshot.manifest !== 'string'
      || !result.output?.manifest || !Array.isArray(result.output.scenes) || !Array.isArray(result.steps))) return;
    if (row.kind === 'scene-ai' && result.steps.some((step: any) => step.state !== 'succeeded')) {
      db.query("UPDATE jobs SET state='unknown',error=? WHERE id=?").run('原模型步骤结果未完整确认，保留结果，不自动重投', id); return;
    }
    for (const path of row.kind === 'local-media' ? [...result.media.map((media: any) => media.path), ...(request.kind === 'frames' ? [result.details.manifest] : [])] : [result.output.manifest]) {
      const file = inside(directory, path);
      if (realpathSync(file) !== file || !statSync(file).isFile()) throw new Error('已保存成果文件不存在或路径已变化，不重新处理');
    }
    const manifest = row.kind === 'scene-ai' ? inside(directory, request.result.manifest) : undefined;
    const release = lockWorkspaceFiles([filename, ...(manifest ? [manifest] : [])]);
    try {
      const current = JSON.parse(readFileSync(filename, 'utf8'));
      const target = current.nodes?.find((node: any) => node.id === row.node_id);
      const before = snapshot.node, after = structuredClone(before);
      const same = (left: any, right: any) => JSON.stringify(left) === JSON.stringify(right);
      let additions: any[] = [], affected: any[] = [], affectedAfter: any[] = [];
      if (row.kind === 'local-media') {
        additions = result.media.map((media: any, index: number) => ({ id: result.node_ids[index], type: `remote-${media.mediaType}Node`,
          position: { x: (before.position?.x || 0) + 400 + index % 3 * 360, y: (before.position?.y || 0) + Math.floor(index / 3) * 320 },
          data: { label: media.label, outputs: { [media.mediaType]: { dataType: media.mediaType.toUpperCase(), value: { url: media.path, mimeType: media.mimeType } } },
            ...(request.kind === 'frames' ? { frameAnalysisResult: { ownerId: row.node_id, manifest: result.details.manifest, sceneIndex: media.sceneIndex, kind: media.mediaType === 'image' ? 'frames' : media.mediaType === 'video' ? 'clips' : 'audio' } } : {}) } }));
        if (request.kind === 'frames') after.data.frameAnalysis = { ...after.data.frameAnalysis, ...Object.fromEntries(['method','threshold','minSceneSeconds','frames','clips','audio'].filter(key => request[key] !== undefined).map(key => [key,request[key]])),
          source: { url: request.source, mimeType: request.sourceMimeType }, lastResult: result.details, resultSource: request.source, aiEnabled: false };
      } else {
        affected = current.nodes?.filter((node: any) => node.data?.frameAnalysisResult?.ownerId === row.node_id
          && [request.result.manifest, result.output.manifest].includes(node.data.frameAnalysisResult.manifest));
        const scenes = new Map(result.output.scenes.map((scene: any) => [scene.index, scene]));
        affectedAfter = structuredClone(snapshot.affected);
        for (const media of affectedAfter) {
          const origin = media.data.frameAnalysisResult, scene: any = scenes.get(origin.sceneIndex ?? 0);
          if (scene?.annotation && ['frames','clips'].includes(origin.kind)) {
            const a = scene.annotation;
            media.data.label = `${origin.kind === 'frames' ? 'S' : 'M'}${String(scene.index).padStart(2,'0')} · ${a.shotSize} · ${a.cameraAngle} · ${a.description}`;
          }
          origin.manifest = result.output.manifest;
        }
        after.data.frameAnalysis = { ...after.data.frameAnalysis, lastResult: result.output };
      }
      const added = current.nodes?.filter((node: any) => result.node_ids?.includes(node.id)) || [];
      const applied = same(target, after) && (row.kind === 'local-media' ? same(added, additions) : same(affected, affectedAfter));
      const unchanged = same(target, before) && (row.kind === 'local-media' ? !added.length : same(affected, snapshot.affected));
      if (current.toonflowCanvas !== true || !target || canvasInputsSnapshot(current, row.node_id) !== snapshot.input
        || manifest && readFileSync(manifest, 'utf8') !== snapshot.manifest || !unchanged && !applied) {
        db.query("UPDATE jobs SET state='conflict',error=? WHERE id=?").run('原节点、输入媒体、素材标注或业务清单已变化，保留处理结果，不覆盖画布', id); return;
      }
      if (!applied) {
        current.nodes = current.nodes.map((node: any) => node.id === row.node_id ? after : affectedAfter.find((media: any) => media.id === node.id) || node);
        current.nodes.push(...additions);
        writeAtomicSync(filename, JSON.stringify(current));
      }
      // A crash after the atomic write is recognized by the exact saved node IDs/content above.
      // A completed but invalid overview is a known failure, not an unknown model step.
      // Keep the native annotated result on the canvas so an explicit retry can reuse its scenes.
      const overviewError = row.kind === 'scene-ai' ? result.output.ai?.overviewError : undefined;
      db.query('UPDATE jobs SET state=?,result=?,error=? WHERE id=?').run(overviewError ? 'failed' : 'succeeded',
        JSON.stringify(row.kind === 'scene-ai' ? { ...result, executionFinished: true } : result), overviewError || null, id);
    } finally { release(); }
  } catch (failure) {
    db.query('UPDATE jobs SET error=? WHERE id=?').run(formatGenerationError((failure as Error).message), id);
  } finally { active.delete(id); }
}
async function runLocalMedia(id: string, directory: string, request: any) {
  active.add(id);
  try {
    const { processLocalMedia } = await import('./greenroom-local-media');
    mkdirSync(dirname(inside(directory, request.outputDirectory)), { recursive: true });
    const output = await withMediaFiles(directory, () => processLocalMedia(directory, request), [inside(directory, request.source)]);
    // Persist generated node IDs before the canvas write so a committed write can be recognized after a crash.
    db.query("UPDATE jobs SET state='save_pending',result=? WHERE id=?").run(JSON.stringify({ ...output, node_ids: output.media.map(() => crypto.randomUUID()) }), id);
  } catch (failure) {
    const row = db.query('SELECT state FROM jobs WHERE id=?').get(id) as any;
    db.query('UPDATE jobs SET state=?,error=? WHERE id=?').run(row?.state === 'save_pending' ? 'save_pending' : 'failed', formatGenerationError((failure as Error).message), id);
  } finally { active.delete(id); }
  finishSavedCanvas(id);
}

async function runSceneAnalysis(id: string, directory: string, request: any, configured: any, modelEntry: any) {
  active.add(id);
  const steps: any[] = [];
  let output: any, executionFinished = false;
  const persist = (state: string, error: string | null = null) => db.query('UPDATE jobs SET state=?,result=?,error=? WHERE id=?')
    .run(state, JSON.stringify({ steps, executionFinished, ...(output ? { output } : {}) }), error, id);
  try {
    const { analyzeScenes } = await import('./greenroom-scene-analysis');
    const { readTextReferences } = await import('./greenroom-text-references');
    const { streamAi } = await import('@/utils/ai');
    const signal = AbortSignal.timeout(600000);
    const sourcePaths = [request.source, ...request.result.scenes.flatMap((scene: any) => scene.image ? [scene.image] : [])].map(path => inside(directory, path));
    output = await withMediaFiles(directory, () => analyzeScenes({ directory, source: request.source, result: request.result,
      model: { providerId: 'greenroom', modelId: request.model_id, contextWindow: configured.model.contextWindow, maxOutputTokens: configured.model.maxOutputTokens }, focus: request.focus, signal,
      generate: async (input: any) => {
        signal.throwIfAborted();
        if (input.providerId !== 'greenroom' || input.modelId !== request.model_id || input.directory !== directory || input.tools?.length) throw new Error('AI 拉片请求超出原模型或工作区合同');
        const references = await readTextReferences(directory, input.references ?? [], modelEntry, configured.provider, signal);
        const step: any = { index: steps.length, kind: references.length ? 'scene' : 'overview', state: 'unknown', request: { prompt: input.prompt, systemPrompt: input.systemPrompt, references: input.references ?? [] } };
        steps.push(step); persist('unknown', '本步模型请求结果尚未确认，不自动重投');
        try {
          const stream = streamAi(configured, { systemPrompt: input.systemPrompt,
            messages: [{ role: 'user', content: input.prompt, timestamp: Date.now() }] }, signal, references, 0,
            response => { step.request_id = response.headers.get('x-request-id'); persist('unknown'); });
          for await (const _event of stream) { /* only complete results become reusable observations */ }
          const message = await stream.result();
          const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
          step.result = { text, stopReason: message.stopReason, usage: message.usage, message };
          if (message.stopReason !== 'stop' || !text.trim()) throw new Error(formatGenerationError(message.errorMessage) || 'AI 拉片响应未完整完成，保留原任务');
          step.state = 'succeeded'; persist('running');
          return { text };
        } catch (failure) {
          step.error = formatGenerationError((failure as Error).message); persist('unknown', step.error); throw failure;
        }
      },
    }), sourcePaths);
    const unknown = steps.find(step => step.state === 'unknown');
    persist(unknown ? 'unknown' : 'save_pending', unknown?.error || output.ai?.overviewError || null);
  } catch (failure) {
    const row = db.query('SELECT state FROM jobs WHERE id=?').get(id) as any;
    persist(steps.some(step => step.state === 'unknown') ? 'unknown' : output ? row?.state === 'conflict' ? 'conflict' : 'save_pending' : 'failed', formatGenerationError((failure as Error).message));
  } finally {
    executionFinished = true;
    const row = db.query('SELECT state,error FROM jobs WHERE id=?').get(id) as any;
    persist(row.state, row.error); active.delete(id);
  }
  finishSavedCanvas(id);
}

async function operation(name: string, args: any, callId?: string, textNode?: { canvasPath: string; nodeId: string; selection: string }) {
  if (name === 'models') {
    const media = await models();
    return [...media, ...ids('llm').map(id => ({ providerId: 'greenroom', providerLabel: 'Greenroom 托管', modelId: id,
      label: (catalog.llm || []).find(item => item.id === id)?.label || id, type: 'text' }))];
  }
  if (name === 'resume') return restore();
  if (name === 'task') { const row = db.query('SELECT * FROM jobs WHERE id=?').get(args.task_id); if (!row) throw new Error('任务不存在'); return row; }
  if (name === 'projects') return readdirSync(workspaces, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => ({ name: item.name, directory: join(workspaces, item.name) }));
  if (name === 'create_project') {
    if (!args.name || /[\\/\0]|^\.{1,2}$/.test(args.name)) throw new Error('项目名称必须是目录名');
    const directory = inside(workspaces, args.name);
    mkdirSync(directory);
    writeFileSync(join(directory, '画布.json'), JSON.stringify(emptyCanvas()), { flag: 'wx' });
    return { name: args.name, directory, canvas: '画布.json' };
  }
  const directory = workspace(args.project);
  if (name === 'canvases') return canvases(directory).map(item => ({ path: relative(directory, item.path), nodes: item.data.nodes.length, edges: item.data.edges.length }));
  if (name === 'generate_text') {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('文本提示词不能为空');
    if (typeof args.path !== 'string' || !args.path || args.path.startsWith('/') || args.path.includes('\\')) throw new Error('产物必须使用项目内相对路径');
    if (!['.txt', '.md'].includes(extname(args.path).toLowerCase())) throw new Error('文本产物仅支持 .txt 或 .md');
    const target = inside(directory, args.path);
    if (typeof callId !== 'string' || !callId.trim()) throw new Error('文本生成缺少真实 DSH callId');
    const id = 'text:' + callId;
    const record = (row: any) => ({ task_id: row.id, state: row.state,
      ...(row.upstream_id ? { request_id: row.upstream_id } : {}),
      ...(row.result ? JSON.parse(row.result) : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.state !== 'succeeded' ? { isError: true, instruction: row.state === 'save_pending' ? '完整结果已保留；修复文件路径后重复调用仅补写原结果，不重新生成' : row.state === 'conflict' ? '原文件和完整生成结果均已保留；请查看本任务结果并自行处理，不自动重新生成' : '使用 toonflow_task 查询原 task_id；结果未确认，不自动重新生成' } : {}) });
    const saveResult = (row: any) => {
      if (row.state !== 'save_pending') return record(row);
      try {
        const result = JSON.parse(row.result);
        const filename = inside(row.cwd, result.path);
        if (filename !== row.node_id) throw new Error('产物路径已变化');
        const textCanvasBefore = JSON.parse(row.request).textCanvasBefore;
        const canvasFile = textCanvasBefore ? inside(row.cwd, textCanvasBefore.canvasPath) : undefined;
        const release = lockWorkspaceFiles([textTargetPath(filename), ...(canvasFile ? [canvasFile] : [])]);
        try {
          const before = JSON.parse(row.request).textTargetBefore;
          const current = textTargetState(filename);
          const currentNode = canvasFile && existsSync(canvasFile) ? JSON.parse(readFileSync(canvasFile, 'utf8')).nodes?.find((node: any) => node.id === textCanvasBefore.nodeId) : undefined;
          const canvasChanged = textCanvasBefore && (!currentNode || currentNode.type !== 'remote-textNode' || canvasSelection(currentNode.data) !== textCanvasBefore.selection);
          const changed = canvasChanged || !before || before.path !== current.path || (before.kind === 'file'
            ? current.kind !== 'file' || current.content !== before.content
            : current.kind === 'file');
          if (changed) {
            db.query("UPDATE jobs SET state='conflict',error=? WHERE id=?").run(before ? '目标文件已变化，未覆盖用户内容' : '原始文件状态不可用，未覆盖用户内容', row.id);
          } else {
            mkdirSync(dirname(current.path), { recursive: true });
            writeAtomicSync(current.path, result.content);
            db.query("UPDATE jobs SET state='succeeded',error=NULL WHERE id=?").run(row.id);
          }
        } finally { release(); }
      } catch (failure) {
        db.query('UPDATE jobs SET error=? WHERE id=?').run(formatGenerationError((failure as Error).message), row.id);
      }
      return record(db.query('SELECT * FROM jobs WHERE id=?').get(row.id));
    };
    const existing = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
    if (existing) {
      if (existing.cwd !== directory || existing.kind !== 'text' || existing.node_id !== target) throw new Error('调用记录不属于此项目文稿');
      return saveResult(existing);
    }
    const pendingText = () => db.query("SELECT * FROM jobs WHERE kind='text' AND cwd=? AND node_id=? AND state IN ('unknown','save_pending') LIMIT 1").get(directory, target);
    const previousTarget = pendingText();
    if (previousTarget) return saveResult(previousTarget);
    await refresh();
    const modelId = args.model_id ?? ids('llm')[0];
    if (!modelId || !ids('llm').includes(modelId)) throw new Error('管理员尚未授权该文本模型');
    const { getConfiguredModel, streamAi } = await import('@/utils/ai');
    const configured = await getConfiguredModel('greenroom', modelId);
    const { readTextReferences } = await import('./greenroom-text-references');
    const references = await readTextReferences(directory, args.references ?? [], (catalog.llm || []).find(item => item.id === modelId), configured.provider, AbortSignal.timeout(120000));
    // No await between checking the target lock and recording the submission.
    const pending = pendingText();
    if (pending) return saveResult(pending);
    const release = lockWorkspaceFiles([textTargetPath(target)]);
    try {
      const textTargetBefore = textTargetState(target);
      db.query("INSERT INTO jobs(id,cwd,kind,request,state,node_id,error) VALUES(?,?,'text',?,'unknown',?,?)")
        .run(id, directory, JSON.stringify({ ...args, model_id: modelId, textTargetBefore, textCanvasBefore: textNode }), target, '文本请求结果尚未确认');
    } finally { release(); }
    try {
      // Same native SSE parser as /api/ai/generate, but no automatic POST retries.
      const stream = streamAi(configured, {
        messages: [{ role: 'user', content: args.prompt, timestamp: Date.now() }],
      }, AbortSignal.timeout(120000), references, 0, response => {
        const requestId = response.headers.get('x-request-id');
        if (requestId) db.query('UPDATE jobs SET upstream_id=? WHERE id=?').run(requestId, id);
      });
      for await (const _event of stream) { /* Partial text is never persisted as success. */ }
      const message = await stream.result();
      if (message.stopReason !== 'stop') throw new Error(formatGenerationError(message.errorMessage) || '文本生成未完整完成，未写入产物');
      const content = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
      if (!content.trim()) throw new Error('模型未返回文本，未写入产物');
      const result = { path: args.path, content, model_id: modelId, usage: message.usage };
      // Preserve the complete model response before attempting any artifact filesystem I/O.
      db.query("UPDATE jobs SET state='save_pending',result=?,error=NULL WHERE id=?").run(JSON.stringify(result), id);
    } catch (failure) {
      db.query('UPDATE jobs SET error=? WHERE id=?').run(formatGenerationError((failure as Error).message), id);
    }
    return saveResult(db.query('SELECT * FROM jobs WHERE id=?').get(id));
  }

  if (['read_document', 'write_document', 'media_path'].includes(name)) {
    const filename = inside(directory, args.path);
    if (name === 'media_path') { const asset = await mediaCache.reference(filename); if (asset) return { path: filename, asset }; if (!statSync(filename).isFile()) throw new Error('产物不是文件'); return { path: filename }; }
    if (name === 'read_document') return { content: readFileSync(filename, 'utf8') };
    return mutateMediaFiles(directory, [filename], [filename], async () => { mkdirSync(dirname(filename), { recursive: true }); writeFileSync(filename, args.content); return { path: args.path }; });
  }
  const filename = inside(directory, args.canvas.endsWith('.json') ? args.canvas : args.canvas + '.json');
  if (name === 'create_canvas') { writeFileSync(filename, JSON.stringify(emptyCanvas()), { flag: 'wx' }); return { canvas: relative(directory, filename) }; }
  const canvas = JSON.parse(readFileSync(filename, 'utf8'));
  if (canvas.toonflowCanvas !== true) throw new Error('文件不是 Toonflow 画布');
  if (name === 'get_canvas') return canvas;
  let result;
  if (name === 'add_node') {
    const type = args.type.startsWith('remote-') ? args.type : 'remote-' + args.type;
    if (!existsSync(join(root, 'nodes', type.slice(7) + '.umd.js'))) throw new Error('节点类型未安装');
    const node = { id: crypto.randomUUID(), type, position: args.position, data: { label: args.label } };
    canvas.nodes.push(node); result = node;
  } else if (name === 'connect') {
    if (![args.source, args.target].every(id => canvas.nodes.some((node: any) => node.id === id))) throw new Error('连线节点不存在');
    const edge = { id: crypto.randomUUID(), source: args.source, target: args.target, sourceHandle: args.sourceHandle, targetHandle: args.targetHandle };
    canvas.edges.push(edge); result = edge;
  } else if (name === 'delete_edge') {
    canvas.edges = canvas.edges.filter((edge: any) => edge.id !== args.edge_id); result = { deleted: args.edge_id };
  } else {
    const node = canvas.nodes.find((node: any) => node.id === args.node_id);
    if (!node) throw new Error('节点不存在');
    if (name === 'image_variant') {
      if (!callId?.trim()) throw new Error('图片变体草稿缺少真实 DSH callId');
      const id = 'image-draft:' + callId;
      const existing = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
      if (existing) {
        if (existing.cwd !== directory || existing.kind !== 'image-draft' || existing.node_id !== node.id || JSON.parse(existing.request).canvasPath !== relative(directory, filename)) throw new Error('原草稿不属于当前画布节点');
        return { taskId: id, state: existing.state, ...(existing.result ? JSON.parse(existing.result) : {}), error: existing.error };
      }
      await refresh();
      const { buildImageVariantDraft } = await import('./greenroom-image-variants');
      const release = lockWorkspaceFiles([filename]);
      try {
        // The same callId may have completed while the model catalog was loading.
        const repeated = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
        if (repeated) {
          if (repeated.cwd !== directory || repeated.node_id !== node.id || JSON.parse(repeated.request).canvasPath !== relative(directory, filename)) throw new Error('原草稿不属于当前画布节点');
          return { taskId: id, state: repeated.state, ...(repeated.result ? JSON.parse(repeated.result) : {}) };
        }
        const current = JSON.parse(readFileSync(filename, 'utf8')), source = current.nodes?.find((entry: any) => entry.id === node.id);
        if (current.toonflowCanvas !== true || source?.type !== 'remote-imageNode') throw new Error('请选择已有原生图片节点');
        if (!existsSync(join(root, 'nodes/imageGenerationNode.umd.js'))) throw new Error('图片生成节点类型未安装');
        const path = source.data?.outputs?.image?.value?.url;
        if (typeof path !== 'string' || !path || /^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(path) || path.split(/[\\/]+/).includes('..')) throw new Error('原图须为成员项目内的相对路径');
        const image = inside(directory, path);
        if (existsSync(image)) {
          if (!statSync(image).isFile() || realpathSync(image) !== image) throw new Error('原图须为成员项目内普通文件，不使用符号链接');
        } else if (!mediaCache.hasFiles(directory, [image])) throw new Error('原图文件不存在且没有原 Asset 缓存记录');
        const result = buildImageVariantDraft(source, { kind: args.kind, model_id: args.model_id, ratio: args.ratio, size: args.size, options: args.options }, (catalog.image || []).filter(item => ids('image').includes(item.id)));
        db.query("INSERT INTO jobs(id,cwd,kind,request,state,node_id,error) VALUES(?,?,'image-draft',?,'unknown',?,?)")
          .run(id,directory,JSON.stringify({ ...args, canvasPath: relative(directory, filename) }),node.id,'草稿写入结果尚未确认，不自动再次创建');
        current.nodes.push(result.node); current.edges.push(result.edge);
        writeAtomicSync(filename, JSON.stringify(current));
        db.query("UPDATE jobs SET state='succeeded',result=?,error=NULL WHERE id=?").run(JSON.stringify(result),id);
        return { taskId: id, state: 'succeeded', ...result };
      } finally { release(); }
    }
    if (name === 'analyze_scenes') {
      if (node.type !== 'remote-frameAnalysisNode') throw new Error('请选择原生拉片节点');
      if (!callId?.trim()) throw new Error('AI 拉片缺少真实 DSH callId');
      const id = 'scene-ai:' + callId;
      const recorded = () => (db.query("SELECT * FROM jobs WHERE cwd=? AND kind='scene-ai' AND node_id=? ORDER BY rowid DESC").all(directory, node.id) as any[])
        .find(row => JSON.parse(row.request).canvasPath === relative(directory, filename) && !['succeeded','failed','conflict'].includes(row.state));
      let existing = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
      if (existing) {
        if (existing.cwd !== directory || existing.kind !== 'scene-ai' || existing.node_id !== node.id || JSON.parse(existing.request).canvasPath !== relative(directory, filename)) throw new Error('原调用不属于当前拉片节点');
        finishSavedCanvas(id); existing = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
        return { taskId: id, state: existing.state, instruction: '查询原任务及已保存的逐步响应，不自动重新分析' };
      }
      const pending = recorded(); if (pending) { finishSavedCanvas(pending.id); return { taskId: pending.id, state: (db.query('SELECT state FROM jobs WHERE id=?').get(pending.id) as any).state, instruction: '原分析结果尚未确认，不重新提交' }; }
      await refresh();
      const modelId = args.model_id ?? ids('llm')[0], modelEntry = (catalog.llm || []).find(item => item.id === modelId);
      const caps = modelEntry?.capabilities, modalities = caps?.input_modalities;
      if (!ids('llm').includes(modelId) || caps?.verification_status === 'unknown' || !Array.isArray(modalities) || modalities.some(value => typeof value !== 'string' || !value) || !modalities.includes('image')) throw new Error('AI 拉片需要成员目录明确授权图片输入的文本模型');
      const { getConfiguredModel } = await import('@/utils/ai');
      const configured = await getConfiguredModel('greenroom', modelId);
      const repeated = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
      if (repeated) {
        if (repeated.cwd !== directory || repeated.node_id !== node.id || JSON.parse(repeated.request).canvasPath !== relative(directory, filename)) throw new Error('原调用不属于当前拉片节点');
        return { taskId: id, state: repeated.state };
      }
      const afterAwait = recorded(); if (afterAwait) return { taskId: afterAwait.id, state: afterAwait.state };
      const release = lockWorkspaceFiles([filename]);
      let request: any, snapshot: any;
      try {
        const current = JSON.parse(readFileSync(filename, 'utf8')), currentNode = current.nodes?.find((entry: any) => entry.id === node.id);
        if (current.toonflowCanvas !== true || !currentNode || currentNode.type !== 'remote-frameAnalysisNode') throw new Error('原拉片节点已变化');
        const settings = currentNode.data?.frameAnalysis, result = settings?.lastResult;
        const edge = current.edges.find((entry: any) => entry.target === node.id && entry.targetHandle === 'in');
        const output = edge && current.nodes.find((entry: any) => entry.id === edge.source)?.data?.outputs?.[edge.sourceHandle];
        const source = edge ? output?.dataType === 'VIDEO' ? output.value?.url : undefined : settings?.source?.url;
        if (!source || settings?.resultSource !== source || !result?.manifest || !Array.isArray(result.scenes)) throw new Error('请先对当前原视频完成本地拉片并保存结果');
        if (typeof args.focus !== 'undefined' && (typeof args.focus !== 'string' || args.focus.trim().length > 2000)) throw new Error('分析重点最多填写 2000 字');
        const manifest = inside(directory, result.manifest);
        if (statSync(manifest).size > 20 * 1024 * 1024) throw new Error('原业务清单超过读取限制');
        snapshot = { version: 1, node: currentNode, input: canvasInputsSnapshot(current, node.id), affected: current.nodes.filter((entry: any) => entry.data?.frameAnalysisResult?.ownerId === node.id && entry.data.frameAnalysisResult.manifest === result.manifest), manifest: readFileSync(manifest, 'utf8') };
        request = { project: args.project, canvasPath: relative(directory, filename), node_id: node.id, model_id: modelId, source, result, focus: args.focus ?? '', canvasBefore: snapshot };
        db.query("INSERT INTO jobs(id,cwd,kind,request,state,node_id) VALUES(?,?,'scene-ai',?,'running',?)").run(id,directory,JSON.stringify(request),node.id);
      } finally { release(); }
      void runSceneAnalysis(id, directory, request, configured, modelEntry);
      return { taskId: id, state: 'running' };
    }
    if (name === 'generate_text_node') {
      if (node.type !== 'remote-textNode') throw new Error('请选择原生文本节点');
      if (!callId?.trim()) throw new Error('文本生成缺少真实 DSH callId');
      // Only the canonical native document, never a stale inline textSnapshot/outputs.text.
      textNodeReference(directory, node);
      const path = `assets/${node.id}/content.md`;
      const target = inside(directory, path);
      const original = db.query('SELECT * FROM jobs WHERE id=?').get('text:' + callId) as any;
      if (original) {
        if (original.cwd !== directory || original.kind !== 'text' || original.node_id !== target) throw new Error('原调用不属于当前文本节点');
        return operation('generate_text', JSON.parse(original.request), callId);
      }
      const pending = db.query("SELECT * FROM jobs WHERE kind='text' AND cwd=? AND node_id=? AND state IN ('unknown','save_pending') LIMIT 1").get(directory, target) as any;
      if (pending) return operation('generate_text', JSON.parse(pending.request), pending.id.slice(5));
      const inputs = nodeInputs(directory, canvas, node);
      if (inputs.some(item => item.value === undefined)) throw new Error('引用节点暂无内容，请先补充引用内容');
      const prompt = (await import('./greenroom-prompt')).resolveVideoPrompt(node.data, inputs).trim();
      const choice = node.data.model ? JSON.parse(node.data.model) : undefined;
      if (choice && (!Array.isArray(choice) || choice[0] !== 'greenroom' || typeof choice[1] !== 'string')) throw new Error('文本模型必须来自成员托管目录');
      return operation('generate_text', { project: args.project, path, prompt, model_id: choice?.[1],
        references: inputs.map(({ dataType, value }) => ({ dataType, value })) }, callId,
        { canvasPath: relative(directory, filename), nodeId: node.id, selection: canvasSelection(node.data) });
    }
    if (name === 'local_media') {
      if (!callId?.trim()) throw new Error('本地媒体处理缺少真实 DSH callId');
      const id = 'local:' + callId;
      let existing = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
      if (existing) {
        if (existing.cwd !== directory || existing.node_id !== node.id || JSON.parse(existing.request).canvasPath !== relative(directory, filename)) throw new Error('处理记录不属于此画布节点');
        finishSavedCanvas(id); existing = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
        return { taskId: id, state: existing.state, ...(existing.result ? JSON.parse(existing.result) : {}), error: existing.error };
      }
      if (typeof node.id !== 'string' || /[\\/\0]|^\.{1,2}$/.test(node.id)) throw new Error('节点 ID 无效');
      const kind = args.kind;
      const expected = kind === 'frames' ? 'remote-frameAnalysisNode' : kind === 'video' ? 'remote-videoNode' : kind === 'image-grid' ? 'remote-imageNode' : '';
      if (!expected || node.type !== expected) throw new Error('操作与原生节点类型不匹配');
      let source = node.data?.outputs?.[kind === 'image-grid' ? 'image' : 'video']?.value;
      if (kind === 'frames') {
        const incoming = canvas.edges.filter((edge: any) => edge.target === node.id && edge.targetHandle === 'in');
        const edge = incoming[0];
        const output = edge && canvas.nodes.find((item: any) => item.id === edge.source)?.data?.outputs?.[edge.sourceHandle];
        source = edge ? output?.dataType === 'VIDEO' ? output.value : undefined : node.data?.frameAnalysis?.source;
      }
      if (!source?.url || typeof source.url !== 'string') throw new Error('节点缺少可读取的原媒体');
      inside(directory, source.url);
      const options = args.options || {};
      if (options.aiEnabled) throw new Error('本工具只做本地媒体处理，不自动调用模型');
      const request = { ...options, kind, source: source.url, sourceMimeType: source.mimeType, outputDirectory: `assets/${node.id}/managed-${crypto.randomUUID()}` };
      const selection = localMediaSelection(directory, request);
      const pending = (db.query("SELECT * FROM jobs WHERE cwd=? AND kind='local-media' AND node_id=? ORDER BY rowid DESC").all(directory, node.id) as any[])
        .find(row => {
          if (['succeeded','failed','conflict'].includes(row.state)) return false;
          const original = JSON.parse(row.request);
          if (original.canvasPath !== relative(directory, filename)) return false;
          let previous: string | undefined;
          try { previous = localMediaSelection(directory, original); }
          catch { return false; } // An invalid/now-outside old source cannot identify this valid new request; retain its row untouched.
          return previous === undefined || previous === selection;
        });
      if (pending) { finishSavedCanvas(pending.id); const row = db.query('SELECT * FROM jobs WHERE id=?').get(pending.id) as any;
        return { taskId: row.id, state: row.state, ...(row.result ? JSON.parse(row.result) : {}), error: row.error }; }
      for (const type of kind === 'frames' ? [['imageNode',options.frames !== false],['videoNode',options.clips !== false],['audioNode',options.audio !== false]].filter(([,enabled]) => enabled).map(([type]) => type) : kind === 'video' ? options.action === 'extractAudio' ? ['audioNode'] : options.action === 'trim' ? ['videoNode'] : ['videoNode','audioNode'] : ['imageNode'])
        if (!existsSync(join(root, 'nodes', type + '.umd.js'))) throw new Error('处理结果需要已安装的原生素材节点：' + type);
      db.query("INSERT INTO jobs(id,cwd,kind,request,state,node_id) VALUES(?,?,'local-media',?,'running',?)").run(id, directory, JSON.stringify({ ...request, canvasPath: relative(directory, filename),
        canvasBefore: { version: 1, node, input: canvasInputsSnapshot(canvas, node.id) } }), node.id);
      void runLocalMedia(id, directory, request);
      return { taskId: id, state: 'running' };
    }
    if (name === 'director') {
      if (node.type !== 'remote-director3dNode') throw new Error('请选择原生 3D 导演节点');
      if (typeof node.id !== 'string' || /[\\/\0]|^\.{1,2}$/.test(node.id)) throw new Error('节点 ID 无效');
      const { readDirectorDocument, addDirectorMannequin, restoreDirectorInstruction, editDirectorAnchors } = await import('./greenroom-director');
      const path = `assets/${node.id}/model.json`;
      const modelFile = inside(directory, path);
      const release = lockWorkspaceFiles([filename, modelFile]);
      try {
        const current = JSON.parse(readFileSync(filename, 'utf8'));
        const target = current.nodes?.find((item: any) => item.id === node.id);
        if (!target || target.type !== node.type || current.toonflowCanvas !== true) throw new Error('导演节点已变化');
        if (target.data.modelSnapshot) throw new Error('请先在原生界面完成复制场景落盘，再处理模型文档');
        if (target.data.modelPath && target.data.modelPath !== path) throw new Error('导演台模型文件路径无效');
        const document = readDirectorDocument(target.data.modelPath ? JSON.parse(readFileSync(modelFile, 'utf8')) : undefined);
        if (args.action === 'read') return { path: target.data.modelPath ?? null, document, selectedPlanId: target.data.selectedPlanId ?? null,
          supported: ['read','select_plan','add_mannequin','restore_instruction','set_anchors','reorder_anchors','remove_anchor'], renderAvailable: false };
        if (['restore_instruction','set_anchors','reorder_anchors','remove_anchor'].includes(args.action)) {
          if (!callId?.trim()) throw new Error('导演输入修改缺少真实 DSH callId');
          const id = 'director-input:' + callId;
          const existing = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
          if (existing) {
            if (existing.cwd !== directory || existing.node_id !== node.id || JSON.parse(existing.request).canvasPath !== relative(directory, filename)) throw new Error('原输入修改不属于此导演节点');
            return { taskId: id, state: existing.state, ...(existing.result ? JSON.parse(existing.result) : {}), error: existing.error };
          }
          const data = args.action === 'restore_instruction' ? restoreDirectorInstruction(document, args.plan_id)
            : editDirectorAnchors(target.data.anchors, args.action === 'set_anchors' ? { action: 'set', anchors: args.anchors }
              : args.action === 'reorder_anchors' ? { action: 'reorder', anchorIds: args.anchor_ids } : { action: 'remove', anchorId: args.anchor_id });
          const result = { ...data, renderAvailable: false, viewCaptured: false, generationSubmitted: false };
          db.query("INSERT INTO jobs(id,cwd,kind,request,state,node_id,error) VALUES(?,?,'director-input',?,'unknown',?,?)")
            .run(id,directory,JSON.stringify({ ...args, canvasPath: relative(directory, filename) }),node.id,'原输入修改结果尚未确认，不自动重复写入');
          Object.assign(target.data, data); writeAtomicSync(filename, JSON.stringify(current));
          db.query("UPDATE jobs SET state='succeeded',result=?,error=NULL WHERE id=?").run(JSON.stringify(result),id);
          return { taskId: id, state: 'succeeded', ...result };
        }
        if (args.action === 'select_plan') {
          if (!document.plans.some((plan: any) => plan.id === args.plan_id)) throw new Error('原方案不存在');
          target.data.selectedPlanId = args.plan_id;
          writeAtomicSync(filename, JSON.stringify(current));
          return { selectedPlanId: args.plan_id };
        }
        if (args.action === 'add_mannequin') {
          // Only an already bound native document: one atomic file write, never invent a rendered plan.
          if (!target.data.modelPath) throw new Error('请先在原生导演台保存场景；本工具仅向已有绑定场景添加人偶');
          if (!callId?.trim()) throw new Error('导演场景修改缺少真实 DSH callId');
          const id = 'director:' + callId;
          const existing = db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
          if (existing) {
            if (existing.cwd !== directory || existing.node_id !== modelFile) throw new Error('处理记录不属于此场景');
            return { taskId: id, state: existing.state, ...(existing.result ? JSON.parse(existing.result) : {}), error: existing.error };
          }
          const next = addDirectorMannequin(document);
          const result = { path, object: next.scene.objectList.at(-1), renderAvailable: false };
          db.query("INSERT INTO jobs(id,cwd,kind,request,state,node_id,error) VALUES(?,?,'director',?,'unknown',?,?)").run(id,directory,JSON.stringify(args),modelFile,'场景修改结果尚未确认；请查询原 taskId，不自动重做');
          writeAtomicSync(modelFile, JSON.stringify(next));
          db.query("UPDATE jobs SET state='succeeded',result=?,error=NULL WHERE id=?").run(JSON.stringify(result),id);
          return { taskId: id, state: 'succeeded', ...result };
        }
        throw new Error('不支持的导演操作；AI 方案生成和画面导出仍需要原生浏览器渲染合同');
      } finally { release(); }
    }
    if (name === 'update_node') {
      if (Object.keys(args.data).some(key => /api.?key|token|secret|base.?url/i.test(key))) throw new Error('模型凭据由管理员统一配置');
      node.data = { ...node.data, ...args.data }; result = node;
    } else if (name === 'move_node') { node.position = args.position; result = node; }
    else if (name === 'delete_node') { canvas.nodes = canvas.nodes.filter((item: any) => item.id !== node.id); canvas.edges = canvas.edges.filter((edge: any) => edge.source !== node.id && edge.target !== node.id); result = { deleted: node.id }; }
    else if (name === 'generate_node') {
      if (!callId?.trim()) throw new Error('生成节点缺少真实 DSH callId');
      // Complete asynchronous preparation before the final canvas read: the
      // request and its writeback selection must come from the same snapshot.
      const priorBeforeRefresh = mediaJob('media:' + callId);
      const pendingBeforeRefresh = latestCanvasJob(directory, args.node_id, filename);
      const observedPrior = priorBeforeRefresh || (pendingBeforeRefresh && !['succeeded','failed'].includes(pendingBeforeRefresh.state) ? pendingBeforeRefresh : null);
      if (!observedPrior) await refresh();
      let currentCanvas = JSON.parse(readFileSync(filename, 'utf8'));
      if (currentCanvas.toonflowCanvas !== true) throw new Error('文件不是 Toonflow 画布');
      let currentNode = currentCanvas.nodes.find((entry: any) => entry.id === args.node_id);
      if (!currentNode) throw new Error('节点不存在');
      let resolveVideoPrompt: ((data: any, inputs: any[]) => string) | undefined;
      if (/videoGenerationNode$/.test(currentNode.type)) {
        resolveVideoPrompt = (await import('./greenroom-prompt')).resolveVideoPrompt;
        currentCanvas = JSON.parse(readFileSync(filename, 'utf8'));
        if (currentCanvas.toonflowCanvas !== true) throw new Error('文件不是 Toonflow 画布');
        currentNode = currentCanvas.nodes.find((entry: any) => entry.id === args.node_id);
        if (!currentNode) throw new Error('节点不存在');
      }
      const node = currentNode, canvas = currentCanvas;
      const kind = /imageGenerationNode$/.test(node.type) ? 'image' : /videoGenerationNode$/.test(node.type) ? 'video' : /audioGenerationNode$/.test(node.type) ? 'audio' : undefined;
      if (!kind) throw new Error('请选择图片、视频或音频生成节点');
      if (kind === 'image' && node.data?.inpaint) throw new Error('后台局部重绘尚未接入官方 guide/mask 合成合同；不会作为普通图片生成提交');
      // Discovery selects stored defaults only; start below still validates the
      // complete current input, kind and exact workspace/canvas ownership.
      const original = mediaJob('media:' + callId);
      const pending = latestCanvasJob(directory, node.id, filename);
      const concurrent = pending && pending.id !== pendingBeforeRefresh?.id ? pending : null;
      const prior = original || observedPrior || concurrent || (pending && !['succeeded','failed'].includes(pending.state) ? pending : null);
      const priorModel = prior?.original_request ? JSON.parse(prior.original_request).modelId : undefined;
      const choice = node.data.model ? JSON.parse(node.data.model) : ['greenroom', prior ? priorModel : (kind === 'audio' ? [...ids('tts'), ...ids('music')] : ids(kind))[0]];
      const inputs = nodeInputs(directory, canvas, node);
      if (inputs.some((item: any) => item.value === undefined)) throw new Error('引用节点暂无内容，请先补充引用内容');
      const basePrompt = kind === 'video' ? resolveVideoPrompt!(node.data, inputs) : node.data.prompt || '';
      const prompt = [basePrompt.trim(), ...inputs.flatMap((item: any, index: number) => item.dataType === 'STRING' && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])].filter(Boolean).join('\n\n');
      if (!prompt) throw new Error('请输入生成提示词');
      const images = inputs.flatMap((item: any) => item.dataType === 'IMAGE' && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
      const request = { ...node.data, providerId: 'greenroom', modelId: choice[1], prompt, images, outputDirectory: `assets/${node.id}` };
      if (kind === 'video') {
        const mode = node.data.mode ? JSON.parse(node.data.mode) : undefined;
        const frameMode = ['startEndRequired', 'endFrameOptional', 'startFrameOptional'].includes(String(mode));
        request.mode = mode;
        request.images = frameMode ? undefined : images;
        request.firstFrame = frameMode && (mode !== 'startFrameOptional' || images.length > 1) ? images[0] : undefined;
        request.lastFrame = frameMode ? images[mode === 'startFrameOptional' && images.length === 1 ? 0 : 1] : undefined;
        request.videos = inputs.flatMap((item: any) => item.dataType === 'VIDEO' && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
        request.audios = inputs.flatMap((item: any) => item.dataType === 'AUDIO' && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
        const counts: Record<string, number> = { IMAGE: 0, VIDEO: 0, AUDIO: 0 };
        request.referenceOrder = inputs.map((item: any) => {
          if (!Object.hasOwn(counts, item.dataType)) return { type: 'text' };
          const index = counts[item.dataType]++;
          if (frameMode && item.dataType === 'IMAGE') return { type: index === 0 && request.firstFrame ? 'firstFrame' : 'lastFrame' };
          return { type: item.dataType.toLowerCase(), index };
        });
        orderedVideoInputs(request); // Refuse a mismatched native contract before creating a job or uploading files.
      } else if (kind === 'audio') request.audios = inputs.flatMap((item: any) => item.dataType === 'AUDIO' && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
      const taskId = start(directory, 'media:' + callId, kind, request, {
        nodeId: node.id, canvasPath: relative(directory, filename), observedJobId: (observedPrior || concurrent)?.id,
        greenroomCanvasBefore: {
          selection: JSON.stringify(mediaCanvasSelection(node.data)),
          inputs: JSON.parse(JSON.stringify(inputs.map(({ source, sourceHandle, dataType, value }: any) => ({
            source, sourceHandle, dataType, value,
          })))),
        },
      });
      return status(directory, [taskId])[0];
    } else throw new Error('未知业务操作');
  }
  writeFileSync(filename, JSON.stringify(canvas));
  return result;
}
export function isIdleForShutdown() {
  try {
    return !activeRequests && !activeHandlers && !active.size && !mediaCache.busy
      && !db.query("SELECT id FROM jobs WHERE state IS NULL OR state NOT IN ('succeeded','failed','conflict') LIMIT 1").get();
  } catch { return false; } // unreadable state is not proof of idle
}
// A disconnected response does not cancel an async native route. Count its
// returned promise until the work itself has finished, independently of the socket.
export function trackHandler(handler: any) {
  const run = (args: any[]) => {
    activeHandlers++;
    let result: any;
    try { result = handler(...args); }
    catch (error) { activeHandlers--; throw error; }
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(() => { activeHandlers--; });
    activeHandlers--;
    return result;
  };
  return handler.length === 4
    ? (error: any, req: any, res: any, next: any) => run([error, req, res, next])
    : (req: any, res: any, next: any) => run([req, res, next]);
}
export function trackRouter(router: any) {
  for (const layer of router.stack) {
    if (layer.route) {
      for (const routeLayer of layer.route.stack) routeLayer.handle = trackHandler(routeLayer.handle);
    } else if (layer.handle?.stack) trackRouter(layer.handle);
    else layer.handle = trackHandler(layer.handle);
  }
  return router;
}
export function beginIdleShutdown() {
  if (shuttingDown || !isIdleForShutdown()) return false;
  shuttingDown = true; // no await before the listener starts closing
  return true;
}
export async function install(app: Express) {
  await refresh();
  app.get('/api/greenroom/lifecycle', (_req, res) => res.json({ known: true, busy: Boolean(shuttingDown || !isIdleForShutdown()) }));
  app.use((_req, res, next) => {
    if (shuttingDown) return res.status(503).json(error('服务正在停止，未受理新操作', null, 503));
    activeRequests++;
    let released = false;
    const release = () => { if (!released) { released = true; activeRequests--; } };
    res.once('finish', release);
    res.once('close', release);
    next();
  });
  app.use(trackHandler(async (req: any, res: any, next: any) => {
    if (req.path === '/mcp' || req.path.startsWith('/a2a') || req.path.startsWith('/api/settings/network/') || /^\/api\/(?:agent|agents|singleAgent|browser|mcp|providers|multiTenant|plugins)\b/i.test(req.path)
      || /^\/api\/channel\/(?:account|model|provider|subAccounts|user|wallet|plugin)\b/i.test(req.path)
      || /\/api\/(?:nodes|tools|skills|ext)\/(?:install|save|uninstall|setEnabled|remove|create)/.test(req.path))
      return res.status(403).json(error('创作调度与服务配置由 Greenroom 统一管理', null, 403));
    try { if (['/api/ai/models','/api/ai/generate','/api/ai/media/models','/api/ai/media/generate'].includes(req.path)) await refresh(); next(); }
    catch (failure) { next(failure); }
  }));
  app.post('/api/greenroom/operation', trackHandler(async (req: any, res: any, next: any) => { try { res.json(await operation(req.body.operation, req.body.arguments || {}, req.body.callId)); } catch (failure) { next(failure); } }));
  restore();
}
