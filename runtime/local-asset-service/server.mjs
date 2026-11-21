// SPDX-License-Identifier: AGPL-3.0-only
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, link, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const previews = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
  'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac']);
const TYPES = new Set(['image', 'audio', 'video', 'document', 'code', 'design']);
const MiB = 1024 * 1024;
const readLife = 600_000;
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function scope(value) {
  if (!value || !['resource_tenant_id', 'workspace_id', 'resource_id', 'actor_id'].every(
    name => typeof value[name] === 'string' && key.test(value[name])) ||
    !['project', 'organization'].includes(value.kind)) fail(400, 'Invalid asset scope');
  return {
    resource_tenant_id: value.resource_tenant_id, workspace_id: value.workspace_id, kind: value.kind,
    resource_id: value.resource_id, actor_id: value.actor_id,
  };
}

function scopeKey(s) {
  return JSON.stringify([s.resource_tenant_id, s.workspace_id, s.kind, s.resource_id,
    ...(s.kind === 'project' ? [s.actor_id] : [])]);
}

function requestScope(req, url) {
  const s = scope({
    resource_tenant_id: req.headers['x-greenroom-resource-tenant'], workspace_id: req.headers['x-greenroom-workspace-id'],
    kind: req.headers['x-greenroom-resource-scope'], resource_id: req.headers['x-greenroom-resource-id'],
    actor_id: req.headers['x-greenroom-actor-id'],
  });
  for (const [name, value] of Object.entries({
    resource_tenant_id: s.resource_tenant_id, scope_kind: s.kind, scope_id: s.resource_id, actor_id: s.actor_id,
  })) {
    const actual = url.searchParams.getAll(name);
    if (actual.length > 1 || (actual.length === 1 && actual[0] !== value)) fail(400, 'Conflicting asset scope');
  }
  return s;
}

