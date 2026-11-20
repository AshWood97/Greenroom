import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  UPDATE tasks SET status = 'interrupted', error = '本机服务在等待模型时停止。请先核对服务商用量。'
    WHERE status = 'running';
`);

const modalities = ['text', 'image', 'audio'];
const protocols = ['responses', 'completions'];
const localHosts = ['localhost', '127.0.0.1', '[::1]'];
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
async function input(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, '请提交 JSON。');
  }
  let length = 0;
  const parts = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 100_000) throw new HttpError(413, '输入太长。');
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
    throw new HttpError(502, '未收到网关响应，请核对地址、网络或服务商的任务记录。');
  }
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    const raw = details?.error?.message;
    const reason = typeof raw === 'string'
      ? raw.replaceAll(key, '[已隐藏]').replace(/(?:https?:\/\/|[A-Za-z0-9_+\/-]{50,})\S*/g, '[已隐藏]').slice(0, 260)
      : '';
    throw new HttpError(502, `网关返回 HTTP ${response.status}${reason ? ' · ' + reason : ''}`);
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
    const response = await requestModel(selected, viaResponses ? '/responses' : '/chat/completions', body);
    const payload = await response.json();
    const content = viaResponses
      ? payload.output?.flatMap(row => row.content ?? []).filter(row => row.type === 'output_text').map(row => row.text).join('')
      : payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, '模型未返回文字。');
    return { content, mime: null, bytes: null };
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

const taskFields = 'id,kind,model,provider_name,prompt,status,content,mime,error,created_at';
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
    const projectId = project(matchProject[1]).id;
    if (method === 'GET') {
      return json(res, 200, db.prepare(`SELECT ${taskFields} FROM tasks WHERE project_id = ? ORDER BY created_at DESC`).all(projectId));
    }
    if (method === 'POST') {
      const body = await input(req);
      if (!modalities.includes(body.kind)) throw new HttpError(422, '工具类型无效。');
      const model = field(body.model, '模型', 200);
      const prompt = field(body.prompt, '创作内容', 12_000);
      const defaultId = db.prepare("SELECT value FROM preferences WHERE key = 'default'").get()?.value;
      const providerId = body.providerId || defaultId;
      if (!providerId) throw new HttpError(422, '请先配置供应商。');
      const selected = provider(providerId);
      if (!selected.scope.includes(body.kind)) throw new HttpError(403, '此供应商未启用该用途。');
      const id = randomUUID();
      db.prepare(`INSERT INTO tasks (id,project_id,kind,model,provider_id,provider_name,prompt,status,created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`).run(id, projectId, body.kind, model, selected.id, selected.name, prompt, new Date().toISOString());
      try {
        const result = await generate(selected, body.kind, model, prompt, body.options ?? {});
        db.prepare("UPDATE tasks SET status='done', content=?, mime=?, media=? WHERE id=?")
          .run(result.content, result.mime, result.bytes, id);
      } catch (error) {
        db.prepare("UPDATE tasks SET status='failed', error=? WHERE id=?")
          .run(error instanceof HttpError ? error.message : '未能读取模型返回的结果。', id);
      }
      return json(res, 201, db.prepare(`SELECT ${taskFields} FROM tasks WHERE id=?`).get(id));
    }
  }
  const mediaPath = path.match(/^\/api\/media\/([a-f0-9-]+)$/);
  if (method === 'GET' && mediaPath) {
    const result = db.prepare("SELECT mime,media FROM tasks WHERE id=? AND status='done'").get(mediaPath[1]);
    if (!result?.media) throw new HttpError(404, '找不到产物。');
    res.writeHead(200, { 'Content-Type': result.mime, 'Content-Length': result.media.length });
    return res.end(result.media);
  }
  throw new HttpError(404, '找不到该入口。');
}
createServer((req, res) => {
  serve(req, res).catch(error => {
    if (res.headersSent) return res.destroy();
    json(res, error instanceof HttpError ? error.status : 500,
      { error: error instanceof HttpError ? error.message : '本机服务出错。' });
  });
}).listen(port, '127.0.0.1', () => console.log(`Greenroom · http://127.0.0.1:${port}`));
