import { mkdirSync, createWriteStream, constants } from 'node:fs';
import { rm, realpath, lstat, open, link } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { MEDIA_MAX_BYTES, archiveFile, archiveStream } from '../shared/media-storage.mjs';
import { formatGenerationError } from '../shared/generation-error.ts';
import { jsonRequest } from './creative-proxy.mjs';

// Member-owned capabilities; plugin adapters keep their native business state.
export function createCreativeCapabilities({ root, endpoint, brokerUrl, bridgeUrl, knowledgeRoot, memberId, pluginId, lifecycle }) {
  return {
    root, endpoint, brokerUrl: brokerUrl + '/plugin/' + pluginId, bridgeUrl, knowledgeRoot, memberId,
    request: (path, options) => {
      if (!endpoint) throw new Error('本套件没有独立业务服务');
      const request = () => jsonRequest(endpoint + path, options);
      return lifecycle ? lifecycle.run(request, { foreground: false }) : request();
    },
    canRestore: async () => {
      if (!lifecycle) return true;
      return await lifecycle.hasWork() && lifecycle.work.recover !== false;
    },
    chat: (body, signal) => jsonRequest(brokerUrl + '/v1/chat/completions', {
      body, signal, headers: { 'X-Greenroom-Plugin': pluginId },
    }),
    readSkillCatalog: async (signal) => (await jsonRequest(brokerUrl + '/creative/api/skill-catalog', { signal })).data,
    importAsset: async (assetId, signal, options = {}) => {
      if (!/^[A-Za-z0-9_-]+$/.test(assetId)) throw new Error('素材 ID 无效');
      if (options.preserveExisting && !/^[a-f0-9]{64}$/.test(options.contentSha256 || '')) throw new Error('恢复素材缺少原内容身份');
      const response = await fetch(brokerUrl + '/api/media/' + assetId, { signal });
      if (!response.ok) throw new Error(formatGenerationError({ message: '素材不可访问', httpStatus: response.status }));
      const mimeType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4',
        'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
        'audio/x-flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a', 'text/plain': 'txt', 'application/pdf': 'pdf' }[mimeType] || 'bin';
      const directory = options.destination ? dirname(resolve(options.destination)) : options.directory ? resolve(options.directory) : join(root, 'imported');
      const controlled = options.destination || options.directory;
      if (controlled && !directory.startsWith(resolve(root) + sep)) throw new Error('素材目标越过当前成员目录');
      if (controlled) {
        let current = resolve(root);
        if (await realpath(current) !== current) throw new Error('素材目标不能经过符号链接');
        for (const part of directory.slice(current.length + 1).split(sep)) {
          current = join(current, part);
          try { if (!(await lstat(current)).isDirectory()) throw new Error('素材目标不能经过符号链接'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(current); }
        }
      } else mkdirSync(directory, { recursive: true });
      const name = assetId + '.' + extension;
      const path = options.destination ? resolve(options.destination) : join(directory, name);
      if (controlled) {
        if (await realpath(directory) !== directory || await realpath(root) !== resolve(root)) throw new Error('素材目标不能经过符号链接');
        try { if ((await lstat(path)).isSymbolicLink()) throw new Error('素材目标不能为符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const maxBytes = options.maxBytes ?? MEDIA_MAX_BYTES;
      if (options.preserveExisting) {
        // The owner-scoped GET above remains mandatory. An unregistered local
        // file may be valuable: compare it, never replace it, even after a race.
        let existing;
        try {
          try { existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (existing) {
            const info = await existing.stat();
            if (!info.isFile() || info.size > maxBytes) throw new Error('原资产本地目标无效或超过容量，保留原件');
            const hash = createHash('sha256'); let received = 0;
            for await (const bytes of existing.createReadStream({ autoClose: false })) {
              received += bytes.length;
              if (received > maxBytes) throw new Error('原资产本地目标超过容量，保留原件');
              hash.update(bytes);
            }
            if (hash.digest('hex') !== options.contentSha256) throw new Error('原资产本地内容已改变，保留原件，不能覆盖恢复');
            await response.body?.cancel();
            return { path, name, mimeType, assetId };
          }
        } catch (error) { await response.body?.cancel(); throw error; }
        finally { await existing?.close(); }
      }
      const header = response.headers.get('content-length');
      const declared = header === null ? null : Number(header);
      if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes)) { await response.body?.cancel(); throw new Error('素材大小超出导入上限'); }
      let release;
      try { release = await options.admit?.(declared ?? maxBytes); } catch (error) { await response.body?.cancel(); throw error; }
      let received = 0;
      const hash = options.contentSha256 ? createHash('sha256') : null;
      async function* bounded() {
        for await (const chunk of Readable.fromWeb(response.body)) {
          received += chunk.byteLength;
          if (received > maxBytes || declared !== null && received > declared) throw new Error('素材大小超出导入上限');
          hash?.update(chunk);
          yield chunk;
        }
        if (declared !== null && received !== declared) throw new Error('素材尚未完整读取');
        if (hash && hash.digest('hex') !== options.contentSha256) throw new Error('原资产内容身份不匹配，拒绝恢复');
      }
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        await pipeline(Readable.from(bounded()), createWriteStream(temporary, { mode: 0o600, flags: 'wx' }), { signal });
        if (options.preserveExisting) {
          // link publishes only to an absent path, unlike rename. A target
          // appearing during download is preserved and the attempt refuses.
          await link(temporary, path); await rm(temporary);
        } else {
          const { rename } = await import('node:fs/promises');
          await rename(temporary, path);
        }
      } catch (error) { await rm(temporary, { force: true }); throw error; }
      finally { if (typeof release === 'function') await release(); }
      return { path, name, mimeType, assetId };
    },
    renderSubmit: async (body, signal) => {
      if (body.suiteId !== pluginId) throw new Error('渲染套件不匹配');
      let response, result;
      try {
        response = await fetch(brokerUrl + '/creative/api/render/jobs', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
        try { result = await response.json(); }
        catch { throw new Error('渲染服务返回非 JSON 响应，提交状态未知'); }
      } catch (error) {
        if (signal?.aborted) {
          const path = [body.suiteId, body.projectId, body.jobId].map(encodeURIComponent).join('/');
          await fetch(brokerUrl + '/creative/api/render/jobs/' + path, { method: 'DELETE',
            signal: AbortSignal.timeout(5_000) }).catch(() => {});
        }
        throw error;
      }
      if (response.status === 202 && result.waiting_memory === true) return result;
      if (result.waiting_memory === true) throw new Error('渲染等待状态未确认，提交状态未知');
      if (!response.ok || result.success === false) throw new Error(formatGenerationError({
        error: result.error, message: result.message, detail: result.detail, httpStatus: response.status,
      }));
      return result;
    },
    renderStatus: (body, signal) => {
      if (body.suiteId !== pluginId) throw new Error('渲染套件不匹配');
      const path = [body.suiteId, body.projectId, body.jobId].map(encodeURIComponent).join('/');
      return jsonRequest(brokerUrl + '/creative/api/render/jobs/' + path, { signal });
    },
    renderCancelWaiting: (body, signal) => {
      if (body.suiteId !== pluginId) throw new Error('渲染套件不匹配');
      const path = [body.suiteId, body.projectId, body.jobId].map(encodeURIComponent).join('/');
      return jsonRequest(brokerUrl + '/creative/api/render/jobs/' + path, { method: 'DELETE', signal });
    },
    archiveFile: async (path, options) => {
      const asset = await archiveFile(path, options);
      return { ...asset, url: asset.fileUrl || asset.url };
    },
    archiveFrom: async (path, options = {}) => {
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('产物路径无效');
      const response = await fetch(endpoint + path, { signal: options.signal });
      if (!response.ok) throw new Error(formatGenerationError({ message: '插件产物读取失败', httpStatus: response.status }));
      const asset = await archiveStream(response.body, {
        ...options, size: Number(response.headers.get('content-length')),
        mimeType: options.mimeType || response.headers.get('content-type'),
      });
      return { ...asset, url: asset.fileUrl || asset.url };
    },
    formatGenerationError,
    managedModels: async (signal) => (await jsonRequest(brokerUrl + '/creative/api/models', { signal, headers: { 'X-Greenroom-Plugin': pluginId } })).data,
    getSettings: async (signal) => (await jsonRequest(brokerUrl + '/creative/api/plugins/' + pluginId + '/settings', { signal })).data,
    submit: async (kind, body, submissionId, signal) => {
      if (!['image', 'video', 'tts', 'music'].includes(kind)) throw new Error('未配置该生成能力');
      const path = ['tts', 'music'].includes(kind) ? '/creative/api/' + kind + '/submit' : '/canvas/api/proxy/' + kind + '/submit';
      return (await jsonRequest(brokerUrl + path, {
        body, signal, headers: { 'X-T8-Provider-Submission': submissionId, 'X-Greenroom-Plugin': pluginId },
      })).data;
    },
    getTask: async (id, signal) => {
      const task = (await jsonRequest(brokerUrl + '/canvas/api/greenroom/tasks/' + encodeURIComponent(id), { signal })).data;
      if (task.error) task.error = formatGenerationError(task.error);
      return task;
    },
  };
}
