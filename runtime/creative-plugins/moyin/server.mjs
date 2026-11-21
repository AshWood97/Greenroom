import { createLocalOutputs, createShotWriteback } from './local-outputs.mjs';
import { splitQuadImage } from './quad-split.mjs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, realpathSync, createReadStream } from 'node:fs';
import { join, resolve, dirname, sep, extname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { formatGenerationError } from './greenroom-generation-error.ts';

const root = resolve(process.env.GREENROOM_PLUGIN_ROOT);
const data = join(root, 'data');
const media = join(root, 'media');
const base = process.env.GREENROOM_BASE_PATH || '/plugins/moyin/';
const bridge = process.env.GREENROOM_MANAGED_URL || 'http://127.0.0.1:18767/managed';
const broker = process.env.GREENROOM_BROKER_URL || 'http://127.0.0.1:3081';
const opfs = join(root, 'opfs');
const temporary = join(root, 'tmp');
process.env.TMPDIR = temporary;
for (const folder of [root, data, media, opfs, temporary]) mkdirSync(folder, { recursive: true });
const db = new DatabaseSync(join(root, 'moyin-jobs.sqlite3'));
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, operation TEXT, args TEXT, state TEXT, result TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS media_jobs(id TEXT PRIMARY KEY, kind TEXT, payload TEXT, upstream_id TEXT, state TEXT, result TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS files(directory TEXT, key TEXT, name TEXT, mime TEXT, PRIMARY KEY(directory,key))`);
// NULL is deliberately unknown for old rows: an old pending request may have
// reached the bridge before its task ID was saved. Only new ready rows may send.
if (!db.prepare('PRAGMA table_info(media_jobs)').all().some(column => column.name === 'submission_state')) {
  db.exec('ALTER TABLE media_jobs ADD COLUMN submission_state TEXT');
}
// Existing media has no proven parent. Never backfill from IDs or snapshots.
db.exec('BEGIN IMMEDIATE');
try {
  if (!db.prepare('PRAGMA table_info(media_jobs)').all().some(column => column.name === 'parent_job_id')) {
    db.exec('ALTER TABLE media_jobs ADD COLUMN parent_job_id TEXT');
  }
  db.exec('COMMIT');
} catch (failure) { db.exec('ROLLBACK'); throw failure; }
const pending = new Set();
const mediaPending = new Set();
const jobScope = new AsyncLocalStorage();
let queue = Promise.resolve();
let configuration = { catalog: {}, models: { image: [], video: [], llm: [] }, parameters: {} };

function inside(directory, name) {
  const filename = resolve(directory, name);
  if (filename !== directory && !filename.startsWith(directory + sep)) throw new Error('路径超出成员私有目录');
  let existing = filename;
  while (!existsSync(existing)) existing = dirname(existing);
  if (realpathSync(existing) !== realpathSync(directory) && !realpathSync(existing).startsWith(realpathSync(directory) + sep)) throw new Error('路径超出成员私有目录');
  return filename;
}
const mime = filename => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[extname(filename).toLowerCase()] || 'application/octet-stream');
const filename = key => inside(data, key + '.json');
const shotWriteback = createShotWriteback({ db, filename });
const storage = {
  getItem: async key => existsSync(filename(key)) ? readFileSync(filename(key), 'utf8') : null,
  setItem: async (key, value, previous) => { mkdirSync(dirname(filename(key)), { recursive: true }); const merged = shotWriteback.mergeWrite(key, value, previous); shotWriteback.beforeWrite(key, merged.value); writeFileSync(filename(key), merged.value); shotWriteback.finishWrite(merged.superseded); return true; },
  removeItem: async key => { shotWriteback.beforeWrite(key, null); rmSync(filename(key), { force: true }); return true; },
  exists: async key => existsSync(filename(key)),
  async listKeys(prefix = '') { const dir = inside(data, prefix); return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(item => item.isFile()).map(item => join(prefix, item.name.replace(/\.json$/, ''))) : []; },
  async listDirs(prefix = '') { const dir = inside(data, prefix); return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name) : []; },
  removeDir: async key => { if (!key || key === '.') throw new Error('不能删除成员数据根目录'); shotWriteback.beforeWrite(key, null, true); rmSync(inside(data, key), { recursive: true, force: true }); return true; },
};
function readLocal(path) { return inside(media, path.replace(/^local-image:\/\//, '').replace(new RegExp('^' + base + 'media/'), '')); }
function referencedAsset(value) {
  if (typeof value !== 'string') return null;
  for (const prefix of ['local-image://asset-ref/', base + 'media/asset-ref/', '/api/media/']) {
    if (!value.startsWith(prefix)) continue;
    const id = value.slice(prefix.length);
    return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
  }
  return null;
}
const assetReference = id => 'local-image://asset-ref/' + id;
const assetPath = id => base + 'media/asset-ref/' + id;
const assetEndpoint = id => bridge + '/media/' + encodeURIComponent(id);

async function readMemberMedia(value) {
  if (typeof value !== 'string') throw new Error('素材引用格式无效');
  const asset = referencedAsset(value);
  if (asset) {
    const response = await fetch(assetEndpoint(asset));
    if (!response.ok) throw new Error('成员素材读取失败：' + response.status);
    return Buffer.from(await response.arrayBuffer());
  }
  if (value.startsWith('local-image://')) return readFileSync(readLocal(value));
  if (value.startsWith(base + 'media/')) return readFileSync(readLocal(decodeURIComponent(value)));
  if (/^data:image\/(png|jpeg|webp);base64,/i.test(value)) return Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  if (/^\/api\/media\/[^/?#]+$/.test(value)) {
    const response = await fetch(bridge + '/media/' + encodeURIComponent(decodeURIComponent(value.slice('/api/media/'.length))));
    if (!response.ok) throw new Error('成员素材读取失败：' + response.status);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('请使用当前成员的本地媒体引用或 Asset URL，不接受任意外部地址');
}
const localOutputs = createLocalOutputs({ media, base, inside, scope: jobScope, readMedia: readMemberMedia, splitQuad: splitQuadImage });
globalThis.greenroomReadExport = async value => new Blob([await readMemberMedia(value)]);
globalThis.greenroomExportFolder = run => localOutputs.exportFolder(run);
globalThis.greenroomSplitQuad = value => localOutputs.split(value);

async function bridgeRequest(route, body, submission, timeout = 120000) {
  const response = await fetch(bridge + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(submission ? { 'X-T8-Provider-Submission': submission } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
  const value = await response.json();
  if (!response.ok || value.success === false) throw Object.assign(new Error(formatGenerationError({ ...value, httpStatus: response.status })), { status: response.status, submitted: value.submitted, code: value.code });
  return value.data ?? value;
}
async function refresh() {
  const catalog = await bridgeRequest('/models', undefined, undefined, 4000);
  const settings = await bridgeRequest('/plugins/moyin/settings', undefined, undefined, 4000);
  configuration = { catalog, models: settings.models || Object.fromEntries(Object.entries(catalog).map(([kind, items]) => [kind, items.map(item => typeof item === 'string' ? item : item.id)])), parameters: settings.parameters || {} };
  return configuration;
}
// Only an exact image catalog row with a verified numeric limit constrains refs.
function imageReferenceLimit(model) {
  const caps = configuration.catalog.image?.find(item => item && typeof item === 'object' && item.id === model)?.capabilities;
  const limit = caps?.maxReferenceImages;
  return caps?.verification_status === 'verified' && Number.isSafeInteger(limit) && limit >= 0 ? limit : null;
}
globalThis.greenroomImageReferenceLimit = imageReferenceLimit;
async function upload(path) {
  if (!path) return undefined;
  const asset = referencedAsset(path);
  if (asset) return '/api/media/' + asset;
  if (path.startsWith('/api/media/') || /^data:|^https?:/i.test(path)) return path;
  if (!path.startsWith('local-image://') && !path.startsWith(base + 'media/')) throw new Error('参考素材格式无效：请使用成员图片引用或完整图片 data URL');
  const file = readLocal(path);
  const type = mime(file);
  const response = await fetch(bridge + '/media/uploads', { method: 'POST', body: readFileSync(file), headers: {
    'Content-Type': type, 'X-File-Name': encodeURIComponent(file.split(sep).at(-1)), 'X-Asset-Type': type.split('/')[0] } });
  const value = await response.json();
  if (!response.ok || value.success === false) throw new Error(formatGenerationError({ ...value, httpStatus: response.status }));
  return (value.data ?? value).fileUrl;
}
async function saveImage(url, category = 'images', name = 'image.png') {
  const asset = referencedAsset(url);
  if (asset) return { success: true, localPath: assetReference(asset) };
  if (url.startsWith('local-image://')) return { success: true, localPath: url };
  let response;
  let type = url.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();
  if (!url.startsWith('data:')) {
    const resource = url.startsWith('/api/media/') ? bridge + '/media/' + url.split('/').at(-1) : url.startsWith(base + 'media/') ? 'http://127.0.0.1:18803' + url.slice(base.length - 1) : url;
    response = await fetch(resource);
    if (!response.ok) throw new Error(`素材保存失败（HTTP ${response.status}）`);
    type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  }
  const extension = extname(name) || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[type]);
  if (!extension) throw new Error('参考图片缺少可识别的文件类型');
  const destination = inside(media, join(category.replace(/[^a-z0-9_-]/gi, '_'), randomUUID() + extension));
  mkdirSync(dirname(destination), { recursive: true });
  if (url.startsWith('data:')) writeFileSync(destination, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  else {
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    await pipeline(response.body, createWriteStream(destination));
  }
  return { success: true, localPath: 'local-image://' + relative(media, destination).split(sep).join('/') };
}
globalThis.window = globalThis;
globalThis.greenroomWorker = true;
globalThis.fileStorage = storage;
globalThis.localStorage = {
  getItem(key) { const path = filename('_local/' + key); return existsSync(path) ? readFileSync(path, 'utf8') : null; },
  setItem(key, value) { const path = filename('_local/' + key); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, String(value)); },
  removeItem(key) { rmSync(filename('_local/' + key), { force: true }); },
};
globalThis.imageStorage = {
  saveImage, getImagePath: async value => referencedAsset(value) ? assetPath(referencedAsset(value)) : base + 'media/' + relative(media, readLocal(value)).split(sep).join('/'),
  deleteImage: async value => { if (!referencedAsset(value)) rmSync(readLocal(value), { force: true }); return true; },
  readAsBase64: async value => {
    const asset = referencedAsset(value);
    if (asset) {
      const response = await fetch(assetEndpoint(asset));
      if (!response.ok) throw new Error(`素材读取失败（HTTP ${response.status}）`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
      return { success: true, base64: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType, size: bytes.length };
    }
    const file = readLocal(value); const bytes = readFileSync(file); const mimeType = mime(file);
    return { success: true, base64: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType, size: bytes.length };
  },
  getAbsolutePath: async value => referencedAsset(value) ? assetPath(referencedAsset(value)) : readLocal(value),
};
const events = new EventTarget();
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
globalThis.dispatchEvent = events.dispatchEvent.bind(events);
globalThis.greenroomDb = {
  get: (namespace, key) => storage.getItem('_db/' + namespace + '/' + key).then(value => value === null ? null : JSON.parse(value)),
  set: (namespace, key, value) => storage.setItem('_db/' + namespace + '/' + key, JSON.stringify(value)),
  remove: (namespace, key) => storage.removeItem('_db/' + namespace + '/' + key),
  list: namespace => storage.listKeys('_db/' + namespace).then(values => values.map(value => value.split('/').at(-1))),
  clear: namespace => storage.removeDir('_db/' + namespace),
};

async function runMedia(id, initialInsert = false) {
  if (mediaPending.has(id)) return;
  mediaPending.add(id);
  let row = db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id);
  try {
    if (!row || ['succeeded', 'failed'].includes(row.state)) return;
    let upstream = row.upstream_id;
    // Recovery can query an accepted task, never turn persisted readiness into
    // a new submission. Only this process's successful first INSERT may send.
    if (!upstream && !initialInsert) {
      db.prepare('UPDATE media_jobs SET error=? WHERE id=?').run('原媒体尚无已受理任务编号；恢复仅查询原任务，未重新提交。原媒体 ID：' + id, id);
      return;
    }
    const payload = JSON.parse(row.payload);
    // Historical shot jobs have no trustworthy selection/input snapshot. Their
    // recovery must remain lookup-only, including startup's media-first pass.
    const legacyShot = !upstream && db.prepare("SELECT j.id FROM jobs j LEFT JOIN shot_selections s ON s.job_id=j.id WHERE j.operation IN ('shot_image','shot_video') AND j.id || '-media-0'=? AND s.job_id IS NULL").get(id);
    if (legacyShot) {
      db.prepare("UPDATE media_jobs SET state='waiting', error=? WHERE id=?").run('历史镜头任务缺少可恢复的原任务编号；未重新提交生成', id);
      return;
    }
    if (!upstream) {
      if (row.submission_state !== 'ready') {
        db.prepare("UPDATE media_jobs SET state='waiting', error=? WHERE id=?").run('生成请求是否受理尚未确认，未取得原任务编号；已暂停自动重发，请先核对原请求', id);
        return;
      }
      for (const key of ['image_url', 'first_frame_url', 'last_frame_url']) if (payload[key]) payload[key] = await upload(payload[key]);
      for (const key of ['reference_images', 'reference_image_urls', 'reference_video_urls', 'reference_audio_urls']) if (payload[key]) payload[key] = await Promise.all(payload[key].map(upload));
      // Commit the attempt before crossing the network boundary. A lost response
      // or process exit must not turn this same local job into another submit.
      const claimed = db.prepare("UPDATE media_jobs SET submission_state='attempted' WHERE id=? AND submission_state='ready' AND upstream_id IS NULL AND state NOT IN ('succeeded','failed')").run(id);
      if (claimed.changes !== 1) throw Object.assign(new Error('原媒体提交状态已变化，未发送新的生成请求'), { queryPending: true });
      upstream = (await bridgeRequest('/' + row.kind + '/submit', payload, 'moyin:' + id)).taskId;
      if (!upstream) throw new Error('平台未返回生成任务编号');
      db.prepare("UPDATE media_jobs SET upstream_id=?, state='running', error=NULL WHERE id=?").run(upstream, id);
    }
    let lastError = '';
    for (let attempt = 0; attempt < 180; attempt++) {
      let task;
      try { task = await bridgeRequest('/tasks/' + encodeURIComponent(upstream)); }
      catch (failure) { lastError = formatGenerationError(failure.message); db.prepare('UPDATE media_jobs SET error=? WHERE id=?').run(lastError, id); await new Promise(resolve => setTimeout(resolve, 10000)); continue; }
      if (task.status === 'failed' || task.status === 'cancelled') { db.prepare("UPDATE media_jobs SET state='failed', error=? WHERE id=?").run(formatGenerationError(task.error), id); return; }
      if (task.status === 'succeeded') {
        const output = task.outputs?.find(item => item.mimeType?.startsWith(row.kind + '/'));
        if (!output) throw Object.assign(new Error('平台尚未返回可读取的产物；原任务编号：' + upstream), { queryPending: true });
        const asset = output.assetId || referencedAsset(output.url);
        if (typeof asset !== 'string' || !/^[A-Za-z0-9_-]+$/.test(asset)) throw Object.assign(new Error('平台尚未返回受控资产编号；原任务编号：' + upstream), { queryPending: true });
        const response = await fetch(assetEndpoint(asset));
        if (!response.ok) throw Object.assign(new Error(`产物保存未完成（HTTP ${response.status}）；原任务编号：${upstream}`), { queryPending: true });
        for await (const chunk of response.body) { void chunk; }
        const result = { url: assetPath(asset), localPath: assetReference(asset), assetId: asset, assetUrl: output.url, mimeType: output.mimeType, taskId: upstream };
        db.prepare("UPDATE media_jobs SET state='succeeded', result=?, error=NULL WHERE id=?").run(JSON.stringify(result), id);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    db.prepare("UPDATE media_jobs SET state='waiting', error=? WHERE id=?").run(lastError || '查询达到上限，生成结果尚未确认；原任务编号：' + upstream, id);
  } catch (failure) {
    row = db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id);
    // Only the bridge's explicit pre-forward rejection proves no submission.
    // A status code, transport failure or a query error is never that proof.
    const submissionNotSent = failure.submitted === false
      && ['greenroom.submission_not_sent', 'greenroom.managed_route_not_found'].includes(failure.code);
    const unknownSubmission = !row.upstream_id && row.submission_state === 'attempted' && !submissionNotSent;
    const error = unknownSubmission ? '生成请求是否受理尚未确认，未取得原任务编号；已暂停自动重发。' + formatGenerationError(failure.message) : formatGenerationError(failure.message);
    db.prepare('UPDATE media_jobs SET state=?, error=? WHERE id=?').run(row.upstream_id || failure.queryPending || unknownSubmission ? 'waiting' : 'failed', error, id);
  } finally {
    mediaPending.delete(id);
    // Querying runs independently of the business queue. Once the original
    // media reaches a terminal state, resume only its recorded parent.
    const settled = db.prepare('SELECT parent_job_id,state FROM media_jobs WHERE id=?').get(id);
    if (settled?.parent_job_id && ['succeeded', 'failed'].includes(settled.state)) schedule(settled.parent_job_id);
    else if (settled?.parent_job_id && !pending.has(settled.parent_job_id)) {
      const error = db.prepare('SELECT error FROM media_jobs WHERE id=?').get(id)?.error || '原媒体任务查询暂未完成，请查看原任务';
      db.prepare("UPDATE jobs SET state='waiting',error=? WHERE id=? AND state='running'").run(error, settled.parent_job_id);
    }
  }
}
function requireOriginalMediaScope(row, scope) {
  if (scope) {
    const parent = db.prepare('SELECT operation,args,state FROM jobs WHERE id=?').get(scope.id);
    if (!scope.origin || !parent || parent.state !== 'running'
        || !queuedOperations.has(parent.operation)
        || parent.operation !== scope.origin.operation || parent.args !== scope.origin.args) {
      throw Object.assign(new Error('原业务上下文已变化，未创建或认领媒体任务'), { queryPending: true });
    }
    if (row && row.parent_job_id == null) {
      throw Object.assign(new Error('历史媒体缺少可信父任务关联，暂不能自动关联到本业务；原媒体记录和已有产物已保留，未重新提交。原媒体 ID：' + row.id), { queryPending: true });
    }
    if (row && row.parent_job_id !== scope.id) {
      throw Object.assign(new Error('同名媒体没有匹配的原业务出处；未认领或恢复'), { queryPending: true });
    }
  } else if (row?.parent_job_id != null) {
    throw Object.assign(new Error('该媒体属于原业务执行，不能通过独立媒体请求认领'), { queryPending: true });
  }
}
async function submitMedia(kind, options, id = randomUUID()) {
  if (!['image', 'video'].includes(kind)) throw new Error('不支持的媒体生成类别');
  const scope = jobScope.getStore();
  const existing = db.prepare('SELECT id,kind,state,upstream_id,parent_job_id FROM media_jobs WHERE id=?').get(id);
  if (existing) {
    if (existing.kind !== kind) throw new Error('原任务媒体类别不一致');
    requireOriginalMediaScope(existing, scope);
    // Resume the persisted request, not a new request under today's catalog.
    void runMedia(id);
    return { taskId: id, status: existing.state };
  }
  if (scope?.recoveryOnly) throw Object.assign(new Error('原业务恢复没有对应的持久媒体记录，未创建或提交新媒体。原媒体 ID：' + id), { queryPending: true });
  await refresh();
  const model = options.model || configuration.models[kind]?.[0];
  if (!configuration.models[kind]?.includes(model)) throw new Error('该生成模型未获得管理员授权');
  const roles = [...(options.image_with_roles || []), ...(options.uploadFiles || []).map(item => ({ url: item.dataUrl, role: item.role === 'first' || item.role === 'single' ? 'first_frame' : item.role === 'last' ? 'last_frame' : 'reference_image' }))];
  const ratio = options.aspectRatio || options.aspect_ratio || options.ratio || (/^\d+:\d+$/.test(options.size || '') ? options.size : undefined);
  const imageSize = /^\d+:\d+$/.test(options.size || '') ? options.resolution : options.size || options.resolution;
  const payload = { ...configuration.parameters[kind], model, prompt: options.prompt,
    ...(kind === 'image' ? { n: 1 } : {}),
    ...(ratio ? { aspect_ratio: ratio } : {}),
    ...(kind === 'image' && imageSize ? { size: imageSize } : {}),
    ...(kind === 'video' && options.resolution ? { resolution: options.resolution } : {}),
    ...(options.duration ? { duration: options.duration } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}), ...(options.quality !== undefined ? { quality: options.quality } : {}),
    ...(options.negativePrompt !== undefined || options.negative_prompt !== undefined ? { negative_prompt: options.negativePrompt ?? options.negative_prompt } : {}),
    ...(options.imageUrl || options.image_url ? { image_url: options.imageUrl || options.image_url } : {}),
    ...(options.generate_audio !== undefined ? { generate_audio: options.generate_audio } : {}),
    ...(options.reference_video_urls?.length ? { reference_video_urls: options.reference_video_urls } : {}),
    ...(options.reference_audio_urls?.length ? { reference_audio_urls: options.reference_audio_urls } : {}),
    ...(roles.find(item => item.role === 'last_frame') ? { last_frame_url: roles.find(item => item.role === 'last_frame').url } : {}),
    ...(roles.find(item => item.role === 'first_frame') ? { first_frame_url: roles.find(item => item.role === 'first_frame').url } : {}),
    ...(roles.some(item => item.role === 'reference_image') ? { [kind === 'image' ? 'reference_images' : 'reference_image_urls']: roles.filter(item => item.role === 'reference_image').map(item => item.url) } : {}),
    ...((options.referenceImages || options.reference_images || options.image_urls)?.length ? { [kind === 'image' ? 'reference_images' : 'reference_image_urls']: options.referenceImages || options.reference_images || options.image_urls } : {}) };
  const providerParams = Object.fromEntries(['quality', 'negative_prompt'].filter(key => payload[key] !== undefined).map(key => { const value = payload[key]; delete payload[key]; return [key, value]; }));
  if (Object.keys(providerParams).length) payload.providerParams = providerParams;
  if (kind === 'image') {
    const limit = imageReferenceLimit(model);
    const count = ['images', 'reference_images', 'reference_image_urls'].reduce((total, key) => total + (payload[key]?.length || 0), 0);
    if (limit !== null && count > limit) throw new Error(`当前模型最多接受 ${limit} 张参考图，已选择 ${count} 张；请调整选择，未截断或提交素材`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // Recheck after refresh awaits, under the same writer lock as first insertion.
    // A concurrent winner is never silently adopted, even with the same ID.
    if (db.prepare('SELECT id FROM media_jobs WHERE id=?').get(id)) {
      throw Object.assign(new Error('同名媒体已由另一请求写入，未覆盖或认领'), { queryPending: true });
    }
    requireOriginalMediaScope(null, scope);
    db.prepare("INSERT INTO media_jobs(id,kind,payload,state,submission_state,parent_job_id) VALUES(?,?,?,'pending','ready',?)")
      .run(id, kind, JSON.stringify(payload), scope ? scope.id : null);
    db.exec('COMMIT');
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
  void runMedia(id, true);
  return { taskId: id, status: 'pending' };
}
globalThis.greenroomGenerate = async (kind, options) => {
  const scope = jobScope.getStore();
  const id = scope ? scope.id + '-media-' + scope.next++ : randomUUID();
  await submitMedia(kind, options, id);
  if (scope?.recoveryOnly && mediaPending.has(id)) throw Object.assign(new Error('原媒体任务仍在查询，已保留原编号'), { queryPending: true, polling: true });
  while (mediaPending.has(id)) await new Promise(resolve => setTimeout(resolve, 250));
  const row = db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id);
  if (row.state !== 'succeeded') throw Object.assign(new Error(row.error || '生成结果尚未确认'), { queryPending: row.state !== 'failed' });
  return JSON.parse(row.result);
};
// Shot jobs never hydrate and rewrite an old native store on completion.
globalThis.greenroomShotSnapshot = () => shotWriteback.get(jobScope.getStore()?.id)?.snapshot || null;
globalThis.greenroomHasShotMedia = () => Boolean(db.prepare('SELECT id FROM media_jobs WHERE id=?').get(jobScope.getStore()?.id + '-media-0'));
function requireShotMedia(scope) {
  const id = scope?.id + '-media-0';
  const row = db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id);
  if (!scope || !row) throw Object.assign(new Error('原镜头媒体记录无法确认，未关联或重新提交'), { queryPending: true });
  requireOriginalMediaScope(row, scope);
  const operation = scope.origin.operation;
  const kind = operation === 'shot_image' ? 'image' : operation === 'shot_video' ? 'video' : null;
  const args = JSON.parse(scope.origin.args);
  const snapshot = shotWriteback.get(scope.id)?.snapshot;
  if (!kind || row.kind !== kind || (snapshot && (snapshot.kind !== kind
      || snapshot.projectId !== args.projectId
      || snapshot.shotId !== (args.shotId || args.shot?.id)))) {
    throw Object.assign(new Error('原镜头媒体类别或项目选择快照不匹配，产物保留但未回填'), { queryPending: true });
  }
  return row;
}
globalThis.greenroomApplyShotResult = output => {
  // Recheck at the synchronous write boundary, not just before an awaited query.
  const scope = jobScope.getStore();
  const row = requireShotMedia(scope);
  if (row.state !== 'succeeded' || JSON.parse(row.result || 'null')?.url !== output) {
    throw Object.assign(new Error('原镜头结果尚未确认或不匹配，未回填当前选择'), { queryPending: true });
  }
  return shotWriteback.apply(scope.id, output);
};
globalThis.greenroomRecoverShot = async () => {
  const scope = jobScope.getStore();
  const id = requireShotMedia(scope).id;
  // Do not hold the serial business queue while the original media is polled.
  // Its terminal transition will schedule this recorded parent again.
  if (mediaPending.has(id)) throw Object.assign(new Error('原镜头任务仍在查询，已保留原编号'), { queryPending: true, polling: true });
  let row = requireShotMedia(scope);
  if (row?.state === 'failed') throw new Error(row.error || '原生成任务已确认失败');
  if (!row || (!row.upstream_id && row.state !== 'succeeded' && row.submission_state !== 'ready')) throw Object.assign(new Error('原镜头任务缺少可恢复的原任务编号；未重新提交生成'), { queryPending: true });
  if (!['succeeded', 'failed'].includes(row.state)) void runMedia(id);
  if (mediaPending.has(id)) throw Object.assign(new Error('原镜头任务仍在查询，已保留原编号'), { queryPending: true, polling: true });
  row = requireShotMedia(scope);
  if (row.state !== 'succeeded') throw Object.assign(new Error(row.error || '原任务结果尚未确认'), { queryPending: row.state !== 'failed' });
  return JSON.parse(row.result);
};
globalThis.greenroomQuadResult = async (taskId, projectId) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(taskId);
  if (!row || row.operation !== 'split_quad_grid' || row.state !== 'succeeded' || JSON.parse(row.args).projectId !== projectId) throw new Error('请选择本项目已完成的四宫格切分任务');
  const result = JSON.parse(row.result);
  if (result.kind !== 'existing-quad-split' || result.images?.length !== 4) throw new Error('四宫格原结果不完整');
  for (const image of result.images) readLocal(image.localPath);
  return result;
};
globalThis.greenroomCatalog = configuration;
const worker = await import('./greenroom-worker.mjs');
worker.configure(configuration);
const queuedOperations = new Set(['import_script','parse_script','generate_episode_shots','calibrate_shots','calibrate_titles','episode_synopses','shot_image','shot_video','generate_image','generate_video','angle_switch','split_quad_grid','export_media','apply_quad_result']);
const cleanArgs = value => Array.isArray(value) ? value.map(cleanArgs) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !/api.?key|token|secret|authorization|base.?url|^settings$/i.test(key)).map(([key, item]) => [key, cleanArgs(item)])) : value;
function originalMediaFor(job) {
  return job && ['shot_image', 'shot_video', 'generate_image', 'generate_video', 'angle_switch'].includes(job.operation)
    ? db.prepare('SELECT * FROM media_jobs WHERE id=? AND parent_job_id=?').get(job.id + '-media-0', job.id) : null;
}
function schedule(id, recoveryOnly = true) {
  if (pending.has(id)) return;
  pending.add(id);
  queue = queue.catch(() => {}).then(async () => {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    const originalMedia = originalMediaFor(job);
    const recoverable = originalMedia && originalMedia.state !== 'failed';
    if (!job || job.state === 'succeeded' || (job.state === 'failed' && !recoverable)) { pending.delete(id); return; }
    if (!queuedOperations.has(job.operation)) {
      db.prepare('UPDATE jobs SET error=? WHERE id=?').run('原业务操作无法识别，已保留原任务，未执行恢复或重新提交', id);
      pending.delete(id);
      return;
    }
    // These native workflows may already have sent a text-model request. They
    // have no durable original response to replay after interruption.
    if (recoveryOnly && ['import_script', 'parse_script', 'generate_episode_shots', 'calibrate_shots', 'calibrate_titles', 'episode_synopses'].includes(job.operation)) {
      db.prepare("UPDATE jobs SET state='waiting', error=? WHERE id=?").run('原文本任务的受理和结果尚未确认，已保留原任务，未自动重新发送', id);
      pending.delete(id);
      return;
    }
    if (recoveryOnly && !['split_quad_grid', 'export_media'].includes(job.operation)
        && (!originalMedia || (!originalMedia.upstream_id && !['succeeded', 'failed'].includes(originalMedia.state)))) {
      // A legacy suffix can explain why recovery is blocked, but never links a task.
      const legacy = !originalMedia && db.prepare('SELECT id FROM media_jobs WHERE id=? AND parent_job_id IS NULL').get(id + '-media-0');
      const detail = legacy
        ? '历史媒体缺少可信父任务关联，已保留原任务和产物，未重新提交'
        : originalMedia?.error || '原业务缺少可查询的已受理任务，已保留原任务，未重新执行或提交';
      db.prepare("UPDATE jobs SET state='waiting', error=? WHERE id=?").run(detail, id);
      pending.delete(id);
      return;
    }
    let resumeTerminal = false;
    try {
      db.prepare("UPDATE jobs SET state='running', error=NULL WHERE id=?").run(id);
      // Only a new model operation needs today's catalog. Local operations and
      // recovery either consume saved inputs or refuse a missing submission.
      if (!recoveryOnly && !originalMedia && !['split_quad_grid', 'export_media', 'apply_quad_result'].includes(job.operation)) {
        await refresh(); globalThis.greenroomCatalog = configuration; worker.configure(configuration);
      }
      const result = await jobScope.run({ id, next: 0, recoveryOnly, origin: Object.freeze({ operation: job.operation, args: job.args }) }, () => worker.execute(job.operation, JSON.parse(job.args)));
      db.prepare("UPDATE jobs SET state='succeeded', result=?, error=NULL WHERE id=?").run(JSON.stringify(result ?? null), id);
    } catch (failure) {
      const media = originalMediaFor(job);
      const unresolvedMedia = media && media.state !== 'failed';
      const polling = failure.polling && media && mediaPending.has(media.id);
      resumeTerminal = Boolean(failure.polling && media && ['succeeded', 'failed'].includes(media.state));
      const state = polling || resumeTerminal ? 'running' : failure.queryPending || unresolvedMedia ? 'waiting' : 'failed';
      db.prepare('UPDATE jobs SET state=?, error=? WHERE id=?').run(state, formatGenerationError(polling ? failure.message : media?.error || failure.message), id);
    }
    finally { pending.delete(id); if (resumeTerminal) schedule(id); }
  });
}
function restore() {
  for (const row of db.prepare("SELECT id FROM media_jobs WHERE state IS NULL OR state NOT IN ('succeeded','failed')").all()) void runMedia(row.id);
  const jobs = db.prepare("SELECT DISTINCT j.id FROM jobs j LEFT JOIN media_jobs m ON m.parent_job_id=j.id WHERE j.state IS NULL OR j.state NOT IN ('succeeded','failed') OR (j.state='failed' AND j.operation IN ('shot_image','shot_video','generate_image','generate_video','angle_switch') AND m.id IS NOT NULL AND (m.state IS NULL OR m.state<>'failed'))").all();
  for (const job of jobs) schedule(job.id);
  return { restoring: jobs.length };
}
function markUnsentAtStartup() {
  // The send marker is committed before the provider call. A ready row and a
  // snapshotted shot with no media row are the only provably unsent cases.
  db.exec('BEGIN IMMEDIATE');
  try {
    const reason = '原任务在重启前尚未发送；已保留原记录，请明确新建任务';
    db.prepare("UPDATE media_jobs SET state='failed',error=? WHERE submission_state='ready' AND upstream_id IS NULL AND (state IS NULL OR state NOT IN ('succeeded','failed'))").run(reason);
    db.prepare("UPDATE jobs SET state='failed',error=? WHERE (state IS NULL OR state NOT IN ('succeeded','failed')) AND id IN (SELECT parent_job_id FROM media_jobs WHERE parent_job_id IS NOT NULL AND submission_state='ready' AND upstream_id IS NULL AND state='failed') AND NOT EXISTS (SELECT 1 FROM media_jobs m WHERE m.parent_job_id=jobs.id AND (m.submission_state IS NULL OR m.submission_state<>'ready' OR m.upstream_id IS NOT NULL))").run(reason);
    db.prepare("UPDATE jobs SET state='failed',error=? WHERE (state IS NULL OR state NOT IN ('succeeded','failed')) AND operation IN ('shot_image','shot_video') AND EXISTS (SELECT 1 FROM shot_selections s WHERE s.job_id=jobs.id) AND NOT EXISTS (SELECT 1 FROM media_jobs m WHERE m.parent_job_id=jobs.id OR m.id=jobs.id || '-media-0')").run(reason);
    db.exec('COMMIT');
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
}
async function json(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
function send(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
const taskError = row => ({ ...row, error: row.error ? formatGenerationError(row.error) : row.error });
async function ipc(channel, args) {
  const actions = { 'file-storage-get': 'getItem', 'file-storage-set': 'setItem', 'file-storage-remove': 'removeItem', 'file-storage-exists': 'exists', 'file-storage-list': 'listKeys', 'file-storage-list-dirs': 'listDirs', 'file-storage-remove-dir': 'removeDir' };
  if (actions[channel]) {
    if (/api.?config|providers|credentials/i.test(String(args[0]))) throw Object.assign(new Error('API 配置由管理员统一维护'), { status: 403 });
    return storage[actions[channel]](...args);
  }
  if (channel === 'save-image') return saveImage(args[0].url, args[0].category, args[0].filename);
  const imageActions = { 'get-image-path': 'getImagePath', 'delete-image': 'deleteImage', 'read-image-base64': 'readAsBase64', 'get-absolute-path': 'getImagePath' };
  if (imageActions[channel]) return globalThis.imageStorage[imageActions[channel]](...args);
  if (channel === 'image-host-upload') { const saved = await saveImage(args[0].imageData, 'uploads', args[0].name || 'image.png'); return { success: true, url: await upload(saved.localPath) }; }
  if (channel === 'storage-get-paths') return { basePath: '成员私有存储', dataPath: '成员私有存储/工程', imagePath: '成员私有存储/媒体', isCustom: false };
  throw Object.assign(new Error('该桌面系统设置由 Greenroom 托管'), { status: 403 });
}
let activeRequests = 0;
function lifecycleSnapshot() {
  try {
    // An unknown original operation cannot authorize recovery, even when other
    // tasks are runnable. Keep its exact media association without guessing.
    const unknownOperation = db.prepare("SELECT j.id FROM jobs j JOIN media_jobs m ON m.id=j.id || '-media-0' WHERE j.state='failed' AND j.operation IS NULL AND (m.state IS NULL OR m.state<>'failed') LIMIT 1").get();
    if (unknownOperation) return { known: false, busy: true, recover: false };
    if (activeRequests || pending.size || mediaPending.size) return { known: true, busy: true };
    // A polling loop ending is not a terminal task receipt. Include persisted
    // waiting/unknown work and completed media still awaiting shot writeback.
    const mediaWork = db.prepare("SELECT id FROM media_jobs WHERE state IS NULL OR state NOT IN ('succeeded','failed') LIMIT 1").get();
    const businessWork = db.prepare("SELECT j.id FROM jobs j LEFT JOIN media_jobs m ON m.parent_job_id=j.id WHERE j.state IS NULL OR j.state NOT IN ('succeeded','failed') OR (j.state='failed' AND (j.operation IS NULL OR j.operation IN ('shot_image','shot_video','generate_image','generate_video','angle_switch')) AND m.id IS NOT NULL AND (m.state IS NULL OR m.state<>'failed')) LIMIT 1").get();
    return { known: true, busy: Boolean(mediaWork || businessWork) };
  } catch {
    return { known: false, busy: true };
  }
}
createServer(async (req, res) => {
  if (req.url === '/api/greenroom/lifecycle') return send(res, lifecycleSnapshot());
  activeRequests++;
  try {
    const url = new URL(req.url, 'http://127.0.0.1:18803');
    const path = url.pathname.startsWith(base) ? '/' + url.pathname.slice(base.length) : url.pathname;
    if (path === '/health') return send(res, { status: 'ok', app: 'moyin' });
    if (path === '/api/greenroom/catalog') return send(res, await refresh());
    if (path === '/api/greenroom/ipc' && req.method === 'POST') { const body = await json(req); return send(res, await ipc(body.channel, body.args || [])); }
    if (path === '/api/greenroom/db' && req.method === 'POST') { const body = await json(req); if (!['get','set','remove','list','clear'].includes(body.operation)) throw new Error('未知存储操作'); if (/api.?config|providers|credentials/i.test(body.namespace)) throw Object.assign(new Error('API 配置由管理员统一维护'), { status: 403 }); return send(res, await globalThis.greenroomDb[body.operation](body.namespace, body.key, body.value)); }
    if (path === '/api/greenroom/files') {
      const directory = url.searchParams.get('directory') || 'media', key = url.searchParams.get('key') || '';
      const folder = inside(opfs, directory); mkdirSync(folder, { recursive: true });
      if (!key && req.method === 'GET') return send(res, db.prepare('SELECT key FROM files WHERE directory=?').all(directory).map(item => item.key));
      if (!key) throw new Error('媒体缺少编号');
      const file = inside(folder, key);
      if (req.method === 'PUT') { mkdirSync(dirname(file), { recursive: true }); const { pipeline } = await import('node:stream/promises'); const { createWriteStream } = await import('node:fs'); await pipeline(req, createWriteStream(file)); db.prepare('INSERT OR REPLACE INTO files VALUES(?,?,?,?)').run(directory, key, decodeURIComponent(req.headers['x-file-name'] || key), req.headers['content-type'] || 'application/octet-stream'); return send(res, { success: true }); }
      if (req.method === 'DELETE') { rmSync(file, { force: true }); db.prepare('DELETE FROM files WHERE directory=? AND key=?').run(directory, key); return send(res, { success: true }); }
      if (req.method !== 'GET') throw Object.assign(new Error('不支持的媒体操作'), { status: 405 });
      const record = db.prepare('SELECT * FROM files WHERE directory=? AND key=?').get(directory, key);
      if (!record || !existsSync(file)) throw Object.assign(new Error('媒体不存在'), { status: 404 });
      res.writeHead(200, { 'Content-Type': record.mime, 'X-File-Name': encodeURIComponent(record.name), 'Content-Length': statSync(file).size }); createReadStream(file).pipe(res); return;
    }
    if (path === '/api/greenroom/business' && req.method === 'POST') { const body = await json(req); if (!['projects','create_project','project','update_shot','update_character','update_scene','prepare_quad_grid'].includes(body.operation)) throw new Error('该操作须提交后台任务'); const result = queue.catch(() => {}).then(async () => { if (body.operation === 'prepare_quad_grid') { await refresh(); globalThis.greenroomCatalog = configuration; } return worker.execute(body.operation, cleanArgs(body.arguments || {})); }); queue = result.then(() => {}, () => {}); return send(res, await result); }
    if (path === '/api/greenroom/submit' && req.method === 'POST') { const body = await json(req); if (!queuedOperations.has(body.operation) || body.settings || body.arguments?.settings) throw Object.assign(new Error('不支持的业务任务'), { status: 403 }); const id = body.submissionId || randomUUID();
      const existing = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      const args = cleanArgs(body.arguments || {});
      if (existing && (existing.operation !== body.operation || !isDeepStrictEqual(JSON.parse(existing.args), args))) {
        throw Object.assign(new Error('原任务编号已绑定不同的操作或输入；原任务和产物已保留，请查看原任务或使用新编号明确发起新任务'), { status: 409 });
      }
      if (!existing) {
        const snapshot = shotWriteback.capture(body.operation, args);
        if (snapshot) {
          const unfinished = db.prepare("SELECT j.id,j.args FROM jobs j LEFT JOIN media_jobs m ON m.parent_job_id=j.id WHERE j.operation IN ('shot_image','shot_video') AND (j.state IS NULL OR j.state NOT IN ('succeeded','failed') OR m.state NOT IN ('succeeded','failed') OR (j.state='failed' AND m.state='succeeded'))").all().find(row => {
            const prior = JSON.parse(row.args);
            return prior.projectId === snapshot.projectId && (prior.shotId || prior.shot?.id) === snapshot.shotId;
          });
          if (unfinished) throw Object.assign(new Error('该分镜已有未完成的生成任务，请先查看或恢复原任务：' + unfinished.id), { status: 409 });
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare("INSERT INTO jobs VALUES(?,?,?,'pending',NULL,NULL)").run(id, body.operation, JSON.stringify(args));
          if (snapshot) shotWriteback.record(id, snapshot);
          db.exec('COMMIT');
        } catch (failure) { db.exec('ROLLBACK'); throw failure; }
      }
      schedule(id, Boolean(existing)); return send(res, { taskId: id, status: existing?.state || 'pending' }); }
    if (path === '/api/greenroom/tasks') return send(res, { jobs: db.prepare('SELECT * FROM jobs ORDER BY rowid DESC LIMIT 100').all().map(taskError), media: db.prepare('SELECT * FROM media_jobs ORDER BY rowid DESC LIMIT 100').all().map(({ payload, ...row }) => taskError(row)) });
    if (path.startsWith('/api/greenroom/tasks/')) { const id = decodeURIComponent(path.slice('/api/greenroom/tasks/'.length)); const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) || db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id); if (!row) throw Object.assign(new Error('任务不存在'), { status: 404 }); return send(res, { ...taskError(row), result: row.result ? JSON.parse(row.result) : null, args: undefined, payload: undefined }); }
    if (path === '/api/greenroom/restore' && req.method === 'POST') return send(res, restore());
    if (path === '/api/greenroom/media/submit' && req.method === 'POST') { const body = await json(req); return send(res, await submitMedia(body.kind, body.options, body.submissionId)); }
    if (path === '/greenroom/source') {
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="moyin-greenroom-source.tar.gz"' });
      const tar = spawn('tar', ['-cz', '--exclude=.git', '--exclude=node_modules', '--exclude=dist', '--exclude=.env', '--exclude=out', '-C', '/opt', 'moyin']); tar.stdout.pipe(res); res.on('close', () => tar.kill('SIGTERM')); return;
    }
    if (path.startsWith('/managed/v1/')) {
      const route = path.slice('/managed/v1'.length);
      if (route === '/models') return send(res, { data: Object.values(configuration.models).flat().map(id => ({ id })) });
      if (route === '/chat/completions' && req.method === 'POST') {
        await refresh(); const body = { ...configuration.parameters.llm, ...await json(req) }; if (!configuration.models.llm?.includes(body.model)) throw Object.assign(new Error('文本模型未授权'), { status: 403 });
        const upstream = await fetch(broker + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
        for await (const chunk of upstream.body) res.write(chunk); res.end(); return;
      }
      if (req.method === 'POST' && /images|videos|video\/generations/.test(route)) { const body = await json(req); const kind = /images/.test(route) ? 'image' : 'video'; const task = await submitMedia(kind, body); return send(res, { id: task.taskId, task_id: task.taskId, status: 'pending', data: [{ task_id: task.taskId }] }); }
      if (req.method === 'GET') { const id = route.split('/').at(-1); const row = db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id); if (!row) throw Object.assign(new Error('任务不存在'), { status: 404 }); const result = row.result ? JSON.parse(row.result) : null; return send(res, { id, task_id: id, status: row.state === 'succeeded' ? 'completed' : row.state === 'waiting' ? 'processing' : row.state, image_url: row.kind === 'image' ? result?.url : undefined, video_url: row.kind === 'video' ? result?.url : undefined, data: result ? [{ url: result.url }] : [], result: result ? { url: result.url } : undefined, error: taskError(row).error }); }
      throw Object.assign(new Error('托管模型接口不存在'), { status: 404 });
    }
    const asset = referencedAsset(base + path.slice(1));
    if (asset && path.startsWith('/media/asset-ref/') && ['GET', 'HEAD'].includes(req.method)) {
      const response = await fetch(assetEndpoint(asset), { headers: req.headers.range ? { Range: req.headers.range } : {} });
      const headers = Object.fromEntries(['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'].flatMap(key => response.headers.has(key) ? [[key, response.headers.get(key)]] : []));
      res.writeHead(response.status, headers);
      if (req.method === 'HEAD') { await response.body?.cancel(); res.end(); return; }
      const { pipeline } = await import('node:stream/promises');
      if (response.body) await pipeline(response.body, res);
      else res.end();
      return;
    }
    const file = path.startsWith('/media/') ? inside(media, decodeURIComponent(path.slice(7))) : inside(join(process.cwd(), 'dist'), path === '/' ? 'index.html' : decodeURIComponent(path.slice(1)));
    if (!existsSync(file) || !statSync(file).isFile()) throw Object.assign(new Error('文件不存在'), { status: 404 });
    const size = statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) { const start = Number(range[1]), end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1); if (start > end) { res.writeHead(416).end(); return; } res.writeHead(206, { 'Content-Type': mime(file), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end-start+1, 'Accept-Ranges': 'bytes' }); createReadStream(file, { start, end }).pipe(res); }
    else { res.writeHead(200, { 'Content-Type': mime(file), 'Content-Length': size, 'Accept-Ranges': 'bytes' }); createReadStream(file).pipe(res); }
  } catch (failure) {
    if (res.headersSent) res.destroy();
    else send(res, { error: formatGenerationError(failure.message), status: failure.status || 500 }, failure.status || 500);
  }
  finally { activeRequests--; }
}).listen(18803, '0.0.0.0');
markUnsentAtStartup();
restore();
