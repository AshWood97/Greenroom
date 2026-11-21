import { mkdir, readdir, readFile, writeFile, realpath, lstat, unlink, rmdir } from 'node:fs/promises';
import { join, resolve, sep, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { CACHE_MAX_BYTES, MEDIA_MAX_BYTES, assertStorageAvailable } from '../../shared/media-storage.mjs';

// Only new imports carrying a durable Asset reference are cache-owned. Native
// work, historical imports, and failed/unknown uploads are counted, never swept.
export async function createAssetCache({ root, suiteId, loadProject, download,
  idleBytes = CACHE_MAX_BYTES, scratchBytes = MEDIA_MAX_BYTES, storageAvailable = assertStorageAvailable }) {
  root = await realpath(root);
  const leaseDirectory = join(root, '.asset-cache-leases');
  const mutex = join(root, '.asset-cache-lock');
  const reservations = join(root, '.asset-cache-reservations');
  await mkdir(reservations, { recursive: true });
  if (await realpath(reservations) !== reservations) throw new Error('素材预留目录无效');
  await mkdir(leaseDirectory, { recursive: true });
  if (await realpath(leaseDirectory) !== leaseDirectory) throw new Error('素材租约目录无效');
  async function locked(fn) {
    try { await mkdir(mutex); }
    catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('素材缓存协调锁正在使用或上次中断，禁止并发回收'), { code: 'CACHE_COORDINATION_BUSY' }); throw error; }
    try { return await fn(); } finally { await rmdir(mutex); }
  }
  async function pinnedProjects() {
    const pins = [];
    // Pre-P1-CR crash markers are never silently discarded or rewritten.
    try {
      const legacy = JSON.parse(await readFile(join(root, '.asset-cache-leases.json'), 'utf8'));
      if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('素材租约记录无效');
      pins.push(...Object.values(legacy));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const token of await readdir(leaseDirectory)) {
      try {
        if (!/^[0-9a-f-]{36}$/.test(token) || !(await lstat(join(leaseDirectory, token))).isFile()) throw new Error('素材租约记录无效');
        const projectId = await readFile(join(leaseDirectory, token), 'utf8');
        if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('素材租约记录无效');
        pins.push(projectId);
      } catch (error) { if (error.code !== 'ENOENT') throw error; } // owner completed during scan
    }
    return pins;
  }
  async function identity(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  }
  async function local(projectId, name, missing = false) {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId) || typeof name !== 'string' || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('缓存路径无效');
    const project = join(root, 'projects', projectId), path = resolve(project, name);
    if (!path.startsWith(project + sep) || await realpath(project) !== project) throw new Error('缓存路径越过当前工程');
    // Resolve the parent even when the cached file has been evicted.
    if (await realpath(dirname(path)) !== dirname(path)) throw new Error('缓存目录不能为符号链接');
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('缓存文件不能为符号链接'); return { path, info }; }
    catch (error) { if (missing && error.code === 'ENOENT') return { path }; throw error; }
  }
  async function usage(directory = root) {
    let bytes = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) bytes += await usage(path);
      else if (entry.isFile()) {
        try { bytes += (await lstat(path)).size; }
        catch (error) { if (error.code !== 'ENOENT' || ![leaseDirectory, reservations].includes(directory)) throw error; }
      }
      // Symlinks are never followed, materialized through, or evicted.
    }
    return bytes;
  }
  async function entries() {
    const rows = [];
    for (const entry of await readdir(join(root, 'projects'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const directory = join(root, 'projects', entry.name);
      if (await realpath(directory) !== directory) throw new Error('缓存工程不能经过符号链接');
      const project = await loadProject(entry.name);
      if (project.suiteId !== suiteId) throw new Error('缓存工程作用域不匹配');
      for (const [assetId, asset] of Object.entries(project.assets)) {
        if (asset.cacheManaged !== true || asset.assetId !== assetId) continue;
        const file = await local(project.projectId, asset.path, true);
        if (file.info) rows.push({ ...file, projectId: project.projectId, identity: asset.cacheSha256 });
      }
    }
    return rows;
  }
  async function pruneUnlocked(target = idleBytes) {
    const pins = await pinnedProjects();
    const rows = await entries();
    let total = rows.reduce((n, row) => n + row.info.size, 0);
    for (const row of rows.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
      if (total <= target) break;
      if (pins.includes(row.projectId)) continue;
      // A native script may have changed the file, even without changing its size.
      // Such bytes are an unarchived original, not disposable Asset cache.
      if (!/^[a-f0-9]{64}$/.test(row.identity || '') || await identity(row.path) !== row.identity) continue;
      // Exact committed cache file only. No recursive deletion of projects.
      await unlink(row.path); total -= row.info.size;
    }
    return total;
  }
  const prune = (target = idleBytes) => locked(() => pruneUnlocked(target));
  async function reservedBytes() {
    let total = 0;
    for (const name of await readdir(reservations)) {
      try {
        if (!/^[0-9a-f-]{36}$/.test(name) || !(await lstat(join(reservations, name))).isFile()) throw new Error('素材预留记录无效');
        const bytes = Number(await readFile(join(reservations, name), 'utf8'));
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('素材预留记录无效');
        total += bytes;
      } catch (error) { if (error.code !== 'ENOENT') throw error; } // owner completed during scan
    }
    return total;
  }
  async function admitUnlocked(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MEDIA_MAX_BYTES) throw new Error('素材大小超出临时文件上限');
    const reserved = await reservedBytes();
    await pruneUnlocked(Math.max(0, Math.min(idleBytes, scratchBytes - await usage() - reserved - bytes)));
    storageAvailable(root, { reserveBytes: bytes + reserved, maxBytes: scratchBytes, usedBytes: await usage() });
  }
  const admit = bytes => locked(() => admitUnlocked(bytes));
  async function reserve(bytes) {
    const token = join(reservations, randomUUID());
    await locked(async () => { await admitUnlocked(bytes); await writeFile(token, String(bytes), { flag: 'wx' }); });
    // A writer crash retains its reservation. No timer/PID guesses reclaim it.
    return () => unlink(token).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async function coordinationBlocked() {
    try { await lstat(mutex); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function withLease(projectId, fn) {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('素材租约工程无效');
    const token = join(leaseDirectory, randomUUID());
    await locked(() => writeFile(token, projectId, { flag: 'wx' }));
    try { return await fn(); }
    finally {
      // Only this completed operation owns this token. Atomic unlink needs no
      // global lock; a concurrent scan may conservatively retain the old pin.
      await unlink(token);
      try { await prune(); }
      catch (error) { if (error.code !== 'CACHE_COORDINATION_BUSY') throw error; }
    }
  }
  async function materialize(projectId, asset, signal) {
    const file = await local(projectId, asset.path, true);
    if (!file.info) {
      if (asset.cacheManaged !== true || !/^[A-Za-z0-9_-]+$/.test(asset.assetId)) throw new Error('未归档的原文件不可自动恢复');
      if (!/^[a-f0-9]{64}$/.test(asset.cacheSha256 || '')) throw new Error('素材缓存缺少原内容身份，不可自动恢复');
      await download(asset.assetId, signal, { destination: file.path, maxBytes: MEDIA_MAX_BYTES, admit: reserve, contentSha256: asset.cacheSha256 });
    }
    if (asset.cacheManaged === true && (!/^[a-f0-9]{64}$/.test(asset.cacheSha256 || '') || await identity(file.path) !== asset.cacheSha256)) throw new Error('素材本地内容已改变，原件保留，需先另行归档');
    return file.path;
  }
  return { identity, admit, reserve, coordinationBlocked, prune, withLease, materialize, usage };
}
