import { mkdir, mkdirSync, rmdir, readdir, readdirSync, lstat, constants, open, link, unlink, writeFile, readFile, existsSync, statSync, lstatSync, realpathSync, rmSync } from '@toonflow/file';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CACHE_MAX_BYTES, MEDIA_MAX_BYTES, assertStorageAvailable } from './greenroomMediaStorage.mjs';
import type { Database } from 'bun:sqlite';

// New, unchanged provider image/video bytes only. Not an uploads/tmp/project quota.
export function createMediaCache({ db, root, workspaces, bridge, referenced }: {
  db: Database; root: string; workspaces: string; bridge: string; referenced: (row: any, output: any) => boolean;
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS media_cache (
    job_id TEXT NOT NULL, ordinal INTEGER NOT NULL, cwd TEXT NOT NULL, path TEXT NOT NULL,
    asset_id TEXT NOT NULL, mime TEXT NOT NULL, asset_name TEXT, state TEXT NOT NULL, part TEXT NOT NULL,
    bytes INTEGER, sha256 TEXT, last_used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id,ordinal), UNIQUE(cwd,path)
  )`);
  root = realpathSync(root); workspaces = realpathSync(workspaces);
  const leases = join(root, '.toonflowMediaLeases'), mutex = join(root, '.toonflowMediaLock');
  mkdirSync(leases, { recursive: true });
  if (realpathSync(root) !== root || realpathSync(leases) !== leases) throw new Error('素材缓存成员目录无效');
  const context = new AsyncLocalStorage<{ directory: string; active: boolean }>();
  let queue: Promise<unknown> = Promise.resolve();
  let active = 0;
  const projectQueue = new Map<string, Promise<unknown>>();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      try { await mkdir(mutex); }
      catch (error: any) { if (error.code === 'EEXIST') throw new Error('素材协调锁正在使用或上次中断，不自动抢占'); throw error; }
      try { return await fn(); } finally { await rmdir(mutex); }
    });
    queue = result.catch(() => {});
    return result;
  }
  function directory(value: string) {
    const path = realpathSync(value);
    if (!path.startsWith(realpathSync(workspaces) + sep) || path !== resolve(value)) throw new Error('素材目录超出成员工作区或经过符号链接');
    return path;
  }
  function filename(row: any) {
    const cwd = directory(row.cwd), name = row.path;
    if (typeof name !== 'string' || name.includes('\\') || name.split('/').some((part: string) => !part || part === '..' || part === '.')) throw new Error('素材缓存路径无效');
    const path = resolve(cwd, name);
    if (!path.startsWith(cwd + sep)) throw new Error('素材缓存路径超出工程');
    if (realpathSync(dirname(path)) !== dirname(path)) throw new Error('素材缓存祖先路径改变');
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('素材缓存不是普通文件');
    return path;
  }
  async function identity(path: string) {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('素材不是普通文件');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256');
    try {
      const opened = await file.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('素材正在改变');
      for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('素材正在改变');
      return { bytes: before.size, sha256: hash.digest('hex'), info: before };
    } finally { await file.close(); }
  }
  function same(info: any, value: any) { return info.bytes === value.bytes && info.sha256 === value.sha256; }
  function output(row: any) {
    const job: any = db.query('SELECT * FROM jobs WHERE id=? AND cwd=?').get(row.job_id, row.cwd);
    if (!job || job.state !== 'succeeded' || JSON.parse(job.request).mediaStorageVersion !== 1) return null;
    const result = JSON.parse(job.result || 'null')?.[row.ordinal];
    if (result?.cacheVersion !== 1 || result.path !== row.path || result.assetId !== row.asset_id || result.mimeType !== row.mime
      || result.url !== '/api/media/' + row.asset_id || result.fileName !== row.asset_name || result.cacheSha256 !== row.sha256 || result.bytes !== row.bytes) return null;
    return { job, result };
  }
  function lookup(path: string) {
    return (db.query("SELECT * FROM media_cache WHERE state='ready'").all() as any[]).find(row => resolve(row.cwd, row.path) === resolve(path));
  }
  function rows(cwd: string, path = cwd, uncommitted = false) {
    cwd = directory(cwd); path = resolve(path);
    return (db.query(uncommitted ? "SELECT * FROM media_cache WHERE cwd=? AND state!='invalid'" : "SELECT * FROM media_cache WHERE cwd=? AND state='ready'").all(cwd) as any[])
      .filter(row => { const target = resolve(cwd, row.path); return target === path || target.startsWith(path + sep); });
  }
  async function pinned() {
    const values = new Set<string>();
    for (const name of await readdir(leases)) {
      if (!/^[0-9a-f-]{36}$/.test(name) || !(await lstat(join(leases, name))).isFile()) throw new Error('素材租约状态未知，禁止回收');
      values.add(directory(await readFile(join(leases, name), 'utf8')));
    }
    return values;
  }
  async function pruneUnlocked(budget = CACHE_MAX_BYTES) {
    const pins = await pinned();
    const entries: any[] = [];
    for (const row of db.query("SELECT * FROM media_cache WHERE state='ready'").all() as any[]) {
      const binding = output(row);
      if (!binding || pins.has(row.cwd) || !referenced(binding.job, binding.result)) continue;
      let path;
      try { path = filename(row); } catch { continue; }
      if (existsSync(path)) entries.push({ row, path, info: statSync(path) });
    }
    let total = entries.reduce((n, entry) => n + entry.info.size, 0);
    for (const entry of entries.sort((a, b) => a.row.last_used - b.row.last_used || a.info.mtimeMs - b.info.mtimeMs)) {
      if (total <= budget) break;
      const { row, path } = entry;
      const actual = await identity(path);
      if (!same(actual, row)) continue; // changed bytes are an unarchived original
      const binding = output(row), current = lstatSync(path);
      if (!binding || !referenced(binding.job, binding.result) || current.dev !== actual.info.dev || current.ino !== actual.info.ino
        || current.size !== actual.info.size || current.mtimeMs !== actual.info.mtimeMs || current.ctimeMs !== actual.info.ctimeMs) continue;
      rmSync(path); total -= actual.bytes; // exact owned file; never recurse
    }
    return total;
  }
  const prune = (budget = CACHE_MAX_BYTES) => locked(() => pruneUnlocked(budget));
  async function withLease<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    cwd = directory(cwd);
    const inherited = context.getStore();
    if (inherited?.active && inherited.directory === cwd) return fn();
    const previous = projectQueue.get(cwd) || Promise.resolve();
    active++;
    const result = previous.catch(() => {}).then(() => leaseOperation(cwd, fn));
    projectQueue.set(cwd, result);
    try { return await result; } finally { active--; if (projectQueue.get(cwd) === result) projectQueue.delete(cwd); }
  }
  async function leaseOperation<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const token = join(leases, randomUUID()), state = { directory: cwd, active: true };
    await locked(async () => {
      if ((await pinned()).has(cwd)) throw new Error('工程素材正在使用或原操作结果未知，请保留原任务稍后恢复');
      await writeFile(token, cwd, { flag: 'wx', mode: 0o600 });
    });
    let unknown = false;
    try { return await context.run(state, fn); }
    catch (error: any) { unknown = error?.mediaLeaseUnknown === true; throw error; }
    finally {
      state.active = false;
      // A worker failure may leave its native child alive. Retain its unknown lease.
      if (!unknown) await locked(async () => { await unlink(token); });
      try { await prune(); } catch { /* Preserve committed success and all unknown files/leases. */ }
    }
  }
  function requireLease(cwd: string) {
    const state = context.getStore();
    if (!state?.active || state.directory !== cwd) throw new Error('素材写入缺少工程租约');
  }
  async function download(row: any, restoring = false) {
    requireLease(row.cwd);
    const path = filename(row), part = join(dirname(path), row.part);
    if (existsSync(path)) {
      if (!row.sha256 || !same(await identity(path), row)) throw new Error('原素材已存在或字节改变，保留原件');
      return path;
    }
    if (existsSync(part)) {
      if (!row.sha256 || !same(await identity(part), row)) throw new Error('原下载暂存结果未知，保留文件，不自动覆盖');
    } else {
      assertStorageAvailable(path, { reserveBytes: restoring ? row.bytes : MEDIA_MAX_BYTES });
      const response = await fetch(bridge + '/media/' + encodeURIComponent(row.asset_id), { redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== row.mime || !response.body) { await response.body?.cancel(); throw new Error('原素材 Asset 不可读取，保留原任务'); }
      let assetName = '';
      try { assetName = decodeURIComponent(/(?:^|;\s*)filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') || '')?.[1] || ''); } catch { /* refuse malformed canonical metadata */ }
      if (!assetName || /[\x00-\x1f]/.test(assetName) || (restoring && assetName !== row.asset_name)) { await response.body.cancel(); throw new Error('原 Asset 文件名元数据缺失或改变'); }
      const declared = Number(response.headers.get('content-length'));
      if (declared > MEDIA_MAX_BYTES || (restoring && declared && declared !== row.bytes)) { await response.body.cancel(); throw new Error('原 Asset 大小不符'); }
      const file = await open(part, 'wx', 0o600);
      const hash = createHash('sha256'); let bytes = 0;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > MEDIA_MAX_BYTES || (restoring && bytes > row.bytes)) throw new Error('原 Asset 超出媒体限制');
          hash.update(chunk);
          let written = 0;
          while (written < chunk.byteLength) written += (await file.write(chunk, written, chunk.byteLength - written)).bytesWritten;
        }
        const sha256 = hash.digest('hex');
        if (!bytes || (declared && bytes !== declared) || (restoring && (bytes !== row.bytes || sha256 !== row.sha256))) throw new Error('原 Asset 内容身份不符');
        await file.sync();
        if (!restoring) {
          db.query("UPDATE media_cache SET bytes=?,sha256=?,asset_name=?,state='downloaded' WHERE job_id=? AND ordinal=? AND state='planned'").run(bytes, sha256, assetName, row.job_id, row.ordinal);
          row = { ...row, bytes, sha256, asset_name: assetName };
        }
      } finally { await file.close(); } // unknown/incomplete partial is retained, never overwritten
    }
    if (!same(await identity(part), row)) throw new Error('原下载内容改变，保留文件');
    await link(part, path); // exclusive publish; never replace a newly appeared user file
    await unlink(part);
    return path;
  }
  async function capture(job: any, ordinal: number, local: string, assetId: string, mime: string) {
    requireLease(job.cwd);
    if (!/^[A-Za-z0-9_-]+$/.test(assetId) || !/^(image|video)\/[A-Za-z0-9.+-]+$/.test(mime)) throw new Error('生成素材 Asset 身份无效');
    let row: any = db.query('SELECT * FROM media_cache WHERE job_id=? AND ordinal=?').get(job.id, ordinal);
    if (!row) {
      const candidate = { cwd: job.cwd, path: local };
      if (existsSync(filename(candidate))) throw new Error('新生成路径已有原件，不自动接管');
      db.query("INSERT INTO media_cache(job_id,ordinal,cwd,path,asset_id,mime,state,part) VALUES(?,?,?,?,?,?,'planned',?)")
        .run(job.id, ordinal, job.cwd, local, assetId, mime, '.toonflowMedia-' + randomUUID() + '.part');
      row = db.query('SELECT * FROM media_cache WHERE job_id=? AND ordinal=?').get(job.id, ordinal);
    }
    if (row.cwd !== job.cwd || row.path !== local || row.asset_id !== assetId || row.mime !== mime || !['planned','downloaded'].includes(row.state)) throw new Error('原任务素材身份变化，不能重建');
    if (row.state === 'downloaded' && !row.sha256) throw new Error('原下载身份未知，不自动重新绑定');
    await download(row, row.state === 'downloaded' || Boolean(row.sha256));
    row = db.query('SELECT * FROM media_cache WHERE job_id=? AND ordinal=?').get(job.id, ordinal);
    return { path: local, mimeType: mime, mediaType: job.kind, assetId, url: '/api/media/' + assetId, cacheVersion: 1, fileName: row.asset_name, bytes: row.bytes, cacheSha256: row.sha256 };
  }
  function touch(row: any) {
    // Durable access order; no wall-clock/mtime approximation and no business-state change.
    db.query('UPDATE media_cache SET last_used=(SELECT COALESCE(MAX(last_used),0)+1 FROM media_cache) WHERE job_id=? AND ordinal=?').run(row.job_id, row.ordinal);
  }
  function finalize(jobId: string) {
    for (const row of db.query("SELECT * FROM media_cache WHERE job_id=? AND state='downloaded'").all(jobId) as any[]) {
      const binding = output(row);
      if (binding && referenced(binding.job, binding.result)) { db.query("UPDATE media_cache SET state='ready' WHERE job_id=? AND ordinal=?").run(jobId, row.ordinal); touch(row); }
    }
  }
  async function reference(path: string) {
    const row = lookup(path);
    if (!row || !output(row)) return null;
    path = filename(row);
    if (existsSync(path)) {
      const actual = await identity(path);
      if (!same(actual, row)) return null;
      const current = lstatSync(filename(row), { throwIfNoEntry: false });
      if (!current || current.dev !== actual.info.dev || current.ino !== actual.info.ino || current.size !== actual.info.size
        || current.mtimeMs !== actual.info.mtimeMs || current.ctimeMs !== actual.info.ctimeMs) return null;
    }
    const latest = lookup(path);
    if (!latest || latest.job_id !== row.job_id || latest.ordinal !== row.ordinal || !output(latest)) return null;
    touch(row);
    return { assetId: row.asset_id, fileUrl: '/api/media/' + row.asset_id, mimeType: row.mime, fileName: row.asset_name, fileSize: row.bytes, assetType: row.mime.split('/')[0] };
  }
  async function restore(cwd: string, paths = [cwd]) {
    requireLease(cwd);
    for (const row of rows(cwd).filter(row => paths.some(path => resolve(row.cwd, row.path) === resolve(path) || resolve(row.cwd, row.path).startsWith(resolve(path) + sep)))) {
      if (!output(row)) throw new Error('原素材业务引用改变，不自动下载或生成');
      await download(row, true); touch(row);
    }
  }
  function invalidate(cwd: string, paths: string[]) {
    requireLease(cwd);
    for (const row of rows(cwd, cwd, true).filter(row => paths.some(path => resolve(row.cwd, row.path) === resolve(path) || resolve(row.cwd, row.path).startsWith(resolve(path) + sep))))
      db.query("UPDATE media_cache SET state='invalid' WHERE job_id=? AND ordinal=?").run(row.job_id, row.ordinal);
  }
  async function invalidateChanged(cwd: string, paths = [cwd]) {
    requireLease(cwd);
    for (const row of rows(cwd, cwd, true).filter(row => row.sha256 && paths.some(path => resolve(row.cwd, row.path) === resolve(path) || resolve(row.cwd, row.path).startsWith(resolve(path) + sep)))) {
      let unchanged = false;
      try { unchanged = same(await identity(filename(row)), row); } catch { /* unknown output no longer cache-owned */ }
      if (!unchanged) db.query("UPDATE media_cache SET state='invalid' WHERE job_id=? AND ordinal=?").run(row.job_id, row.ordinal);
    }
  }
  function listing(cwd: string, folder: string, entries: any[]) {
    // Native directory picker lists the canonical workspace container before choosing a project.
    if (cwd === workspaces && folder === workspaces && realpathSync(workspaces) === workspaces) return entries;
    const result = [...entries];
    for (const row of rows(cwd, folder)) {
      if (!output(row) || dirname(resolve(row.cwd, row.path)) !== resolve(folder)) continue;
      const name = row.path.split('/').at(-1)!;
      if (!result.some(entry => entry.name === name)) result.push({ name, isFile: () => true, isDirectory: () => false });
    }
    return result;
  }
  const hasFiles = (cwd: string, paths: string[]) => (db.query("SELECT * FROM media_cache WHERE cwd=? AND state!='invalid'").all(cwd) as any[])
    .some(row => paths.some(path => resolve(cwd, row.path) === resolve(path) || resolve(cwd, row.path).startsWith(resolve(path) + sep)));
  const admit = (cwd: string) => withLease(cwd, async () => { assertStorageAvailable(cwd, { reserveBytes: MEDIA_MAX_BYTES }); });
  return { hasFiles, admit, withLease, capture, finalize, reference, restore, invalidate, invalidateChanged, listing, prune, get busy() {
    if (active > 0) return true;
    try { return readdirSync(leases).length > 0 || existsSync(mutex); } catch { return true; }
  } };
}
