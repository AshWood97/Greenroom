import { lstatSync, realpathSync, readdirSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { rm, rename } from 'node:fs/promises';
import { join, resolve, relative, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { archiveFile, assertStorageAvailable, MEDIA_MAX_BYTES } from './media-storage.mjs';

// This is admission accounting, not a filesystem quota or a bound on native
// FFmpeg intermediate writes. Failed/unbound originals are counted, never pruned.
const DEFAULT_ADMISSION_BYTES = 8 * 1024 ** 3;
export function createMediaRetention({ root, tasks, bridge }) {
  const files = join(root, 'files'), leases = new Map(), pending = new Map(), downloads = new Map();
  const limit = Number(process.env.GREENROOM_KINEO_ADMISSION_BYTES || DEFAULT_ADMISSION_BYTES);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Kineo 临时文件预算无效');
  const managed = task => task?.mediaRetention?.version === 1;
  function safe(path, directory = root) {
    const target = resolve(path);
    if (!target.startsWith(directory + '/') || realpathSync(root) !== root) throw new Error('媒体不属于当前任务目录');
    let current = root;
    for (const part of relative(root, target).split('/')) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('媒体路径不能包含符号链接'); } catch(error) { if(error.code!=='ENOENT') throw error; }
    }
    return target;
  }
  function bytes(directory) {
    if (!existsSync(directory)) return 0;
    const info = lstatSync(directory);
    if (info.isSymbolicLink()) throw new Error('临时文件目录不能包含符号链接');
    if (!info.isDirectory()) return info.size;
    return readdirSync(directory).reduce((sum, name) => sum + bytes(join(directory, name)), 0);
  }
  function admit(taskId, reserveBytes = MEDIA_MAX_BYTES) {
    const reserved = Object.values(tasks()).filter(task => managed(task) && task.id !== taskId && ['pending','running'].includes(task.status)).length * MEDIA_MAX_BYTES;
    assertStorageAvailable(root, { maxBytes: limit, usedBytes: bytes(files) + bytes(join(root, 'tmp')), reserveBytes: reserved + reserveBytes });
  }
  function directory(task) {
    if (!managed(task) || !/^[a-f0-9-]{36}$/.test(task.id)) throw new Error('任务未登记托管临时目录');
    return safe(join(root, 'tmp', task.id));
  }
  function output(task) {
    const path = safe(join(files, task.id + '.' + task.mediaRetention.format), files);
    if (!managed(task) || task.mediaRetention.logicalPath !== '/files/' + basename(path)) throw new Error('任务输出绑定无效');
    return path;
  }
  function binding(path) {
    return Object.values(tasks()).find(task => managed(task) && task.status === 'succeeded' && task.mediaRetention.ready === true && task.localOutput === path && output(task) === path && task.outputs?.[0]?.assetId === task.mediaRetention.assetId && task.outputs[0].url === '/creative-managed/media/' + task.mediaRetention.assetId);
  }
  function stamp(path) { const info = lstatSync(safe(path)); if (!info.isFile()) throw new Error('任务输出不是普通文件'); return { size:info.size, ino:info.ino, dev:info.dev, mtimeMs:info.mtimeMs }; }
  async function retire(task) {
    const path = output(task);
    if (!binding(path)) return;
    if (leases.get(path)) { pending.set(path, task); return; }
    if (existsSync(path)) {
      const actual = stamp(path), expected = task.mediaRetention.source;
      if (!expected || Object.keys(actual).some(key => actual[key] !== expected[key])) throw new Error('原输出已变化，保留文件待核对');
      await rm(path);
    }
    // Only this new, explicitly managed task's own scratch is eligible.
    await rm(directory(task), { recursive:true, force:true });
    pending.delete(path);
  }
  function lease(path) {
    leases.set(path, (leases.get(path) || 0) + 1);
    let released = false;
    return async () => {
      if (released) return; released = true;
      const count = leases.get(path) - 1;
      if (count) leases.set(path, count); else leases.delete(path);
      if (!count && pending.has(path)) await retire(pending.get(path));
    };
  }
  async function archive(task, mimeType) {
    const path = output(task);
    const asset = await archiveFile(path, { archiveKey:task.mediaRetention.archiveKey, assetType:'video', mimeType });
    if (!/^[A-Za-z0-9_-]+$/.test(asset.assetId || '') || !asset.uploadId || asset.fileUrl !== '/api/media/' + asset.assetId || asset.fileSize !== statSync(path).size) throw new Error('资产服务未返回原成片的完整就绪引用');
    return { assetId:asset.assetId, url:'/creative-managed/media/' + asset.assetId, mimeType:asset.mimeType };
  }
  function materialize(assetId, directoryPath, taskId) {
    const key=join(directoryPath,'asset-'+assetId);
    if(downloads.has(key)) return downloads.get(key);
    const work=download(assetId,directoryPath,taskId).finally(()=>downloads.delete(key));downloads.set(key,work);return work;
  }
  async function download(assetId, directoryPath, taskId) {
    if (!/^[A-Za-z0-9_-]+$/.test(assetId)) throw new Error('素材资产编号无效');
    const path = safe(join(directoryPath, 'asset-' + assetId));
    if (existsSync(path)) return path;
    admit(taskId);
    const response = await fetch(bridge + '/media/' + assetId);
    if (!response.ok || !response.body) throw new Error('成员素材读取失败');
    const length = response.headers.get('content-length');
    if (length !== null && (!Number.isSafeInteger(Number(length)) || Number(length) <= 0 || Number(length) > MEDIA_MAX_BYTES)) throw new Error('成员素材超出 512 MiB 限制');
    safe(path + '.partial');
    let received = 0;
    async function* chunks() {
      for await (const chunk of Readable.fromWeb(response.body)) {
        received += chunk.length;
        if (received > MEDIA_MAX_BYTES) throw new Error('成员素材超出 512 MiB 限制');
        admit(taskId, chunk.length);
        yield chunk;
      }
      if (!received || (length !== null && received !== Number(length))) throw new Error('成员素材未完整读取');
    }
    try { await pipeline(chunks(), createWriteStream(path + '.partial', { flags:'w' })); await rename(path + '.partial',path); }
    catch (error) { await rm(path + '.partial', { force:true }); throw error; }
    return path;
  }
  return { managed, safe, admit, directory, output, binding, stamp, retire, lease, archive, materialize };
}
