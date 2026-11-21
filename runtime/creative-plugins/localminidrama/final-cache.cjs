// Only future, explicitly enrolled final files. No clips/storage sweep or legacy adoption.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
let active = 0;
const root = () => path.resolve(process.env.GREENROOM_PLUGIN_ROOT);
const shared = () => import('./greenroom-media-storage.mjs');
function seed(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS greenroom_merge_cache (
    merge_id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, archive_key TEXT NOT NULL,
    output_path TEXT NOT NULL, bytes INTEGER, sha256 TEXT
  )`);
}
async function locked(fn) {
  const member = root();
  const inherited = context.getStore();
  if (inherited?.active && inherited.member === member) return fn();
  if (fs.realpathSync(member) !== member) throw new Error('成片缓存成员目录无效');
  const mutex = path.join(member, '.localmini-final-cache-lock');
  try { fs.mkdirSync(mutex); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('成片正在使用或原进程中断，保留原任务，不自动抢占媒体锁'); throw error; }
  const token = { active: true, member }; active++;
  try { return await context.run(token, fn); }
  finally { token.active = false; active--; fs.rmdirSync(mutex); }
}
function requireLock() {
  if (!context.getStore()?.active || context.getStore().member !== root()) throw new Error('缓存写操作缺少成员媒体锁');
}
function enroll(db, row, output, key) {
  db.prepare('INSERT INTO greenroom_merge_cache(merge_id,task_id,archive_key,output_path) VALUES(?,?,?,?)')
    .run(row.id, row.task_id, key, output);
}
function journal(db, id) {
  return db.prepare(`SELECT d.*, m.drama_id, c.bytes, c.sha256 FROM greenroom_merge_cache c
    JOIN greenroom_merge_delivery d ON d.merge_id=c.merge_id AND d.task_id=c.task_id AND d.archive_key=c.archive_key AND d.output_path=c.output_path
    JOIN video_merges m ON m.id=d.merge_id AND m.task_id=d.task_id AND m.episode_id=d.episode_id
    WHERE c.merge_id=? AND m.deleted_at IS NULL AND m.status='completed'`).get(id);
}
function filename(db, row, missing = false) { return require('./greenroom-final-archive.cjs').safeOutput(db, row, missing); }
async function identity(db, row) {
  const file = filename(db, row);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const info = fs.fstatSync(fd);
  const hash = createHash('sha256');
  try {
    if (!info.isFile()) throw new Error('成片不是普通文件');
    for await (const chunk of fs.createReadStream(file, { fd, autoClose: false })) hash.update(chunk);
    const after = fs.fstatSync(fd);
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs) throw new Error('成片正在改变，禁止缓存操作');
    return { bytes: info.size, sha256: hash.digest('hex'), info, file };
  } finally { fs.closeSync(fd); }
}
async function capture(db, id) {
  requireLock();
  const row = journal(db, id); if (!row) return; // old journal remains unowned
  const value = await identity(db, row);
  const { MEDIA_MAX_BYTES } = await shared();
  if (value.bytes <= 0 || value.bytes > MEDIA_MAX_BYTES) throw new Error('成片超出资产文件大小限制');
  if (row.sha256 && (row.sha256 !== value.sha256 || row.bytes !== value.bytes)) throw new Error('原成片版本已改变，不能续传或回收');
  if (!row.sha256) db.prepare('UPDATE greenroom_merge_cache SET bytes=?,sha256=? WHERE merge_id=?').run(value.bytes, value.sha256, id);
}
function binding(db, id) {
  const row = journal(db, id);
  if (!row || !row.sha256 || row.status !== 'ready' || !/^[A-Za-z0-9_-]+$/.test(row.asset_id || '') || row.file_url !== '/api/media/' + row.asset_id) return null;
  const merge = db.prepare('SELECT merged_url FROM video_merges WHERE id=?').get(id);
  const task = db.prepare("SELECT result FROM async_tasks WHERE id=? AND status='completed' AND deleted_at IS NULL").get(row.task_id);
  let result; try { result = JSON.parse(task?.result); } catch { return null; }
  if (merge?.merged_url !== row.file_url || result?.merge_id !== id || result?.asset_id !== row.asset_id || result?.video_url !== row.file_url || result?.delivery_status !== 'ready' || result?.native_status !== 'completed') return null;
  const latest = db.prepare("SELECT id FROM video_merges WHERE episode_id=? AND status='completed' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(row.episode_id);
  if (latest?.id === id && db.prepare('SELECT video_url FROM episodes WHERE id=?').get(row.episode_id)?.video_url !== row.file_url) return null;
  return row;
}
function lookup(db, value) {
  if (typeof value !== 'string') return null;
  const base = (process.env.GREENROOM_BASE_PATH || '/plugins/localminidrama/').replace(/\/$/, '');
  const relative = value.startsWith(base + '/static/') ? value.slice((base + '/static/').length)
    : value.startsWith('/static/') ? value.slice(8) : value;
  return db.prepare(`SELECT c.merge_id FROM greenroom_merge_cache c LEFT JOIN greenroom_merge_delivery d ON d.merge_id=c.merge_id
    WHERE c.output_path=? OR d.file_url=?`).get(relative, value);
}
async function staticReference(db, value) {
  const found = lookup(db, value); if (!found) return null;
  const row = binding(db, found.merge_id); if (!row) return null;
  const file = filename(db, row, true);
  if (fs.existsSync(file)) {
    const actual = await identity(db, row);
    if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256) return null;
  }
  return row.file_url;
}
async function restoreInput(db, value) {
  requireLock();
  const found = lookup(db, value); if (!found) return null;
  const row = binding(db, found.merge_id);
  if (!row) throw new Error('原成片资产业务绑定不完整，不重新合成');
  const file = filename(db, row, true);
  if (fs.existsSync(file)) {
    const actual = await identity(db, row);
    if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256) throw new Error('本地成片已改变，保留原件，不覆盖或重新合成');
    return file;
  }
  const { assertStorageAvailable } = await shared();
  assertStorageAvailable(file, { reserveBytes: row.bytes });
  const temporary = file + '.' + randomUUID() + '.part';
  let fd;
  try {
    const response = await fetch('http://127.0.0.1:3081' + row.file_url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'video/mp4') throw new Error('原成片资产不可读取，不重新合成');
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let bytes = 0; const hash = createHash('sha256');
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > row.bytes) throw new Error('原资产大小不符');
      assertStorageAvailable(file, { reserveBytes: chunk.length });
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
        if (!written) throw new Error('原资产缓存未完整写入');
        offset += written;
      }
    }
    if (bytes !== row.bytes || fs.fstatSync(fd).size !== row.bytes || hash.digest('hex') !== row.sha256) throw new Error('原资产内容不符，不重新合成');
    fs.closeSync(fd); fd = undefined;
    fs.linkSync(temporary, file); // never overwrite a newly appeared original
    return file;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
// A legacy ABI-crashed merge can retain processing after its own durable task
// failed. This is not an active producer when the current native consumer lock
// is held. Never extend this exception to pending/unknown, missing ownership,
// or any journal/cache-managed output.
function isTerminalLegacyMerge(native, merge) {
  if (merge.status !== 'processing' || merge.deleted_at != null || !Number.isSafeInteger(merge.id) ||
      !Number.isSafeInteger(merge.episode_id) || merge.episode_id <= 0 || typeof merge.task_id !== 'string' || !merge.task_id) return false;
  const tasks = native.tasks.filter(task => task.id === merge.task_id);
  if (tasks.length !== 1 || native.merges.filter(item => item.task_id === merge.task_id).length !== 1) return false;
  const task = tasks[0];
  if (task.type !== 'video_merge' || task.resource_id !== String(merge.episode_id) || task.status !== 'failed' ||
      task.deleted_at != null || typeof task.completed_at !== 'string' || !task.completed_at || !Number.isFinite(Date.parse(task.completed_at))) return false;
  return ![...native.deliveries, ...native.caches].some(item => item.merge_id === merge.id || item.task_id === merge.task_id);
}
function hasUnsafeMerge(native) {
  return native.merges.some(merge => merge.deleted_at == null && !['completed', 'failed'].includes(merge.status) && !isTerminalLegacyMerge(native, merge));
}
async function remoteReadable(row) {
  try {
    // file_url was constructed from the committed asset ID by binding().
    const response = await fetch('http://127.0.0.1:3081' + row.file_url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (response.status !== 200 || !response.body) return false;
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > row.bytes) return false;
    }
    return bytes === row.bytes;
  } catch { return false; }
}
async function prune(db, limit) {
  requireLock();
  const { CACHE_MAX_BYTES } = await shared(); limit ??= CACHE_MAX_BYTES;
  // Unknown/uncompleted native tasks may still hold a physical path. Never infer idleness.
  if (hasUnsafeMerge({
    merges: db.prepare('SELECT * FROM video_merges').all(), tasks: db.prepare('SELECT * FROM async_tasks').all(),
    deliveries: db.prepare('SELECT * FROM greenroom_merge_delivery').all(), caches: db.prepare('SELECT * FROM greenroom_merge_cache').all(),
  })) return;
  const candidates = [];
  for (const { merge_id } of db.prepare('SELECT merge_id FROM greenroom_merge_cache').all()) {
    const row = binding(db, merge_id); if (!row) continue;
    try {
      const value = await identity(db, row);
      if (value.bytes === row.bytes && value.sha256 === row.sha256) candidates.push({ row, value });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let total = candidates.reduce((sum, item) => sum + item.value.bytes, 0);
  for (const { row, value } of candidates.sort((a, b) => a.value.info.mtimeMs - b.value.info.mtimeMs)) {
    if (total <= limit) break;
    if (!binding(db, row.merge_id)) continue;
    if (!await remoteReadable(row)) continue;
    const currentBinding = binding(db, row.merge_id);
    if (!currentBinding || currentBinding.asset_id !== row.asset_id || currentBinding.file_url !== row.file_url ||
        currentBinding.output_path !== row.output_path || currentBinding.bytes !== row.bytes) continue;
    const current = fs.lstatSync(value.file);
    if (current.isSymbolicLink() || current.ino !== value.info.ino || current.dev !== value.info.dev || current.size !== value.bytes || current.mtimeMs !== value.info.mtimeMs) continue;
    fs.unlinkSync(value.file); total -= value.bytes;
  }
}
async function consume(db, mergeId, fn) {
  return locked(async () => {
    const completed = db.prepare("SELECT 1 FROM greenroom_merge_delivery d JOIN video_merges m ON m.id=d.merge_id AND m.task_id=d.task_id WHERE d.merge_id=? AND m.status='completed'").get(mergeId);
    if (completed) return require('./greenroom-final-archive.cjs').archive(db, mergeId);
    const { assertStorageAvailable } = await shared(); assertStorageAvailable(root());
    return fn();
  });
}
module.exports = { isTerminalLegacyMerge, hasUnsafeMerge, seed, enroll, capture, binding, locked, restoreInput, staticReference, prune, consume, busy: () => active > 0 };
