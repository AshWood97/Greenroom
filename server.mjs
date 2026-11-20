import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { plugins } from './lib/catalog.mjs';
import { bearerMatches, bridgeKey } from './lib/credentials.mjs';
import { createHarness } from './lib/harness.mjs';
import { handleMcp } from './lib/mcp.mjs';

const port = Number(process.env.GREENROOM_PORT ?? 3210);
const data = resolve(process.env.GREENROOM_DATA ?? '.greenroom');
mkdirSync(data, { recursive: true, mode: 0o700 });
const keyFile = join(data, 'key');
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
const encryptionKey = readFileSync(keyFile);
const dbPath = join(data, 'workspace.sqlite');
const db = new DatabaseSync(dbPath);
chmodSync(dbPath, 0o600);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
    protocol TEXT NOT NULL, scope TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL, model TEXT NOT NULL, provider_id TEXT NOT NULL, provider_name TEXT NOT NULL,
    prompt TEXT NOT NULL, status TEXT NOT NULL, content TEXT, mime TEXT, media BLOB, error TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plugin_settings (id TEXT PRIMARY KEY, url TEXT, bindings TEXT NOT NULL);
`);
if (!db.prepare('PRAGMA table_info(plugin_settings)').all().some(column => column.name === 'mcp_url')) {
  db.exec('ALTER TABLE plugin_settings ADD COLUMN mcp_url TEXT');
}
const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
for (const column of ['provider_snapshot', 'upstream_id', 'query_error']) {
  if (!taskColumns.has(column)) db.exec('ALTER TABLE tasks ADD COLUMN ' + column + ' TEXT');
}
db.exec(`UPDATE tasks SET status = 'interrupted', error = '本机服务在等待模型时停止。请先核对服务商用量。'
  WHERE status = 'running' AND upstream_id IS NULL`);

const modalities = ['text', 'image', 'audio'];
const protocols = ['responses', 'completions'];
const localHosts = ['localhost', '127.0.0.1', '[::1]'];
const pluginById = new Map(plugins.map(entry => [entry.id, entry]));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
function decrypt(value) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
async function input(req, limit = 100_000) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, '请提交 JSON。');
  }
  let length = 0;
  const parts = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new HttpError(413, '输入太长。');
    parts.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(parts));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new HttpError(400, 'JSON 格式无效。');
}
function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new HttpError(422, `${label}需填写，长度应在 1 到 ${max} 字符之间。`);
  }
  return value.trim();
}
function providerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(422, '网关地址无效。'); }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && localHosts.includes(url.hostname));
  if (!allowed || url.username || url.password || url.search || url.hash) {
    throw new HttpError(422, '请填写 HTTPS 网关地址。本机模型服务也可以使用 HTTP。');
  }
  return url.href.replace(/\/+$/, '');
}
function provider(id) {
  const value = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
  if (!value) throw new HttpError(404, '供应商不存在。');
  return { ...value, scope: JSON.parse(value.scope) };
}
function plugin(id) {
  const entry = pluginById.get(id);
  if (!entry) throw new HttpError(404, '找不到插件。');
  const settings = db.prepare('SELECT url, bindings, mcp_url FROM plugin_settings WHERE id=?').get(id);
  return { ...entry, url: settings?.url ?? null, mcpUrl: settings?.mcp_url ?? null, bindings: JSON.parse(settings?.bindings ?? '{}') };
}
function savePlugin(id, body) {
  const entry = plugin(id);
  const bindings = {};
  if (!body.bindings || typeof body.bindings !== 'object' || Array.isArray(body.bindings)
      || Object.keys(body.bindings).some(kind => !modalities.includes(kind))) {
    throw new HttpError(422, '插件供应商配置无效。');
  }
  for (const kind of modalities) {
    const providerId = body.bindings[kind];
    if (!providerId) continue;
    if (!provider(providerId).scope.includes(kind)) {
      throw new HttpError(422, '供应商没有启用这个用途。');
    }
    bindings[kind] = providerId;
  }
  function optionalUrl(value, label) {
    if (!value || entry.mode === 'native') return null;
    const url = providerUrl(field(value, label, 1000));
    if (!localHosts.includes(new URL(url).hostname)) throw new HttpError(422, '插件需在本机运行。');
    return url;
  }
  db.prepare(`INSERT INTO plugin_settings (id,url,bindings,mcp_url) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, bindings=excluded.bindings, mcp_url=excluded.mcp_url`)
    .run(id, optionalUrl(body.url, '插件地址'), JSON.stringify(bindings), optionalUrl(body.mcpUrl, 'MCP 地址'));
  return plugin(id);
}
function selectProvider(kind, pluginId, choice) {
  const bound = pluginId ? plugin(pluginId).bindings[kind] : undefined;
  if (bound && choice && bound !== choice) throw new HttpError(403, '该用途已绑定供应商。');
  const id = bound || choice || db.prepare("SELECT value FROM preferences WHERE key='default'").get()?.value;
  if (!id) throw new HttpError(422, '请先配置供应商。');
  const selected = provider(id);
  if (!selected.scope.includes(kind)) throw new HttpError(403, '此供应商未启用这个用途。');
  return selected;
}
function project(id) {
  const value = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!value) throw new HttpError(404, '项目不存在。');
  return value;
}
function saveProvider(body, id) {
  const old = id ? provider(id) : null;
  const name = field(body.name, '供应商名称', 100);
  const url = providerUrl(field(body.url, '网关地址', 1000));
  const protocol = body.protocol;
  const scope = body.scope;
  if (!protocols.includes(protocol)) throw new HttpError(422, '文字协议无效。');
  if (!Array.isArray(scope) || !scope.length || scope.some(kind => !modalities.includes(kind))) {
    throw new HttpError(422, '至少选择一种用途。');
  }
  const secret = body.key ? encrypt(field(body.key, 'API Key', 4096)) : old?.secret;
  if (!secret) throw new HttpError(422, '需要填写 API Key。');
  if (old && !body.key && old.url !== url) {
    throw new HttpError(422, '网关地址变更时请填写该地址对应的 API Key。');
  }
  id ??= randomUUID();
  db.prepare(`INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, secret=excluded.secret,
      protocol=excluded.protocol, scope=excluded.scope`).run(id, name, url, secret, protocol, JSON.stringify([...new Set(scope)]));
  if (body.default === true || !db.prepare("SELECT value FROM preferences WHERE key = 'default'").get()) {
    db.prepare("INSERT INTO preferences VALUES ('default', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
  }
  return id;
}
function category(model) {
  const id = model.toLowerCase();
  if (/embed/.test(id)) return 'embedding';
  if (/moderat/.test(id)) return 'moderation';
  if (/transcri|whisper|(?:^|[-/])tts|audio|realtime|speech/.test(id)) return 'audio';
  if (/image|dall-e|flux|stable-diffusion/.test(id)) return 'image';
  if (/sora|video|veo|kling/.test(id)) return 'video';
  if (/gpt|claude|gemini|deepseek|qwen|mistral|llama|^o[1-9]/.test(id)) return 'text';
  return 'other';
}
class UpstreamUnconfirmed extends HttpError {
  constructor(message) { super(502, message); }
}
async function requestModel(selected, path, body) {
  const key = decrypt(selected.secret);
  let response;
  try {
    response = await fetch(selected.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(body === undefined ? 15_000 : 150_000),
    });
  } catch {
    throw new UpstreamUnconfirmed('未收到网关响应，请核对地址、网络或服务商的任务记录。');
  }
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    const raw = details?.error?.message;
    const reason = typeof raw === 'string'
      ? raw.replaceAll(key, '[已隐藏]').replace(/(?:https?:\/\/|[A-Za-z0-9_+\/-]{50,})\S*/g, '[已隐藏]').slice(0, 260)
      : '';
    const message = `网关返回 HTTP ${response.status}${reason ? ' · ' + reason : ''}`;
    if (response.status >= 500) throw new UpstreamUnconfirmed(message);
    throw new HttpError(response.status, message);
  }
  return response;
}
async function modelCatalog(selected) {
  const response = await requestModel(selected, '/models');
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new HttpError(502, '网关返回的模型目录格式无效。');
  const ids = [...new Set(data.data.map(row => row?.id).filter(id => typeof id === 'string' && id))].sort();
  return ids.map(id => ({ id, kind: category(id) }));
}
async function generate(selected, kind, model, prompt, options) {
  if (kind === 'text') {
    const viaResponses = selected.protocol === 'responses';
    const body = viaResponses ? { model, input: prompt, store: false } : { model, messages: [{ role: 'user', content: prompt }] };
    if (options.effort) {
      if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)) {
        throw new HttpError(422, '推理等级无效。');
      }
      if (viaResponses) body.reasoning = { effort: options.effort };
      else body.reasoning_effort = options.effort;
    }
    if (viaResponses && options.background === true) Object.assign(body, { background: true, store: true });
    const response = await requestModel(selected, viaResponses ? '/responses' : '/chat/completions', body);
    const payload = await response.json();
    if (viaResponses) return responseTask(payload);
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, '模型未返回文字。');
    return { content };
  }
  if (kind === 'image') {
    const size = options.size ?? '1024x1024';
    const quality = options.quality ?? 'low';
    if (!['1024x1024', '1536x1024', '1024x1536'].includes(size)
        || !['low', 'medium', 'high', 'auto'].includes(quality)) throw new HttpError(422, '图片参数无效。');
    const response = await requestModel(selected, '/images/generations', { model, prompt, size, quality, n: 1 });
    const bytes = Buffer.from((await response.json()).data?.[0]?.b64_json ?? '', 'base64');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!png) throw new HttpError(502, '网关未返回内嵌的 PNG 图片。');
    return { content: null, mime: 'image/png', bytes };
  }
  const voice = field(options.voice || 'alloy', '音色', 80);
  const response = await requestModel(selected, '/audio/speech', { model, input: prompt, voice, response_format: 'mp3' });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || !/^audio\/(mpeg|mp3)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new HttpError(502, '网关未返回 MP3 音频。');
  }
  return { content: null, mime: 'audio/mpeg', bytes };
}

function responseTask(payload) {
  if (['queued', 'in_progress'].includes(payload.status)) {
    if (typeof payload.id !== 'string' || !/^[a-zA-Z0-9_:-]{1,200}$/.test(payload.id)) {
      throw new UpstreamUnconfirmed('服务商尚未提供可查询的原任务编号。');
    }
    return { pending: payload.id };
  }
  if (['failed', 'cancelled', 'incomplete'].includes(payload.status)) {
    return { error: '服务商返回终态：' + payload.status };
  }
  const content = payload.output?.flatMap(row => row.content ?? [])
    .filter(row => row.type === 'output_text').map(row => row.text).join('');
  if (!content) throw new HttpError(502, '模型未返回文字。');
  return { content };
}
const taskFields = 'id,kind,model,provider_name,prompt,status,content,mime,error,query_error,upstream_id,created_at';
function tasks(projectId) {
  project(projectId);
  return db.prepare(`SELECT ${taskFields} FROM tasks WHERE project_id=? ORDER BY created_at DESC`).all(projectId);
}
const readTask = id => db.prepare(`SELECT ${taskFields} FROM tasks WHERE id=?`).get(id);
function recordTask(id, result) {
  if (result.pending) {
    db.prepare("UPDATE tasks SET upstream_id=?, query_error=NULL WHERE id=? AND status='running'").run(result.pending, id);
  } else {
    db.prepare(`UPDATE tasks SET status=?, content=?, mime=?, media=?, error=?, query_error=NULL,
      provider_snapshot=NULL WHERE id=? AND status='running'`)
      .run(result.error ? 'failed' : 'done', result.content ?? null, result.mime ?? null,
        result.bytes ?? null, result.error ?? null, id);
  }
}
async function createTask(projectId, body, pluginId) {
  project(projectId);
  if (!modalities.includes(body.kind)) throw new HttpError(422, '工具类型无效。');
  const model = field(body.model, '模型', 200);
  const prompt = field(body.prompt, '创作内容', 12_000);
  const selected = selectProvider(body.kind, pluginId, body.providerId);
  const id = randomUUID();
  db.prepare(`INSERT INTO tasks (id,project_id,kind,model,provider_id,provider_name,prompt,status,created_at,provider_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
    .run(id, projectId, body.kind, model, selected.id, selected.name, prompt,
      new Date().toISOString(), encrypt(JSON.stringify({ url:selected.url, secret:selected.secret })));
  try {
    recordTask(id, await generate(selected, body.kind, model, prompt, body.options ?? {}));
  } catch (error) {
    const message = error instanceof HttpError ? error.message : '未能读取模型返回的结果。';
    db.prepare('UPDATE tasks SET status=?, error=?, provider_snapshot=NULL WHERE id=?')
      .run(error instanceof UpstreamUnconfirmed ? 'interrupted' : 'failed', message, id);
  }
  return readTask(id);
}
const polling = new Map();
async function pollTask(id) {
  const row = db.prepare('SELECT status,upstream_id,provider_snapshot FROM tasks WHERE id=?').get(id);
  if (!row) throw new HttpError(404, '找不到任务。');
  if (row.status !== 'running' || !row.upstream_id) return readTask(id);
  if (!polling.has(id)) {
    const operation = (async () => {
      try {
        const selected = JSON.parse(decrypt(row.provider_snapshot));
        const response = await requestModel(selected, '/responses/' + encodeURIComponent(row.upstream_id));
        const outcome = responseTask(await response.json());
        if (outcome.pending && outcome.pending !== row.upstream_id) throw new HttpError(502, '服务商返回了不同的任务编号。');
        recordTask(id, outcome);
      } catch (error) {
        db.prepare("UPDATE tasks SET query_error=? WHERE id=? AND status='running'")
          .run(error instanceof HttpError ? error.message : '原任务状态暂时无法读取。', id);
      }
      return readTask(id);
    })().finally(() => polling.delete(id));
    polling.set(id, operation);
  }
  return polling.get(id);
}
const bridgeRoutes = new Map([
  ['/responses','text'], ['/chat/completions','text'], ['/images/generations','image'], ['/audio/speech','audio'],
]);
const pluginKey = id => bridgeKey(encryptionKey, id);
async function modelRelay(req, res, id, path) {
  plugin(id);
  if (!bearerMatches(req.headers.authorization, pluginKey(id))) throw new HttpError(401, '插件凭据无效。');
  if (req.method === 'GET' && path === '/models') {
    const catalogs = await Promise.allSettled(modalities.map(async kind => {
      const selected = selectProvider(kind, id);
      return (await modelCatalog(selected)).filter(model => model.kind === kind || model.kind === 'other');
    }));
    const valid = catalogs.filter(result => result.status === 'fulfilled');
    if (!valid.length) throw catalogs[0].reason;
    const ids = [...new Set(valid.flatMap(result => result.value.map(model => model.id)))];
    return json(res, 200, { object:'list', data:ids.map(model => ({ id:model, object:'model', owned_by:'greenroom' })) });
  }
  const kind = bridgeRoutes.get(path);
  if (req.method !== 'POST' || !kind) throw new HttpError(404, '该模型接口未开放。');
  const selected = selectProvider(kind, id);
  const body = await input(req, 32 * 1024 * 1024);
  field(body.model, '模型', 200);
  if (path === '/responses' && body.background) {
    throw new HttpError(422, '请通过 Greenroom 项目提交后台任务，以保留原供应商记录。');
  }
  if (path === '/images/generations' && body.model === 'gpt-image-2.6-flare') {
    body.size ??= '1024x1024';
    body.quality ??= 'low';
    body.n ??= 1;
  }
  if (path === '/chat/completions' && new URL(selected.url).origin === 'https://api.openai.com') {
    delete body.thinking;
    delete body.enable_thinking;
    if (body.model === 'gpt-6-luna' && body.max_tokens !== undefined) {
      body.max_completion_tokens ??= body.max_tokens;
      delete body.max_tokens;
    }
  }
  const response = await requestModel(selected, path, body);
  res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json',
    ...(response.headers.has('x-request-id') ? { 'X-Request-ID':response.headers.get('x-request-id') } : {}) });
  if (response.body) await pipeline(Readable.fromWeb(response.body), res);
  else res.end();
}

