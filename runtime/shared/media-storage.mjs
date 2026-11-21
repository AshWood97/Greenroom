import { createReadStream, readdirSync, statSync, statfsSync, rmSync } from 'node:fs';
import { basename, dirname, resolve, join, extname } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

export const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 512 * 1024 * 1024;
export const CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const DISK_HEADROOM_BYTES = 5 * 1024 ** 3;
const broker = 'http://127.0.0.1:3081';
const validArchiveKey = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/[^A-Za-z0-9._:-]/.test(value);
const validOperation = (value, max) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);

export async function getArchiveOperation(operationId, { signal } = {}) {
  if (!validOperation(operationId, 160)) throw new Error('归档操作标识无效');
  const response = await fetch(`${broker}/api/media/upload-operations/${encodeURIComponent(operationId)}`, { signal });
  if (response.status === 404) return null;
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || `归档操作查询失败 (HTTP ${response.status})`);
  if (!result || !['init_unknown', 'initialized', 'put_unknown', 'put_complete', 'ready'].includes(result.state)) {
    throw new Error('归档操作状态无效，请保留原文件');
  }
  return result;
}

export function assertStorageAvailable(path, { reserveBytes = 0, maxBytes, usedBytes = 0 } = {}) {
  if (maxBytes !== undefined && usedBytes + reserveBytes > maxBytes) {
    throw new Error('本任务临时文件达到容量上限，请先完成已有任务或归档素材');
  }
  let existing = resolve(path);
  for (;;) {
    try { statSync(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || existing === dirname(existing)) throw error;
      existing = dirname(existing);
    }
  }
  const stats = statfsSync(existing);
  if (stats.bavail * stats.bsize - reserveBytes < DISK_HEADROOM_BYTES) {
    throw new Error('磁盘可用空间不足，需保留 5 GiB 运行余量；已有作品仍可读取和归档');
  }
}

export async function archiveStream(stream, { size, filename, assetType = 'document', mimeType, signal, archiveKey, contentSha256,
  operationId, operationTarget } = {}) {
  const cancelUnconsumed = async () => {
    if (typeof stream.destroy === 'function') stream.destroy();
    else if (typeof stream.cancel === 'function') {
      try { await stream.cancel(); } catch { /* preserve the original upload result or error */ }
    }
  };
  const limit = ['image', 'audio', 'video'].includes(assetType) ? MEDIA_MAX_BYTES : DOCUMENT_MAX_BYTES;
  if (!Number.isSafeInteger(size) || size <= 0 || size > limit) {
    throw new Error(`文件超出上传限制（${limit / 1024 / 1024} MiB）或大小无效`);
  }
  if (archiveKey !== undefined && !validArchiveKey(archiveKey)) {
    throw new Error('归档键无效');
  }
  if (archiveKey !== undefined && (typeof contentSha256 !== 'string' || contentSha256.length !== 64 || /[^a-f0-9]/.test(contentSha256))) {
    throw new Error('归档键须绑定有效内容 SHA-256');
  }
  if ((operationId !== undefined || operationTarget !== undefined) &&
      (!validOperation(operationId, 160) || !validOperation(operationTarget, 200) || archiveKey !== undefined)) {
    await cancelUnconsumed();
    throw new Error('归档操作标识或目标无效');
  }
  const name = basename(filename || 'asset');
  mimeType ||= { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': assetType === 'audio' ? 'audio/webm' : 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[extname(name).toLowerCase()] || 'application/octet-stream';
  if (operationId !== undefined) {
    let existing;
    try { existing = await getArchiveOperation(operationId, { signal }); }
    catch (error) { await cancelUnconsumed(); throw error; }
    if (existing) {
      const declaredMime = mimeType.split(';')[0];
      const acceptedMime = declaredMime === 'audio/x-wav' ? 'audio/wav' : declaredMime;
      const mime = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
        'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac'].includes(acceptedMime)
        ? acceptedMime : 'application/octet-stream';
      if (existing.target !== operationTarget || existing.fileName !== name || existing.fileSize !== size ||
          existing.mimeType !== mime || existing.assetType !== assetType) {
        await cancelUnconsumed();
        throw new Error('归档操作标识已绑定其他目标或文件');
      }
      if (existing.state === 'ready' && existing.result?.assetId) {
        await cancelUnconsumed();
        return existing.result;
      }
      if (existing.state !== 'initialized') {
        await cancelUnconsumed();
        throw new Error('归档结果尚待确认，请保留原文件并按原操作查询');
      }
    }
  }
  let received = 0;
  async function* content() {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      received += chunk.byteLength;
      if (received > size) throw new Error('文件大小在上传期间发生变化');
      yield chunk;
    }
    if (received !== size) throw new Error('文件尚未完整上传');
  }
  const uploadPath = operationId === undefined ? '/api/media/uploads' : '/api/media/stable-uploads';
  const response = await fetch(broker + uploadPath, {
    method: 'POST', duplex: 'half', signal,
    headers: { 'X-File-Name': encodeURIComponent(name), 'X-Asset-Type': assetType,
      'Content-Type': mimeType, 'Content-Length': String(size),
      ...(archiveKey === undefined ? {} : { 'X-Greenroom-Archive-Key': archiveKey, 'X-Greenroom-Archive-SHA256': contentSha256 }),
      ...(operationId === undefined ? {} : { 'X-Greenroom-Archive-Operation': operationId, 'X-Greenroom-Archive-Target': operationTarget }) },
    body: Readable.from(content()),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.assetId) {
    throw new Error(result?.error?.message || result?.error || result?.message || `资产归档失败 (HTTP ${response.status})`);
  }
  return result;
}