async function jsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16 * 1024) fail(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  let value;
  try { value = JSON.parse(Buffer.concat(chunks)); } catch { fail(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid JSON body');
  return value;
}

function uploadMeta(body) {
  const { filename, size, type } = body;
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 240 ||
      /[\\/\x00-\x1f\x7f]/.test(filename) || !TYPES.has(type) ||
      body.is_private !== true || body.upload_mode !== 'single') fail(422, 'Unsupported upload metadata');
  if (!Number.isSafeInteger(size) || size < 1 ||
      size > (['image', 'audio', 'video'].includes(type) ? 512 : 50) * MiB) fail(413, 'Unsupported asset size');
  const mime = previews.has(body.content_type) && body.content_type.startsWith(type + '/') ?
    body.content_type : 'application/octet-stream';
  return [filename, size, type, mime];
}

function summary(row) {
  return { asset_id: row.id, filename: row.filename, size_bytes: row.size, content_type: row.mime,
    type: row.type, created_at: new Date(row.created).toISOString() };
}

function reply(res, status, body) {
  res.writeHead(status, body === undefined ? {} : {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function bounds(range, size) {
  if (range === undefined) return [0, size - 1];
  const m = typeof range === 'string' && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && start < size && end >= start ? [start, end] : null;
}

export async function createAssetServer({ dataDir, origin, serviceToken }) {
  if (typeof serviceToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(serviceToken)) {
    throw new Error('Set a random internal LOCAL_ASSET_TOKEN of at least 32 characters');
  }
  const base = new URL(origin);
  if (base.origin !== origin || base.protocol !== 'http:' ||
      !['127.0.0.1', 'asset'].includes(base.hostname)) throw new Error('Invalid local asset service origin');
  const dir = resolve(dataDir);
  const objectDir = join(dir, 'objects');
  await mkdir(objectDir, {recursive: true, mode: 0o700});
  const db = new DatabaseSync(join(dir, 'assets.sqlite3'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, upload_id TEXT NOT NULL UNIQUE, put_token TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL,
      mime TEXT NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assets_owner ON assets(owner, state, created, id);
    CREATE TABLE IF NOT EXISTS attachments (
      asset_id TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(asset_id,scope)
    );
    CREATE TABLE IF NOT EXISTS reads (
      token TEXT PRIMARY KEY, asset_id TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL
    );
  `);
  const sql = (stmt, ...args) => db.prepare(stmt).run(...args);
  const one = (stmt, ...args) => db.prepare(stmt).get(...args);
  const readable = (id, scope) => one(`
    SELECT * FROM assets WHERE id=? AND state='ready' AND
    (owner=? OR EXISTS(SELECT 1 FROM attachments WHERE asset_id=assets.id AND scope=?))
  `, id, scope, scope);
  const writing = new Set();
  const objectPath = id => join(objectDir, id);
  const uploadSession = row => ({
    asset_id: row.id, upload_id: row.upload_id, upload_url: base.origin + '/objects/upload/' + row.put_token,
  });
  const srv = http.createServer({requestTimeout: 600_000}, async (req, res) => {
    // The HTTP service is private to a trusted local host/network. No browser origin or CORS.
    try {
      const expectedHost = base.host;
      if (req.headers.host !== expectedHost || req.headers.origin || !req.url?.startsWith('/') ||
          req.url.startsWith('//')) fail(403, 'Local object authority required');
      const url = new URL(req.url, base.origin);
      if (url.origin !== base.origin) fail(403, 'Local object authority required');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') return reply(res, 200, {status: 'ok'});
      const capability = /^\/objects\/(upload|read)\/([^/]+)$/.exec(path);
      if (capability && ID.test(capability[2])) {
        const [, action, token] = capability;
        if (action === 'upload' && req.method === 'PUT') {
          const row = one("SELECT * FROM assets WHERE put_token=? AND state='pending'", token);
          if (!row) fail(404, 'Unknown upload');
          if (Number(req.headers['content-length']) !== row.size) fail(400, 'Upload length must match');
          if (writing.has(row.id)) fail(409, 'Original upload is already writing');
          let exists = false;
          try { await stat(objectPath(row.id)); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (writing.has(row.id) ||
              !one("SELECT 1 FROM assets WHERE id=? AND state='pending'", row.id)) fail(409, 'Original staged upload is unavailable for writing');
          writing.add(row.id);
          const temp = join(objectDir, '.part-' + randomUUID());
          try {
            if (exists) {
              // The legacy keyed consumer may replay the original PUT after a
              // lost reply. Compare bytes directly: no hash and no replacement.
              const old = await open(objectPath(row.id), 'r');
              try {
                let count = 0, equal = true;
                const info = await old.stat();
                if (!info.isFile() || info.size !== row.size) fail(409, 'Original staged bytes are unavailable');
                for await (const chunk of req.iterator({destroyOnReturn: false})) {
                  if (count + chunk.length > row.size) fail(400, 'Upload exceeded declared length');
                  if (equal) {
                    const previous = Buffer.allocUnsafe(chunk.length);
                    let read = 0;
                    while (read < chunk.length) {
                      const next = await old.read(previous, read, chunk.length - read, count + read);
                      if (!next.bytesRead) break;
                      read += next.bytesRead;
                    }
                    equal = read === chunk.length && previous.equals(chunk);
                  }
                  count += chunk.length;
                }
                if (!equal || count !== row.size) fail(409, 'Original staged asset bytes do not match');
              } finally { await old.close(); }
            } else {
              let seen = 0;
              const limit = new Transform({transform(chunk, _, cb) {
                seen += chunk.length;
                cb(seen <= row.size ? null : new HttpError(400, 'Upload exceeded declared length'), chunk);
              }});
              await pipeline(req, limit, createWriteStream(temp, {flags: 'wx', mode: 0o600}));
              if (seen !== row.size) fail(400, 'Incomplete upload');
              const fd = await open(temp, 'r+');
              try { await fd.sync(); } finally { await fd.close(); }
              await link(temp, objectPath(row.id)); // no replacement, including process restart
            }
          } finally {
            try { await unlink(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            finally { writing.delete(row.id); }
          }
          return reply(res, 204);
        }
        if (action === 'read' && ['GET', 'HEAD'].includes(req.method)) {
          const grant = one('SELECT * FROM reads WHERE token=? AND expires>?', token, Date.now());
          const row = grant && readable(grant.asset_id, grant.scope);
          if (!row) fail(404, 'Unknown or expired download');
          const [start, end] = bounds(req.headers.range, row.size) || [];
          const filename = encodeURIComponent(row.filename.toWellFormed()).replace(/['()*]/g, c =>
            '%' + c.charCodeAt(0).toString(16).toUpperCase());
          const headers = {'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Content-Type': row.mime,
            'Content-Disposition': (previews.has(row.mime) ? 'inline' : 'attachment') + "; filename*=UTF-8''" + filename};
          if (start === undefined) {
            res.writeHead(416, {...headers, 'Content-Range': 'bytes */' + row.size, 'Content-Length': '0'});
            return res.end();
          }
          const filenameOnDisk = objectPath(row.id);
          const file = await stat(filenameOnDisk);
          if (!file.isFile() || file.size !== row.size) fail(500, 'Stored asset bytes are unavailable');
          if (req.headers.range !== undefined) headers['Content-Range'] = `bytes ${start}-${end}/${row.size}`;
          headers['Content-Length'] = String(end - start + 1);
          res.writeHead(req.headers.range === undefined ? 200 : 206, headers);
          if (req.method === 'HEAD') return res.end();
          await pipeline(createReadStream(filenameOnDisk, {start, end}), res);
          return;
        }
        fail(405, 'Unsupported object method');
      }
      if (!path.startsWith('/v1/assets')) fail(404, 'Unknown local asset route');
      if (req.headers['x-greenroom-staging-token'] !== serviceToken) fail(401, 'Internal asset credential required');
      const s = requestScope(req, url);
      const owner = scopeKey(s);
      if (path === '/v1/assets:upload-init' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (s.kind !== 'project' || JSON.stringify(scope(body.resource_scope)) !== JSON.stringify(s)) {
          fail(403, 'Upload must use the authenticated personal scope');
        }
        const [filename, size, type, mime] = uploadMeta(body);
        const row = {id: randomUUID(), upload_id: randomUUID(), put_token: randomUUID()};
        sql("INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,'pending')",
          row.id, row.upload_id, row.put_token, owner, filename, size, type, mime, Date.now());
        return reply(res, 200, uploadSession(row));
      }
      if (path === '/v1/assets' && req.method === 'GET') {
        const rows = db.prepare(`SELECT * FROM assets WHERE state='ready' AND
          (owner=? OR EXISTS(SELECT 1 FROM attachments WHERE asset_id=assets.id AND scope=?))
          ORDER BY created,id`).all(owner, owner);
        return reply(res, 200, {assets: rows.map(summary)});
      }
      const match = /^\/v1\/assets\/([^/:]+)(.*)$/.exec(path);
      if (!match || !ID.test(match[1])) fail(404, 'Unknown asset or upload');
      const [, id, op] = match;
      if (req.method === 'POST' && [':presign-upload', '/upload-finalize', ':abort-upload'].includes(op)) {
        const body = await jsonBody(req);
        const row = one("SELECT * FROM assets WHERE upload_id=? AND owner=? AND state IN ('pending','ready')", id, owner);
        if (!row) fail(404, 'Unknown upload in this scope');
        if (op === ':presign-upload') {
          if (row.state !== 'pending') fail(409, 'Upload is already finalized');
          return reply(res, 200, uploadSession(row));
        }
        if (op === ':abort-upload') {
          if (row.state !== 'pending' || writing.has(row.id)) fail(409, 'Original upload cannot be aborted');
          sql("UPDATE assets SET state='aborted' WHERE id=? AND state='pending'", row.id);
          try { await unlink(objectPath(row.id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          return reply(res, 200, {});
        }
        if (Object.hasOwn(body, 'sha256')) fail(422, 'Checksum-bound finalization is unsupported in local mode');
        if (row.state === 'pending') {
          if (writing.has(row.id)) fail(409, 'Original upload is still writing');
          let f;
          try { f = await stat(objectPath(row.id)); }
          catch (e) { if (e.code === 'ENOENT') fail(409, 'Original upload has no complete bytes'); throw e; }
          if (!f.isFile() || f.size !== row.size) fail(409, 'Original upload has no complete bytes');
          sql("UPDATE assets SET state='ready' WHERE id=? AND state='pending'", row.id);
        }
        const finalized = readable(row.id, owner);
        if (!finalized) fail(409, 'Original upload cannot be finalized');
        return reply(res, 200, summary(finalized));
      }
      if (req.method === 'DELETE' && op === '' && s.kind === 'organization') {
        // Only this scope is detached; replay after a lost reply is harmless.
        sql('DELETE FROM attachments WHERE asset_id=? AND scope=?', id, owner);
        return reply(res, 200, {});
      }
      const row = readable(id, owner);
      if (!row) fail(404, 'Unknown asset in this scope');
      if (req.method === 'GET' && op === '') return reply(res, 200, summary(row));
      if (req.method === 'GET' && op === '/signed-url') {
        const token = randomUUID(), now = Date.now();
        sql('DELETE FROM reads WHERE expires<=?', now);
        sql('INSERT INTO reads VALUES (?,?,?,?)', token, row.id, owner, now + readLife);
        return reply(res, 200, {url: base.origin + '/objects/read/' + token});
      }
      if (req.method === 'POST' && op === ':attach') {
        const body = await jsonBody(req);
        const source = scope(body.source_scope), target = scope(body.target_scope);
        if (s.kind !== 'project' || row.owner !== owner || JSON.stringify(source) !== JSON.stringify(s) ||
            target.kind !== 'organization' || target.actor_id !== s.actor_id ||
            target.resource_tenant_id !== s.resource_tenant_id) fail(403, 'Unsupported attachment scope');
        sql('INSERT OR IGNORE INTO attachments VALUES (?,?)', id, scopeKey(target));
        return reply(res, 200, {});
      }
      fail(405, 'Unsupported local asset operation');
    } catch (e) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      if (!(e instanceof HttpError)) console.error('Local asset request failed:', e.code || e.name);
      reply(res, e.status || 500, {error: {message: e.status ? e.message : 'Local asset storage failure'}});
    }
  });
  srv.on('close', () => db.close());
  return srv;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || '18081');
  const origin = process.env.ASSET_INTERNAL_URL || `http://127.0.0.1:${port}`;
  if (!['127.0.0.1', '0.0.0.0'].includes(host) ||
      (host === '0.0.0.0' && new URL(origin).hostname !== 'asset') ||
      !(Number.isInteger(port) && port >= 1 && port <= 65535) ||
      Number(new URL(origin).port) !== port) throw new Error('Asset listen host/port does not match local origin');
  const srv = await createAssetServer({dataDir: process.env.DATA_DIR || './data/local-assets/objects',
    origin,
    serviceToken: process.env.LOCAL_ASSET_TOKEN});
  srv.listen(port, host, () => console.log('Local asset service listening on', host + ':' + port));
}
