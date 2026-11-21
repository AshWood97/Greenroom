const fs = require('node:fs');
const path = require('node:path');
const { formatGenerationError } = require('./greenroom-generation-error.ts');

const managed = process.env.GREENROOM_MANAGED_URL || 'http://127.0.0.1:18767/managed';
const root = path.resolve(process.env.GREENROOM_PLUGIN_ROOT);
const basePath = process.env.GREENROOM_BASE_PATH || '/plugins/localminidrama/';
let catalog = JSON.parse(process.env.GREENROOM_MODELS || '{"llm":[],"image":[],"video":[]}');

let settings = JSON.parse(process.env.GREENROOM_SETTINGS || '{}');
async function refresh(db, log) { catalog = await request('/models'); settings = await request('/plugins/localminidrama/settings'); seed(db, log); }

async function request(route, body, submission) {
  const response = await fetch(managed + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(submission ? { 'X-T8-Provider-Submission': submission } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok || result.success === false) throw Object.assign(new Error(formatGenerationError({ ...result, httpStatus: response.status })), { status: response.status });
  return result.data ?? result;
}

function models(type) {
  return (settings.models?.[type] ?? catalog[type] ?? []).map(item => typeof item === 'string' ? item : item.id || item.model).filter(Boolean);
}

function seed(db, log) {
  require('./greenroom-final-archive.cjs').seed(db);
  db.exec(`CREATE TABLE IF NOT EXISTS greenroom_tasks (
    owner TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
    task_id TEXT, error TEXT, updated_at TEXT NOT NULL
  )`);
  const service = require('./src/services/aiConfigService');
  for (const [service_type, type] of [['text', 'llm'], ['image', 'image'], ['storyboard_image', 'image'], ['video', 'video']]) {
    const available = models(type);
    const row = db.prepare('SELECT id FROM ai_service_configs WHERE service_type = ? AND deleted_at IS NULL').get(service_type);
    const config = { service_type, provider: 'openai', name: 'Greenroom 托管', api_protocol: 'openai',
      base_url: managed, api_key: 'greenroom-managed', model: available, default_model: available[0] || '',
      endpoint: '/chat/completions', is_default: true, is_active: available.length > 0, priority: 100 };
    if (row) service.updateConfig(db, log, row.id, config);
    else service.createConfig(db, log, config);
    db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE service_type = ? AND id != ? AND deleted_at IS NULL')
      .run(new Date().toISOString(), service_type, row?.id || db.prepare('SELECT id FROM ai_service_configs WHERE service_type = ? AND deleted_at IS NULL').get(service_type).id);
  }
}

async function reference(value) {
  if (!value) return undefined;
  if (/^data:|^https?:/i.test(value)) return value;
  if (value.startsWith('/api/media/')) return value;
  const member = fs.realpathSync(root);
  const storage = fs.realpathSync(path.join(member, 'storage'));
  if (!storage.startsWith(member + path.sep)) throw new Error('素材路径超出成员目录');
  const relative = (value.startsWith(basePath) ? value.slice(basePath.length) : value).replace(/^\/?static\//, '');
  const candidate = path.resolve(storage, relative);
  if (!candidate.startsWith(storage + path.sep)) throw new Error('素材路径超出成员目录');
  const filename = fs.realpathSync(candidate);
  if (!filename.startsWith(storage + path.sep)) throw new Error('素材路径超出成员目录');
  const extension = path.extname(filename).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' }[extension] || 'application/octet-stream';
  const response = await fetch(managed + '/media/uploads', { method: 'POST', body: await fs.promises.readFile(filename),
    headers: { 'Content-Type': mime, 'X-File-Name': encodeURIComponent(path.basename(filename)), 'X-Asset-Type': mime.split('/')[0] }, signal: AbortSignal.timeout(120_000) });
  const result = await response.json();
  if (!response.ok || result.success === false) throw new Error(formatGenerationError({ ...result, httpStatus: response.status }));
  return (result.data ?? result).fileUrl;
}

function outputUrl(task, kind) {
  const output = task.outputs?.find(item => item.mimeType?.startsWith(kind + '/'));
  if (!output?.url) throw new Error('平台未返回可读取的生成产物');
  const id = output.assetId || output.url.match(/\/media\/([^/?#]+)$/)?.[1];
  if (!id) throw new Error('平台产物缺少受控资产编号');
  return managed + '/media/' + encodeURIComponent(id);
}

async function submit(db, kind, opts, recordId) {
  if (!recordId) throw new Error('生成缺少持久业务编号');
  const owner = `${kind}:${recordId}`;
  let row = db.prepare('SELECT * FROM greenroom_tasks WHERE owner = ?').get(owner);
  if (!row) {
    await refresh(db, console);
    const selected = opts.model || models(kind)[0];
    if (!models(kind).includes(selected)) throw new Error('该生成模型未获得管理员授权');
    const payload = { ...settings.parameters?.[kind], model: selected, prompt: opts.prompt,
      ...(opts.size && !/^\d+:\d+$/.test(opts.size) ? { size: opts.size } : {}), ...(opts.aspect_ratio || /^\d+:\d+$/.test(opts.size || '') ? { aspect_ratio: opts.aspect_ratio || opts.size } : {}),
      ...(opts.resolution ? { resolution: opts.resolution } : {}), ...(opts.duration ? { duration: opts.duration } : {}),
      ...(opts.seed != null ? { seed: opts.seed } : {}), ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts.negative_prompt !== undefined ? { negative_prompt: opts.negative_prompt } : {}) };
    const providerParams = Object.fromEntries(['quality', 'negative_prompt'].filter(key => payload[key] !== undefined).map(key => { const value = payload[key]; delete payload[key]; return [key, value]; }));
    if (Object.keys(providerParams).length) payload.providerParams = providerParams;
    if (kind === 'image') payload.n = 1;
    for (const field of ['image_url', 'first_frame_url', 'last_frame_url']) if (opts[field]) payload[field] = await reference(opts[field]);
    const refs = opts.reference_image_urls || opts.reference_urls;
    if (refs?.length) payload[kind === 'image' ? 'reference_images' : 'reference_image_urls'] = await Promise.all(refs.map(reference));
    db.prepare('INSERT INTO greenroom_tasks(owner,kind,payload,updated_at) VALUES(?,?,?,?)')
      .run(owner, kind, JSON.stringify(payload), new Date().toISOString());
    row = db.prepare('SELECT * FROM greenroom_tasks WHERE owner = ?').get(owner);
  }
  if (!row.task_id) {
    const task = await request(`/${kind}/submit`, JSON.parse(row.payload), `localminidrama:${owner}`);
    if (!task.taskId) throw new Error('平台未返回生成任务编号');
    db.prepare('UPDATE greenroom_tasks SET task_id = ?, error = NULL, updated_at = ? WHERE owner = ?').run(task.taskId, new Date().toISOString(), owner);
    row.task_id = task.taskId;
  }
  return row.task_id;
}

async function poll(db, taskId, kind, attempts, interval) {
  let lastError = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const task = await request('/tasks/' + encodeURIComponent(taskId));
      if (task.status === 'succeeded') return { [kind + '_url']: outputUrl(task, kind) };
      if (task.status === 'failed' || task.status === 'cancelled') return { error: formatGenerationError(task.error || (task.status === 'cancelled' ? '生成任务已取消' : '')), terminal: true };
    } catch (error) {
      lastError = formatGenerationError(error.message);
      db.prepare('UPDATE greenroom_tasks SET error = ?, updated_at = ? WHERE task_id = ?').run(lastError, new Date().toISOString(), taskId);
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return { error: lastError || '查询达到上限，生成结果尚未确认；原任务编号：' + taskId, query_incomplete: true };
}

async function image(db, log, opts) {
  try {
    const taskId = await submit(db, 'image', opts, opts.image_gen_id);
    return await poll(db, taskId, 'image', 180, 10_000);
  } catch (error) { return { error: formatGenerationError(error.message) }; }
}

async function video(db, log, opts) {
  try { return { task_id: await submit(db, 'video', opts, opts.video_gen_id) }; }
  catch (error) { return { error: formatGenerationError(error.message) }; }
}

// Normal generation and lifecycle restore share one worker per original image ID.
const imageWorkers = new Map();
function runImageWorker(id, run) {
  const key = String(id);
  if (imageWorkers.has(key)) return imageWorkers.get(key);
  let resolve, reject;
  const work = new Promise((yes, no) => { resolve = yes; reject = no; });
  imageWorkers.set(key, work);
  const clear = () => { if (imageWorkers.get(key) === work) imageWorkers.delete(key); };
  work.then(clear, clear);
  try { resolve(run()); } catch (error) { reject(error); }
  return work;
}
function observeImageWorker(work, log, id) {
  void Promise.resolve(work).catch(error => {
    log.error('[Greenroom] 图片后台处理异常', { id, reason: formatGenerationError(error?.message || '') });
  });
}
const recovering = new Set();
function restore(db, log) {
  require('./greenroom-final-archive.cjs').restore(db, log);
  const imageService = require('./src/services/imageService');
  for (const row of db.prepare("SELECT id FROM image_generations WHERE status IN ('pending','processing') AND deleted_at IS NULL").all()) {
    const key = String(row.id);
    if (recovering.has(key) || imageWorkers.has(key)) continue;
    recovering.add(key);
    try {
      db.prepare("UPDATE image_generations SET status = 'pending' WHERE id = ?").run(row.id);
      const work = imageService.processImageGeneration(db, log, row.id);
      Promise.resolve(work).then(() => recovering.delete(key), () => recovering.delete(key));
      observeImageWorker(work, log, row.id);
    } catch (error) { recovering.delete(key); throw error; }
  }
  require('./src/services/videoService').resumeProcessingVideoGenerations(db, log);
  return { success: true, data: { restoring: recovering.size } };
}

function install(app, db, log) {
  let activeRequests = 0;
  app.get('/api/greenroom/lifecycle', (req, res) => res.json({ known: true, busy: Boolean(activeRequests || recovering.size || imageWorkers.size || require('./greenroom-final-archive.cjs').busy()) }));
  app.use((req, res, next) => {
    activeRequests++;
    res.once('finish', () => { activeRequests--; });
    next();
  });
  app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/v1/ai-configs')) return res.status(403).json({ success: false, error: { message: '模型服务由 Greenroom 管理员统一配置' } });
    try {
      if (req.method === 'POST' && req.path.startsWith('/api/v1/')) { await refresh(db, log); }
      next();
    } catch (failure) { next(failure); }
  });
  app.get('/api/v1/greenroom/models', async (req, res, next) => {
    try { await refresh(db, log); const type = req.query.service_type; const rows = db.prepare('SELECT id, service_type, provider, name, model, default_model, is_default, is_active FROM ai_service_configs WHERE deleted_at IS NULL').all(); res.json({ success: true, data: rows.filter(row => !type || row.service_type === type).map(row => ({ ...row, model: JSON.parse(row.model || '[]') })) }); }
    catch (failure) { next(failure); }
  });
  app.get('/api/v1/greenroom/vendor-lock', (req, res) => res.json({ success: true, data: { enabled: false } }));
  app.post('/api/greenroom/restore', (req, res) => res.json(restore(db, log)));
  // Returning local paths with the mount prefix keeps downloads in this member's authenticated UI route.
  app.use((req, res, next) => {
    const original = res.json.bind(res);
    res.json = value => original(JSON.parse(JSON.stringify(value, (key, item) =>
      typeof item === 'string' && item.startsWith('/static/') ? basePath.replace(/\/$/, '') + item : item)));
    next();
  });
}

module.exports = { seed, install, restore, image, video, runImageWorker, observeImageWorker,
  parameters: async (db, log, kind) => { await refresh(db, log); return settings.parameters?.[kind] || {}; },
  poll: (db, log, videoGenId, taskId, config, attempts = 300, interval = 10000) => poll(db, taskId, 'video', attempts, interval) };