export async function archiveFile(path, options = {}) {
  const info = statSync(path);
  if (!info.isFile()) throw new Error('待归档的媒体不是普通文件');
  if (options.archiveKey !== undefined && (options.operationId !== undefined || options.operationTarget !== undefined)) {
    throw new Error('归档键与归档操作不能同时使用');
  }
  // Only keyed uploads need this content identity. The server compares both
  // the declared digest and actual streamed bytes before finalize/replay success.
  if (options.archiveKey !== undefined) {
    options.signal?.throwIfAborted();
    if (!validArchiveKey(options.archiveKey)) throw new Error('归档键无效');
    const limit = ['image', 'audio', 'video'].includes(options.assetType) ? MEDIA_MAX_BYTES : DOCUMENT_MAX_BYTES;
    if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > limit) throw new Error('文件超出上传限制或大小无效');
    const digest = createHash('sha256');
    let received = 0;
    for await (const chunk of createReadStream(path)) {
      options.signal?.throwIfAborted();
      received += chunk.byteLength;
      if (received > info.size) throw new Error('文件大小在归档预读期间发生变化');
      digest.update(chunk);
    }
    if (received !== info.size) throw new Error('文件大小在归档预读期间发生变化');
    options = { ...options, contentSha256: digest.digest('hex') };
  }
  return archiveStream(createReadStream(path), { filename: basename(path), ...options, size: info.size });
}

// Only pass a dedicated cache of archived, reproducible media. Durable works and
// task directories are never pruned by this function.
export function pruneCache(root, { maxBytes = CACHE_MAX_BYTES, activePaths = [] } = {}) {
  const active = activePaths.map((path) => resolve(path));
  const entries = [];
  const visit = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) visit(path);
      else if (item.isFile()) {
        const info = statSync(path);
        entries.push({ path, bytes: info.size, modified: info.mtimeMs });
      }
    }
  };
  try { visit(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let total = entries.reduce((sum, item) => sum + item.bytes, 0);
  for (const entry of entries.sort((a, b) => a.modified - b.modified)) {
    if (total <= maxBytes) break;
    if (active.some((path) => entry.path === path || entry.path.startsWith(path + '/'))) continue;
    rmSync(entry.path);
    total -= entry.bytes;
  }
  return total;
}