const harness = createHarness({ data, port, token:pluginKey('dsh'),
  pluginServers:() => db.prepare('SELECT id, mcp_url FROM plugin_settings WHERE mcp_url IS NOT NULL').all(),
  modelProfile:async () => {
  try {
    const selected = selectProvider('text', 'dsh');
    const models = (await modelCatalog(selected)).filter(model => model.kind === 'text' || model.kind === 'other');
    return { protocol:selected.protocol, models };
  } catch (error) {
    return { issue:error instanceof HttpError ? error.message : '模型目录暂不可用。' };
  }
} });
const mcpServices = { tasks, createTask, pollTask, plugins:() => plugins.map(entry => plugin(entry.id)),
  projects:() => db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() };

async function serve(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  const host = req.headers.host ?? '';
  if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host)
      || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    throw new HttpError(403, '请从本机入口访问。');
  }
  const path = new URL(req.url, `http://${host}`).pathname;
  const method = req.method;
  if (method === 'GET' && assets.has(path)) {
    const [file, contentType] = assets.get(path);
    res.writeHead(200, { 'Content-Type': contentType });
    return res.end(readFileSync(new URL('./public/' + file, import.meta.url)));
  }
  const bridge = path.match(/^\/gateway\/([a-z0-9-]+)\/v1(\/[^?#]+)$/);
  if (bridge) return modelRelay(req, res, bridge[1], bridge[2]);
  if (path === '/mcp') {
    if (!bearerMatches(req.headers.authorization, pluginKey('dsh'))) throw new HttpError(401, 'MCP 凭据无效。');
    return handleMcp(req, res, req.method === 'POST' ? await input(req) : undefined, mcpServices);
  }
  if (path === '/api/plugins' && method === 'GET') return json(res, 200, mcpServices.plugins());
  const edit = path.match(/^\/api\/plugins\/([a-z0-9-]+)$/);
  if (edit && method === 'PUT') return json(res, 200, savePlugin(edit[1], await input(req)));
  if (path === '/api/harness' && method === 'GET') return json(res, 200, harness.status());
  if (path === '/api/harness' && method === 'POST') {
    const { restart } = await input(req);
    return json(res, 200, await harness.start(restart === true));
  }
  if (path === '/api/providers') {
    if (method === 'GET') {
      const rows = db.prepare('SELECT id,name,url,protocol,scope FROM providers ORDER BY name').all();
      const defaultId = db.prepare("SELECT value FROM preferences WHERE key = 'default'").get()?.value ?? null;
      return json(res, 200, { defaultId, providers: rows.map(row => ({ ...row, scope: JSON.parse(row.scope) })) });
    }
    if (method === 'POST') return json(res, 201, { id: saveProvider(await input(req)) });
  }
  const matchProvider = path.match(/^\/api\/providers\/([a-f0-9-]+)(\/models)?$/);
  if (matchProvider) {
    const [, id, models] = matchProvider;
    if (method === 'PUT' && !models) return json(res, 200, { id: saveProvider(await input(req), id) });
    if (method === 'GET' && models) return json(res, 200, await modelCatalog(provider(id)));
  }
  if (path === '/api/projects') {
    if (method === 'GET') return json(res, 200, db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all());
    if (method === 'POST') {
      const { name } = await input(req);
      const id = randomUUID();
      db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, field(name, '项目名称', 120), new Date().toISOString());
      return json(res, 201, project(id));
    }
  }
  const matchProject = path.match(/^\/api\/projects\/([a-f0-9-]+)\/tasks$/);
  if (matchProject) {
    if (method === 'GET') return json(res, 200, tasks(matchProject[1]));
    if (method === 'POST') return json(res, 201, await createTask(matchProject[1], await input(req)));
  }
  const matchTask = path.match(/^\/api\/tasks\/([a-f0-9-]+)\/poll$/);
  if (matchTask && method === 'POST') return json(res, 200, await pollTask(matchTask[1]));
  const mediaPath = path.match(/^\/api\/media\/([a-f0-9-]+)$/);
  if (method === 'GET' && mediaPath) {
    const result = db.prepare("SELECT mime,media FROM tasks WHERE id=? AND status='done'").get(mediaPath[1]);
    if (!result?.media) throw new HttpError(404, '找不到产物。');
    res.writeHead(200, { 'Content-Type': result.mime, 'Content-Length': result.media.length });
    return res.end(result.media);
  }
  throw new HttpError(404, '找不到该入口。');
}
const server = createServer((req, res) => {
  serve(req, res).catch(error => {
    if (res.headersSent) return res.destroy();
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : '本机服务出错。';
    json(res, status, { error:req.url?.startsWith('/gateway/') ? { message, type:'greenroom_gateway_error' } : message });
  });
}).listen(port, '127.0.0.1', () => console.log(`Greenroom · http://127.0.0.1:${port}`));

for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => {
  await harness.stop();
  server.close(() => db.close());
  server.closeAllConnections();
});
