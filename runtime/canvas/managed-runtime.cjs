'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { buildManagedRequest, managedOrder, managedDependencies, managedNodeDefaults, managedResultPatch, managedRelayPatch, collectManagedMaterials, MANAGED_RELAY_TYPES } = require('./greenroomExecution');

const BROKER = 'http://127.0.0.1:3081';
const MODEL_BROKER = BROKER + '/plugin/t8';
const ACTIVE = new Set(['queued', 'running', 'polling']);
const assetPath = (value) => String(value || '').replace(/^https?:\/\/127\.0\.0\.1:3081/, '').replace(/^\/canvas(?=\/api\/media\/)/, '');
const isAsset = (value) => /^\/api\/media\/[^/?#]+$/.test(assetPath(value));
let singleton;
const MEDIA_WORK_MAX = 512 * 1024 * 1024;
let reservedUploadBytes = 0;
let uploads = 0;
let mediaCacheRoots = [];
// This backend answers for its own member and its own process. A scale-down is
// confirmed against the instance that really holds the managed runs, so the id
// is fresh on every process start: a pid, a stable env value or a pod name
// would let a restarted backend reuse a confirmation it can no longer honour.
const memberId = process.env.MEMBER_ID || '';
const instanceId = crypto.randomUUID();
// The current drain and latest coordinator reopen epoch. Retaining the latter
// after opening prevents a delayed older control request changing this gate.
let drainEpoch = 0;
let reopenEpoch = 0;
// Set while a drain is closing new business entry points. A restart clears it,
// which is why a reopen must name the current epoch explicitly before this
// backend accepts work again.
let draining = false;
const drainBody = (body) => typeof body?.member_id === 'string' && body.member_id === memberId && memberId
  && Number.isInteger(body.epoch) && body.epoch >= 1 && body.instance_id === instanceId
  && body.epoch >= drainEpoch && body.epoch > reopenEpoch ? body.epoch : null;
const reopenBody = (body) => {
  if (typeof body?.member_id !== 'string' || body.member_id !== memberId || !memberId
    || !Number.isInteger(body.epoch) || body.epoch < 1 || body.instance_id !== instanceId) return null;
  if ((drainEpoch && body.epoch <= drainEpoch) || body.epoch < reopenEpoch) return null;
  reopenEpoch = body.epoch;
  return body.epoch;
};
// New submissions close during a drain. A task query, a run's own status and
// the completion of an original task keep working so durable work can finish.
const canvasClosed = (req) => draining && ['/api/greenroom/runs', '/api/greenroom/compose'].includes(req.path?.split('?')[0]);

async function prepareMediaWrite(directory, reserveBytes = MEDIA_WORK_MAX) {
  const storage = await import('./greenroom-media-storage.mjs');
  for (const root of mediaCacheRoots) storage.pruneCache(root, { maxBytes: 64 * 1024 * 1024 });
  storage.assertStorageAvailable(directory, { reserveBytes });
}

async function reserveUpload(directory, req) {
  const storage = await import('./greenroom-media-storage.mjs');
  const bytes = Math.min(MEDIA_WORK_MAX, Math.max(1, Number(req.headers['content-length']) || MEDIA_WORK_MAX));
  storage.assertStorageAvailable(directory, { reserveBytes: bytes + reservedUploadBytes,
    usedBytes: directoryBytes(directory), maxBytes: MEDIA_WORK_MAX });
  reservedUploadBytes += bytes;
  // A running upload is real work on this backend: the drain confirmation
  // counts it, so an upload in flight keeps the member awake until it ends.
  uploads += 1;
  let held = true;
  const release = () => {
    if (held) { held = false; reservedUploadBytes -= bytes; uploads -= 1; }
  };
  req.once('aborted', release);
  req.res.once('finish', release);
  req.res.once('close', release);
}

function directoryBytes(directory) {
  if (!directory || !fs.existsSync(directory)) return 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += directoryBytes(name);
    else if (entry.isFile()) bytes += fs.statSync(name).size;
  }
  return bytes;
}

function mediaWorkBytes(job) {
  if (!job?.greenroomWorkDir) return 0;
  return directoryBytes(job.greenroomWorkDir)
    + [...(job.greenroomOutputPaths || [])].filter((name) => !name.startsWith(job.greenroomWorkDir + path.sep))
      .reduce((sum, name) => sum + (fs.existsSync(name) ? fs.statSync(name).size : 0), 0);
}

function checkMediaWork(job) {
  if (!job?.greenroomWorkDir) return;
  const bytes = mediaWorkBytes(job);
  const stat = fs.statfsSync(job.greenroomWorkDir);
  if (bytes >= MEDIA_WORK_MAX || Number(stat.bavail) * Number(stat.bsize) < 5 * 1024 ** 3) {
    throw new Error(bytes >= MEDIA_WORK_MAX ? '本次视频处理超过 512 MiB 临时空间上限' : '磁盘剩余空间不足，已停止写入并保留已有作品');
  }
}

function replaceUrl(value, previous, next) {
  if (typeof value === 'string') return value === previous ? next : value;
  if (Array.isArray(value)) return value.map((item) => replaceUrl(item, previous, next));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceUrl(item, previous, next)]));
  return value;
}

function replaceLegacyReferences(database, previous, next) {
  const canvases = database.db.prepare('SELECT canvas_id FROM canvas_documents WHERE snapshot_json LIKE ?').all('%' + previous + '%');
  for (const row of canvases) {
    const document = database.getCanvas(row.canvas_id);
    const operations = document.nodes.flatMap((node) => {
      const data = replaceUrl(node.data, previous, next);
      return JSON.stringify(data) === JSON.stringify(node.data) ? [] : [{ type: 'node.patch', payload: { nodeId: node.id, dataPatch: data },
        actorId: 'local-owner', sessionId: 'greenroom-asset-archive', baseRevision: document.revision }];
    });
    if (operations.length) database.applyOperations(document.canvasId, operations, { expectedRevision: document.revision });
  }
  for (const row of database.db.prepare('SELECT id FROM runs WHERE summary_json LIKE ?').all('%' + previous + '%')) {
    const run = database.getRun(row.id);
    if (run.summary?.greenroomExecution) database.updateRun(run.id, { summary: replaceUrl(run.summary, previous, next) });
  }
}

async function archiveIndexedFile(indexer, filename, options = {}) {
  const absolute = path.resolve(filename);
  const rootName = options.rootName || 'output';
  const root = rootName === 'input' ? indexer.config.INPUT_DIR : indexer.config.OUTPUT_DIR;
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('业务素材路径不在当前画布目录');
  const legacyUrl = options.sourceUrl || `/files/${rootName}/` + relative.split(path.sep).map(encodeURIComponent).join('/');
  const existing = indexer.database.db.prepare('SELECT id FROM assets WHERE source_url = ? OR json_extract(metadata_json, \'$.greenroomLegacyUrl\') = ? LIMIT 1').get(legacyUrl, legacyUrl);
  const previous = existing && indexer.database.getAsset(existing.id);
  if (previous && isAsset(previous.sourceUrl)) return previous;
  const extension = path.extname(absolute).toLowerCase();
  const kind = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/.test(extension) ? 'image'
    : /\.(mp4|webm|mov|mkv|m4v)$/.test(extension) ? 'video' : /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(extension) ? 'audio' : 'text';
  const storage = await import('./greenroom-media-storage.mjs');
  const media = await storage.archiveFile(absolute, { filename: options.filename || path.basename(absolute), assetType: kind === 'text' ? 'document' : kind, signal: options.signal });
  const asset = indexer.database.withProjectDatabaseWrite('asset.greenroom.archive', () => {
    const saved = indexer.database.upsertAsset({ id: previous?.id || 'greenroom-' + crypto.randomUUID(),
      projectId: previous?.projectId || options.projectId, kind, filename: media.fileName, mimeType: media.mimeType,
      managedPath: null, sourceUrl: media.fileUrl, sourceLocator: previous?.sourceLocator || legacyUrl,
      storageMode: 'remote', availability: 'available', metadata: { ...(previous?.metadata || {}),
        assetId: media.assetId, size: media.fileSize, greenroomLegacyUrl: legacyUrl },
      provenance: previous?.provenance || { source: rootName === 'input' ? 'local-upload' : 'node-output' },
      createdBy: previous?.createdBy || options.creatorId || 'local-owner' });
    replaceLegacyReferences(indexer.database, legacyUrl, media.fileUrl);
    return saved;
  });
  // Referenced metadata has committed before removing the old local copy.
  fs.rmSync(absolute, { force: true });
  return asset;
}

async function archiveManagedOutput(indexer, raw) {
  if (isAsset(raw.sourceUrl)) return { ...raw, sourceUrl: assetPath(raw.sourceUrl) };
  if (typeof raw.text === 'string' && !raw.sourceUrl) {
    const storage = await import('./greenroom-media-storage.mjs');
    const bytes = Buffer.from(raw.text);
    const media = await storage.archiveStream(Readable.from([bytes]), { size: bytes.length, filename: raw.filename || 'canvas-text.txt', assetType: 'document' });
    return { ...raw, sourceUrl: media.fileUrl, mimeType: media.mimeType };
  }
  const match = /^\/(?:canvas\/)?files\/(input|output)\/(.+)$/.exec(String(raw.sourceUrl || ''));
  if (!match) throw new Error('生成产物必须使用已归档资产或当前画布业务文件');
  const root = match[1] === 'input' ? indexer.config.INPUT_DIR : indexer.config.OUTPUT_DIR;
  const asset = await archiveIndexedFile(indexer, path.join(root, decodeURIComponent(match[2])), { rootName: match[1] });
  return { ...raw, sourceUrl: asset.sourceUrl, mimeType: asset.mimeType };
}

async function archiveProjectAsset(indexer, asset) {
  if (isAsset(asset.sourceUrl)) return asset;
  const filename = asset.managedPath && path.resolve(asset.managedPath);
  if (!filename) return asset;
  const roots = [indexer.config.INPUT_DIR, indexer.config.OUTPUT_DIR, indexer.config.ASSET_BLOB_DIR].map((root) => path.resolve(root));
  if (!roots.some((root) => filename.startsWith(root + path.sep))) throw new Error('素材不在当前成员业务存储目录');
  const storage = await import('./greenroom-media-storage.mjs');
  const media = await storage.archiveFile(filename, { filename: asset.filename, assetType: ['image', 'video', 'audio'].includes(asset.kind) ? asset.kind : 'document' });
  const saved = indexer.database.withProjectDatabaseWrite('asset.greenroom.migrate', () => {
    const result = indexer.database.upsertAsset({ ...asset, managedPath: null, storageMode: 'remote', availability: 'available',
      sourceUrl: media.fileUrl, metadata: { ...asset.metadata, assetId: media.assetId, greenroomLegacyUrl: asset.sourceUrl,
        ...(asset.kind === 'image' ? { thumbnailUrl: media.fileUrl } : {}) } });
    if (asset.sourceUrl) replaceLegacyReferences(indexer.database, asset.sourceUrl, media.fileUrl);
    replaceLegacyReferences(indexer.database, `/api/project-assets/${encodeURIComponent(asset.id)}/media`, media.fileUrl);
    return result;
  });
  const referenced = indexer.database.db.prepare('SELECT 1 FROM assets WHERE managed_path = ? LIMIT 1').get(filename);
  if (!referenced && (!asset.contentHash || indexer.database.assetBlobReferenceCount(asset.contentHash) === 0)) fs.rmSync(filename, { force: true });
  return saved;
}

async function migrateGraphInputs(indexer, graph, canContinue) {
  const urls = new Set();
  const collect = (value) => {
    if (typeof value === 'string' && /^\/(?:canvas\/)?files\/(input|output)\//.test(value)) urls.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  graph.nodes.forEach((node) => collect(node.data));
  for (const sourceUrl of urls) {
    if (!canContinue()) return;
    const output = await archiveManagedOutput(indexer, { sourceUrl });
    if (!canContinue()) return;
    Object.assign(graph, replaceUrl(graph, sourceUrl, output.sourceUrl));
  }
}

function readLegacyMedia(config, directory, req, res, next) {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  const parsed = /^\/(?:files\/)?(input|output)\/(.+)$/.exec(req.originalUrl.split('?')[0]);
  if (!parsed) return next();
  const localUrl = `/files/${parsed[1]}/${parsed[2]}`;
  const runtime = require('./routes/projectRuns').getRuntime();
  const row = runtime.database.db.prepare("SELECT id FROM assets WHERE json_extract(metadata_json, '$.greenroomLegacyUrl') = ? LIMIT 1").get(localUrl);
  const asset = row && runtime.database.getAsset(row.id);
  if (asset && isAsset(asset.sourceUrl)) return res.redirect(302, asset.sourceUrl);
  const local = path.resolve(directory, decodeURIComponent(parsed[2]));
  const relative = path.relative(path.resolve(directory), local);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(local) || !fs.statSync(local).isFile()) return next();
  archiveIndexedFile(runtime.assetIndexer, local, { rootName: parsed[1] })
    .then((saved) => res.redirect(302, saved.sourceUrl), (error) => res.status(502).json({ success: false, error: error.message }));
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  let body;
  try { body = await response.json(); } catch { throw new Error(`业务服务返回非 JSON 响应（HTTP ${response.status}）`); }
  if (!response.ok || body.success === false || body.error) throw Object.assign(new Error(
    typeof body.error === 'string' ? body.error : body.error?.message || body.message || `业务请求失败（HTTP ${response.status}）`,
  ), { httpStatus: response.status, code: body.code || body.error?.code });
  return body.data === undefined ? body : body.data;
}

function outputAssets(database, nodeRun) {
  return (nodeRun.outputRefs || []).map((id) => database.getAsset(id)).filter(Boolean).map((asset) => ({
    sourceUrl: asset.sourceUrl || '', text: asset.metadata?.text || '', kind: asset.kind,
    filename: asset.filename, mimeType: asset.mimeType,
  }));
}

async function managedOutputMime(sourceUrl, signal, kind) {
  if (!isAsset(sourceUrl)) throw new Error('托管产物必须使用当前成员已归档资产');
  const response = await fetch(BROKER + assetPath(sourceUrl), { signal, redirect: 'error' });
  try {
    if (!response.ok) throw new Error(`产物归档读取失败（HTTP ${response.status}），保留原任务编号`);
    const contentType = String(response.headers.get('content-type') || '');
    const mimeType = contentType.split(';')[0].trim().toLowerCase();
    if (contentType.includes(',') || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
      || (['image', 'video', 'audio'].includes(kind) && !mimeType.startsWith(kind + '/'))
      || (kind === 'text' && mimeType !== 'application/octet-stream' && !mimeType.startsWith('text/'))) {
      throw new Error('产物归档读取缺少匹配的有效媒体类型，保留原任务编号');
    }
    return mimeType;
  } finally { await response.body?.cancel(); }
}

// Company assets are already durable. Register their controlled references in
// the existing run ledger without downloading them into T8's local CAS.
async function commitManagedOutputs(indexer, input) {
  const { database } = indexer;
  const run = database.getRun(input.runId), node = database.getNodeRun(input.nodeRunId), attempt = database.getAttempt(input.attemptId);
  if (!run || !node || !attempt || node.runId !== run.id || attempt.nodeRunId !== node.id) throw new Error('产物不属于当前画布运行');
  const outputs = [];
  for (const original of input.outputs || []) {
    const raw = await archiveManagedOutput(indexer, original);
    const sourceUrl = assetPath(raw.sourceUrl);
    if (!isAsset(sourceUrl)) throw new Error('托管产物必须先归档到成员资产服务');
    const mimeType = await managedOutputMime(sourceUrl, input.signal, raw.kind);
    outputs.push({ ...raw, sourceUrl, mimeType, storageMode: 'remote', availability: 'available',
      metadata: { ...(raw.metadata || {}), assetId: decodeURIComponent(sourceUrl.slice('/api/media/'.length)) } });
  }
  return database.withProjectDatabaseWrite('run.greenroom.outputs', () => {
    const recorded = database.recordRunOutputAssets({ ...input, outputs });
    const terminal = input.recoveryTerminal ? database.completeRecoveredRunAttempt(input.recoveryTerminal) : null;
    return { ...recorded, run: terminal?.run || run, recoveryTerminal: terminal, duplicate: Boolean(terminal?.duplicate) };
  });
}

class GreenroomExecution {
  constructor(config, runtime) {
    this.config = config;
    this.runtime = runtime;
    this.database = runtime.database;
    this.active = new Map();
    this.closing = false;
    this.nodeCount = 0;
    this.nodeWaiters = new Set();
  }

  async catalog() { return jsonRequest(MODEL_BROKER + '/canvas/api/greenroom/models'); }

  patchNode(canvasId, nodeId, data) {
    const document = this.database.getCanvas(canvasId);
    const node = document?.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const result = this.database.applyOperations(canvasId, [{ type: 'node.patch', actorId: 'local-owner',
      sessionId: 'greenroom-managed-runtime', baseRevision: document.revision,
      payload: { nodeId, dataPatch: data } }], { expectedRevision: document.revision });
    this.runtime.collaborationGateway.broadcastHostCanvasUpdate?.(canvasId, result.document);
  }

  state(runId, resume = true) {
    let run = this.database.getRun(runId);
    if (!run?.summary?.greenroomExecution) throw Object.assign(new Error('托管画布运行不存在'), { httpStatus: 404 });
    // Keep recovery eligibility until a new owner can actually start.
    // An old owner may still be draining in-flight workers after a fault.
    if (resume && !this.closing && !this.active.has(runId) && run.status === 'interrupted') {
      const nodes = this.database.listNodeRuns(runId);
      const retryable = nodes.filter((node) => node.status === 'interrupted').map((node) => ({ node,
        attempt: this.database.listAttempts(node.id).at(-1) }));
      if (retryable.length && retryable.every(({ attempt }) => attempt?.error?.retryable
        && (attempt.upstreamTaskId || attempt.metadata?.greenroomTextResult))
        && !nodes.some((node) => ['failed', 'stopped'].includes(node.status))) {
        this.database.withProjectDatabaseWrite('run.greenroom.resume-result', () => {
          for (const { node, attempt } of retryable) {
            this.database.updateAttempt(attempt.id, { status: attempt.upstreamTaskId ? 'polling' : 'running', error: null });
            this.database.updateNodeRun(node.id, { status: attempt.upstreamTaskId ? 'polling' : 'running' });
          }
          run = this.database.updateRun(runId, { status: 'running', summary: { lastError: '' } });
        });
      } else if (retryable.length && !nodes.some((node) => ['failed', 'stopped'].includes(node.status))) {
        // An unknown sibling blocks replay of the graph, but must not block
        // recovery of other nodes with their own already-accepted task IDs.
        const accepted = nodes.flatMap((node) => {
          const attempt = this.database.listAttempts(node.id).at(-1);
          const openNode = ACTIVE.has(node.status) || (node.status === 'interrupted' && attempt?.error?.retryable);
          const openAttempt = ACTIVE.has(attempt?.status) || (attempt?.status === 'interrupted' && attempt.error?.retryable);
          return openNode && openAttempt && attempt?.upstreamTaskId
            && attempt.metadata?.recovery?.taskId === attempt.upstreamTaskId ? [node.id] : [];
        });
        if (accepted.length) {
          this.startAcceptedRecovery(runId, accepted);
          run = this.database.getRun(runId);
        }
      }
    }
    if (resume && ACTIVE.has(run.status)) this.start(runId);
    const byNode = new Map(this.database.listNodeRuns(runId).map((node) => [node.nodeId, node]));
    const nodes = run.summary.greenroomExecution.nodeIds.map((id) => byNode.get(id)).filter(Boolean);
    return { ...run, runId: run.id, summary: { ...run.summary, greenroomExecution: { ...run.summary.greenroomExecution, graph: undefined } },
      nodes: nodes.map((node) => ({ id: node.id, nodeId: node.nodeId, status: node.status,
        attempts: this.database.listAttempts(node.id).map(({ id, status, upstreamTaskId, error }) => ({ id, status, taskId: upstreamTaskId, error })),
        outputs: outputAssets(this.database, node),
        ...(this.database.listAttempts(node.id).at(-1)?.metadata?.greenroomRelayPatch
          ? { localResult: this.database.listAttempts(node.id).at(-1).metadata.greenroomRelayPatch } : {}) })) };
  }

  // Read a completed original run without resubmitting it. Older managed
  // recoveries omitted optional MIME metadata despite already-owned Assets.
  async readState(runId) {
    const run = this.database.getRun(runId);
    if (run?.summary?.greenroomExecution && run.status === 'succeeded') {
      const missing = [];
      for (const node of this.database.listNodeRuns(runId)) for (const id of node.outputRefs || []) {
        const asset = this.database.getAsset(id);
        if (!asset || asset.mimeType || asset.storageMode !== 'remote' || asset.availability !== 'available' || !isAsset(asset.sourceUrl)) continue;
        if (asset.metadata?.assetId !== decodeURIComponent(assetPath(asset.sourceUrl).slice('/api/media/'.length))) throw new Error('原运行素材归属信息不一致');
        missing.push({ node, asset, mimeType: await managedOutputMime(asset.sourceUrl, AbortSignal.timeout(10000), asset.kind) });
      }
      const pendingRepairs = () => {
        const pending = [];
        const currentRun = this.database.getRun(runId);
        if (currentRun?.entityUid !== run.entityUid || currentRun.revision !== run.revision || currentRun.status !== 'succeeded') throw new Error('原运行已变化，未更新媒体类型');
        for (const { node, asset, mimeType } of missing) {
          const currentNode = this.database.getNodeRun(node.id), current = this.database.getAsset(asset.id);
          if (currentNode?.entityUid !== node.entityUid || currentNode.revision !== node.revision || currentNode.status !== 'succeeded' || currentNode.runId !== runId || JSON.stringify(currentNode.outputRefs) !== JSON.stringify(node.outputRefs)
            || current?.entityUid !== asset.entityUid || current.projectId !== asset.projectId || current.sourceUrl !== asset.sourceUrl
            || current.contentRevision !== asset.contentRevision || current.contentHash !== asset.contentHash || current.sourceLocator !== asset.sourceLocator
            || current.kind !== asset.kind || current.storageMode !== 'remote' || current.availability !== 'available'
            || current.metadata?.assetId !== asset.metadata.assetId || (current.mimeType && current.mimeType !== mimeType)) {
            throw new Error('原运行素材已变化，未更新媒体类型');
          }
          if (!current.mimeType) pending.push({ id: current.id, projectId: current.projectId, mimeType });
        }
        return pending;
      };
      if (missing.length && pendingRepairs().length) this.database.withProjectDatabaseWrite('asset.greenroom.original-mime', () => {
        for (const input of pendingRepairs()) this.database.upsertAsset(input);
      });
    }
    return this.state(runId);
  }

  async create(input) {
    const document = this.database.getCanvas(String(input.canvasId || ''));
    if (!document) throw new Error('画布不存在');
    const submissionId = String(input.submissionId || '');
    if (submissionId) {
      const previous = this.database.listRuns({ canvasId: document.canvasId, limit: 500 })
        .find((run) => run.summary?.greenroomExecution?.submissionId === submissionId);
      if (previous) { this.start(previous.id); return this.state(previous.id); }
    }
    const graph = { nodes: document.nodes, edges: document.edges };
    const order = managedOrder(graph, input.nodeIds, input.includeDependencies !== false);
    if (!order.length) throw new Error('没有可执行的托管节点');
    for (const run of this.database.listRuns({ canvasId: document.canvasId, limit: 500 })) {
      if (ACTIVE.has(run.status) && run.summary?.greenroomExecution?.nodeIds.some((id) => order.includes(id))) {
        throw new Error(`节点已有运行任务 ${run.id}，请查询该任务`);
      }
    }
    const catalog = await this.catalog();
    // Validate the selected models before creating a durable run. Material
    // requirements are checked as upstream nodes finish.
    for (const id of order) {
      const node = graph.nodes.find((item) => item.id === id);
      if (['llm', 'image', 'video'].includes(node.type)) {
        const model = node.type === 'image' ? node.data?.apiModel : node.data?.model;
        if (!catalog[node.type].some((entry) => entry.id === model)) throw new Error(`模型 ${model || '未选择'} 未在当前平台开通`);
      }
    }
    const run = this.database.withProjectDatabaseWrite('run.greenroom.create', () => {
      const created = this.database.createRun({ canvasId: document.canvasId, projectId: document.projectId,
        canvasRevision: document.revision, initiatorId: 'local-owner', status: 'running', startedAt: Date.now(),
        summary: { greenroomExecution: { version: 1, submissionId, nodeIds: order, graph } } });
      for (const id of order) this.database.createNodeRun({ runId: created.id, nodeId: id, status: 'queued',
        inputSnapshot: { node: graph.nodes.find((item) => item.id === id) } });
      this.database.appendRunEvent(created.id, { type: 'run.running', payload: { status: 'running', managed: true } });
      return created;
    });
    this.start(run.id);
    return this.state(run.id);
  }

  start(runId) {
    if (this.closing || this.active.has(runId)) return;
    const controller = new AbortController();
    const promise = this.execute(runId, controller.signal).catch((error) => {
      if (this.closing) return;
      const run = this.database.getRun(runId);
      if (!run || !ACTIVE.has(run.status)) return;
      this.database.updateRun(runId, { status: 'interrupted', summary: { lastError: error.message } });
      this.runtime.collaborationGateway.broadcastHostRunState?.(this.database.getRun(runId));
    }).finally(() => this.active.delete(runId));
    this.active.set(runId, { promise, controller });
  }

  startAcceptedRecovery(runId, nodeIds) {
    if (this.closing || this.active.has(runId)) return;
    const { database } = this;
    const accepted = database.withProjectDatabaseWrite('run.greenroom.resume-accepted', () => {
      if (database.getRun(runId)?.status !== 'interrupted') return [];
      const restored = [];
      for (const nodeId of nodeIds) {
        const node = database.getNodeRun(nodeId);
        const attempt = node && database.listAttempts(node.id).at(-1);
        if (!attempt?.upstreamTaskId || attempt.metadata?.recovery?.taskId !== attempt.upstreamTaskId) continue;
        if (!(ACTIVE.has(node.status) || (node.status === 'interrupted' && attempt.error?.retryable))) continue;
        if (!(ACTIVE.has(attempt.status) || (attempt.status === 'interrupted' && attempt.error?.retryable))) continue;
        if (attempt.status === 'interrupted') database.updateAttempt(attempt.id, { status: 'polling', error: null });
        if (node.status === 'interrupted') database.updateNodeRun(node.id, { status: 'polling' });
        restored.push(node.id);
      }
      if (restored.length) database.updateRun(runId, { status: 'running' });
      return restored;
    });
    if (!accepted.length) return;
    const controller = new AbortController();
    const promise = this.recoverAccepted(runId, accepted, controller.signal)
      .finally(() => this.active.delete(runId));
    this.active.set(runId, { promise, controller });
  }

  async recoverAccepted(runId, nodeIds, signal) {
    const { database, runtime } = this;
    try {
      for (const nodeId of nodeIds) {
        if (this.closing || signal.aborted) return;
        const run = database.getRun(runId);
        const node = database.getNodeRun(nodeId);
        const attempt = node && database.listAttempts(node.id).at(-1);
        if (!ACTIVE.has(run?.status)) break;
        if (!ACTIVE.has(node?.status) || !ACTIVE.has(attempt?.status) || !attempt?.upstreamTaskId) continue;
        try {
          const graphNode = run.summary.greenroomExecution.graph.nodes.find((item) => item.id === node.nodeId);
          this.patchNode(run.canvasId, node.nodeId, { taskId: attempt.upstreamTaskId,
            ...(graphNode?.type === 'image' ? {} : { status: 'polling' }) });
          await runtime.recoveryManager.recoverTicket(this.ticket(runId, node.id, attempt.id));
          if (this.closing || signal.aborted) return;
          const currentRun = database.getRun(runId);
          const completed = database.getNodeRun(node.id);
          if (!['running', 'polling', 'queued', 'interrupted', 'succeeded'].includes(currentRun?.status)
            || completed?.status !== 'succeeded') continue;
          if (graphNode) this.patchNode(run.canvasId, node.nodeId, {
            ...managedResultPatch(graphNode.type, outputAssets(database, completed)), runId,
          });
        } catch (error) {
          if (this.closing || signal.aborted) return;
          const currentRun = database.getRun(runId);
          const currentNode = database.getNodeRun(node.id);
          const currentAttempt = database.getAttempt(attempt.id);
          if (!ACTIVE.has(currentRun?.status) || !ACTIVE.has(currentNode?.status) || !ACTIVE.has(currentAttempt?.status)) continue;
          database.updateAttempt(attempt.id, { status: 'interrupted',
            error: { kind: 'protocol', message: error.message, code: error.code || 'GREENROOM_EXECUTION_ERROR', retryable: true },
            metadata: { greenroomArchiveRetry: true } });
          database.updateNodeRun(node.id, { status: 'interrupted' });
        }
      }
    } finally {
      const current = database.getRun(runId);
      if (ACTIVE.has(current?.status)) {
        const nodes = database.listNodeRuns(runId);
        const status = nodes.every((node) => node.status === 'succeeded') ? 'succeeded'
          : nodes.some((node) => node.status === 'failed') ? 'failed' : 'interrupted';
        database.updateRun(runId, { status, finishedAt: Date.now() });
        runtime.collaborationGateway.broadcastHostRunState?.(database.getRun(runId));
      }
    }
  }

  resume() {
    for (const status of ACTIVE) for (const run of this.database.listRuns({ status, limit: 500 })) {
      if (run.summary?.greenroomExecution?.version === 1) this.start(run.id);
    }
    for (const run of this.database.listRuns({ status: 'interrupted', limit: 500 })) {
      if (run.summary?.greenroomExecution?.version === 1) this.state(run.id);
    }
  }

  async takeNodeSlot(signal) {
    while (this.nodeCount >= 3 && !signal.aborted && !this.closing) {
      await new Promise((resolve) => {
        const wake = () => {
          this.nodeWaiters.delete(wake);
          signal.removeEventListener('abort', wake);
          resolve();
        };
        this.nodeWaiters.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
    if (signal.aborted || this.closing) return false;
    this.nodeCount += 1;
    return true;
  }

  releaseNodeSlot() {
    this.nodeCount -= 1;
    for (const wake of this.nodeWaiters) wake();
  }

  async execute(runId, signal) {
    const { database, runtime } = this;
    const canContinue = () => !this.closing && !signal.aborted && ACTIVE.has(database.getRun(runId)?.status);
    if (!canContinue()) return;
    const run = database.getRun(runId);
    const graph = structuredClone(run.summary.greenroomExecution.graph);
    const ids = run.summary.greenroomExecution.nodeIds;
    const dependencies = managedDependencies(graph, ids);
    const pending = new Set(ids);
    const completed = new Set();
    const running = new Map();
    const halt = { stopped: false };
    await migrateGraphInputs(runtime.assetIndexer, graph, canContinue);
    for (const id of ids) {
      if (!canContinue()) return;
      const nodeRun = database.listNodeRuns(runId).find((item) => item.nodeId === id);
      if (!nodeRun) throw new Error(`运行记录缺少节点 ${id}`);
      if (nodeRun.status === 'succeeded') {
        const node = graph.nodes.find((item) => item.id === id);
        const patch = MANAGED_RELAY_TYPES.has(node.type)
          ? database.listAttempts(nodeRun.id).at(-1)?.metadata?.greenroomRelayPatch || managedRelayPatch(graph, id)
          : managedResultPatch(node.type, outputAssets(database, nodeRun));
        if (!canContinue()) return;
        Object.assign(node.data, patch);
        this.patchNode(run.canvasId, id, { ...patch, runId });
        completed.add(id);
        pending.delete(id);
      } else if (!ACTIVE.has(nodeRun.status)) halt.stopped = true;
    }
    try {
      while ((pending.size || running.size) && !this.closing && !signal.aborted) {
        if (!halt.stopped && ACTIVE.has(database.getRun(runId).status)) {
          for (const id of pending) if (dependencies[id].every((source) => completed.has(source))) {
            pending.delete(id);
            const promise = this.executeNode(runId, id, graph, signal, halt).then((succeeded) => {
              if (succeeded) completed.add(id);
              else halt.stopped = true;
            }).finally(() => running.delete(id));
            running.set(id, promise);
          }
        }
        if (!running.size) break;
        await Promise.race(running.values());
      }
      if (this.closing || signal.aborted) return;
      const current = database.getRun(runId);
      if (ACTIVE.has(current.status)) {
        const nodes = database.listNodeRuns(runId);
        const status = nodes.every((node) => node.status === 'succeeded') ? 'succeeded'
          : nodes.some((node) => node.status === 'failed') ? 'failed' : 'interrupted';
        database.updateRun(runId, { status, finishedAt: Date.now() });
      }
      runtime.collaborationGateway.broadcastHostRunState?.(database.getRun(runId));
    } catch (error) {
      // Close submission gates before waiting for sibling workers to settle.
      halt.stopped = true;
      const current = database.getRun(runId);
      if (current && ACTIVE.has(current.status)) {
        database.updateRun(runId, { status: 'interrupted', summary: { lastError: error.message } });
        runtime.collaborationGateway.broadcastHostRunState?.(database.getRun(runId));
      }
      throw error;
    } finally {
      // Stop responds immediately, but lifecycle ownership includes every
      // already-started worker until its original recovery/archive exits.
      await Promise.allSettled([...running.values()]);
    }
  }

  async executeNode(runId, nodeId, graph, signal, halt) {
    if (!await this.takeNodeSlot(signal)) return false;
    try {
      const { database, runtime } = this;
      const run = database.getRun(runId);
      if (halt.stopped || signal.aborted || !ACTIVE.has(run.status)) return false;
      let nodeRun = database.listNodeRuns(runId).find((item) => item.nodeId === nodeId);
      let node = graph.nodes.find((item) => item.id === nodeId);
      let attempt = database.listAttempts(nodeRun.id).at(-1);
      let request;
      try {
        node = graph.nodes.find((item) => item.id === nodeRun.nodeId);
        if (MANAGED_RELAY_TYPES.has(node.type)) {
          if (!attempt) attempt = database.createAttempt({ nodeRunId: nodeRun.id, provider: 'greenroom-local', status: 'running' });
          database.updateNodeRun(nodeRun.id, { status: 'running' });
          this.patchNode(run.canvasId, node.id, { status: 'running', error: '', runId });
          let patch;
          const video = node.type === 'frame-pair' && collectManagedMaterials(graph, node.id).find((item) => item.kind === 'video');
          if (video) {
            const prior = attempt.metadata?.greenroomFramePair;
            if (prior && prior.stage !== 'complete') throw new Error('FramePair 上次抽帧或上传中断，结果尚未确认；保留原记录，不自动重复执行');
            patch = prior?.patch || await require('./greenroom-frame-pair').extractFramePair({
              sourceUrl: video.url, directory: runtime.assetIndexer.config.OUTPUT_DIR, signal,
              checkpoint: async (state) => { attempt = database.updateAttempt(attempt.id, { metadata: { greenroomFramePair: state } }); },
            });
          } else patch = managedRelayPatch(graph, node.id);
          if (halt.stopped || this.closing || signal.aborted || !ACTIVE.has(database.getRun(runId).status)) return false;
          database.withProjectDatabaseWrite('run.greenroom.relay', () => {
            database.updateAttempt(attempt.id, { status: 'succeeded', metadata: { greenroomRelayPatch: patch } });
            database.updateNodeRun(nodeRun.id, { status: 'succeeded' });
          });
          Object.assign(node.data, patch);
          this.patchNode(run.canvasId, node.id, { ...patch, runId });
          return true;
        }
        const catalog = await this.catalog();
        if (halt.stopped || this.closing || signal.aborted || !ACTIVE.has(database.getRun(runId).status)) return false;
        request = buildManagedRequest(graph, node.id, catalog);
        if (!attempt) attempt = database.createAttempt({ nodeRunId: nodeRun.id, provider: 'greenroom',
          model: request.body.model, status: 'queued', metadata: { greenroomManaged: true } });
        if (request.kind === 'llm' && attempt.status !== 'queued' && !attempt.metadata?.greenroomTextResult) throw new Error('文本请求在上次运行中中断，无法确认结果；请明确重试此节点');
        database.updateNodeRun(nodeRun.id, { status: attempt.upstreamTaskId ? 'polling' : 'running' });
        this.patchNode(run.canvasId, node.id, { status: node.type === 'llm' || node.type === 'image' ? 'generating' : 'submitting', error: '', runId });
        if (request.kind === 'llm') {
          database.updateAttempt(attempt.id, { status: 'running', timestamps: { startedAt: Date.now() } });
          let result = attempt.metadata?.greenroomTextResult;
          if (!result) {
            const response = await jsonRequest(MODEL_BROKER + request.path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(request.body), signal });
            result = { text: String(response.choices?.[0]?.message?.content || ''), usage: response.usage };
            attempt = database.updateAttempt(attempt.id, { metadata: { greenroomTextResult: result } });
          }
          const text = result.text;
          if (!text) throw new Error('文本模型未返回内容');
          const storage = await import('./greenroom-media-storage.mjs');
          const bytes = Buffer.from(text);
          const media = await storage.archiveStream(Readable.from([bytes]), { size: bytes.length, filename: 'canvas-text.txt', assetType: 'document', signal });
          if (halt.stopped || this.closing || signal.aborted || !ACTIVE.has(database.getRun(runId)?.status)) return false;
          await runtime.recoveryManager.succeedTicket(this.ticket(runId, nodeRun.id, attempt.id), [{ kind: 'text', text,
            sourceUrl: media.fileUrl, filename: 'canvas-text.txt', mimeType: media.mimeType }], result.usage);
        } else {
          if (!attempt.upstreamTaskId) {
            database.updateAttempt(attempt.id, { status: 'running', timestamps: { submittedAt: Date.now() } });
            const submitted = await jsonRequest(MODEL_BROKER + request.path, { method: 'POST', headers: { 'Content-Type': 'application/json',
              'X-T8-Provider-Submission': `canvas:${runId}:${nodeRun.id}:${attempt.id}` }, body: JSON.stringify(request.body), signal });
            const taskId = submitted.taskId || submitted.id;
            if (!taskId) throw new Error('生成服务未返回任务编号');
            attempt = database.updateAttempt(attempt.id, { upstreamTaskId: taskId, status: 'polling', metadata: {
              recovery: { kind: request.kind === 'runninghub' ? 'runninghub' : request.kind, taskId,
                model: request.body.model, pollIntervalMs: 3000, maxPolls: 1200 } } });
          }
          if (halt.stopped || this.closing || signal.aborted || !ACTIVE.has(database.getRun(runId)?.status)) return false;
          this.patchNode(run.canvasId, node.id, { taskId: attempt.upstreamTaskId,
            ...(node.type === 'image' ? {} : { status: 'polling' }) });
          await runtime.recoveryManager.recoverTicket(this.ticket(runId, nodeRun.id, attempt.id));
        }
      } catch (error) {
        if (this.closing || signal.aborted) return false;
        const currentRun = database.getRun(runId);
        const currentNode = database.getNodeRun(nodeRun.id);
        // A sibling halt closes new work, not this in-flight request's receipt.
        // Preserve cancellation/terminal records, but record unknown submissions
        // even if the enclosing run was already interrupted by another worker.
        if (!currentRun || (!ACTIVE.has(currentRun.status) && currentRun.status !== 'interrupted')
          || !currentNode || !ACTIVE.has(currentNode.status)) return false;
        if (!attempt) attempt = database.createAttempt({ nodeRunId: nodeRun.id, provider: 'greenroom', status: 'running' });
        attempt = database.getAttempt(attempt.id);
        if (['succeeded', 'failed', 'stopped', 'cancelled'].includes(attempt?.status)) return false;
        const uncertain = Boolean(attempt.upstreamTaskId || attempt.metadata?.greenroomTextResult);
        const cause = { kind: uncertain ? 'protocol' : 'upstream', message: error.message, code: error.code || 'GREENROOM_EXECUTION_ERROR', retryable: uncertain };
        database.updateAttempt(attempt.id, { status: 'interrupted', error: cause,
          metadata: { greenroomArchiveRetry: uncertain } });
        database.updateNodeRun(nodeRun.id, { status: 'interrupted' });
        database.updateRun(runId, { summary: { lastError: error.message } });
        this.patchNode(run.canvasId, node.id, { status: 'error', error: error.message });
        halt.stopped = true;
        return false;
      }
      if (this.closing || signal.aborted) return false;
      nodeRun = database.getNodeRun(nodeRun.id);
      const currentStatus = database.getRun(runId)?.status;
      // Native recovery may complete the original run with its final node.
      // Allow that completed result, but never replay after stop/interruption.
      if (halt.stopped && nodeRun?.status !== 'succeeded') return false;
      if (!ACTIVE.has(currentStatus) && !(nodeRun?.status === 'succeeded'
        && (currentStatus === 'succeeded' || (halt.stopped && currentStatus === 'interrupted')))) return false;
      if (nodeRun.status !== 'succeeded') {
        const error = database.listAttempts(nodeRun.id).at(-1)?.error?.message || '生成未完成，保留任务编号';
        this.patchNode(run.canvasId, node.id, { status: 'error', error });
        database.updateRun(runId, { summary: { lastError: error } });
        halt.stopped = true;
        return false;
      }
      const patch = managedResultPatch(node.type, outputAssets(database, nodeRun));
      Object.assign(node.data, patch);
      this.patchNode(run.canvasId, node.id, { ...patch, runId });
      return !halt.stopped;
    } finally { this.releaseNodeSlot(); }
  }

  ticket(runId, nodeRunId, attemptId) { return { run: this.database.getRun(runId), nodeRun: this.database.getNodeRun(nodeRunId), attempt: this.database.getAttempt(attemptId) }; }

  cancel(runId) {
    // Read the original member-local record without starting/resuming work.
    const state = this.state(runId, false);
    if (['succeeded', 'failed', 'stopped', 'cancelled'].includes(state.status)) return state;
    this.active.get(runId)?.controller.abort();
    this.database.withProjectDatabaseWrite('run.greenroom.cancel', () => {
      for (const node of this.database.listNodeRuns(runId)) if (ACTIVE.has(node.status)) {
        for (const attempt of this.database.listAttempts(node.id)) if (ACTIVE.has(attempt.status)) this.database.updateAttempt(attempt.id, { status: 'stopped' });
        this.database.updateNodeRun(node.id, { status: 'stopped' });
        this.patchNode(state.canvasId, node.nodeId, { status: 'idle', error: '已停止后续执行；已受理的上游任务可能仍继续处理' });
      }
      this.database.updateRun(runId, { status: 'stopped', finishedAt: Date.now() });
    });
    return this.state(runId, false);
  }

  hasActiveWork() {
    for (const status of ACTIVE) {
      if (this.database.listRuns({ status, limit: 500 }).some((run) => run.summary?.greenroomExecution?.version === 1)) return true;
    }
    // A running upload or archive is real work on this backend even though no
    // run row exists for it yet.
    return this.active.size > 0 || uploads > 0;
  }

  close() { this.closing = true; for (const task of this.active.values()) task.controller.abort(); }
}

function getEngine(config, runtime) { return singleton ||= new GreenroomExecution(config, runtime); }

function installGreenroomCanvas(app, { config, getRuntime }) {
  mediaCacheRoots = [config.THUMBNAILS_DIR].filter(Boolean);
  const engine = () => getEngine(config, getRuntime());
  const handle = (fn) => async (req, res) => {
    try { res.json({ success: true, data: await fn(req) }); }
    catch (error) { res.status(error.httpStatus || 400).json({ success: false, error: error.message, ...(error.code ? { code: error.code } : {}) }); }
  };
  app.get('/api/greenroom/capabilities', handle(async () => ({ models: await engine().catalog(),
    nodes: ['text', 'upload', 'material-set', 'llm', 'image', 'video', 'output', 'frame-pair', 'greenroom-selected', 'director-storyboard'],
    nodeExecution: { 'director-storyboard': 'draft-only; explicit stable shot IDs; no managed generation or automatic hash-based import', text: 'frozen-graph-upstream-sync', 'material-set': 'frozen-graph-upstream-sync when opted in', output: 'headless-relay', 'frame-pair': 'member-asset-video-extraction; existing-frames when no video connected' },
    storyboardDrafts: { tool: 't8_canvas_import_storyboard_scripts', fields: ['id', 'title', 'prompt', 'durationSec'], durationSec: { min: 4, max: 15 }, mode: 'append-or-exact-id-replay', generationSupported: false },
    runninghub: [{ id: 'greenroom-rh-upscale', parameters: { inputVideo: '成员视频素材地址', model: ['max', 'high', 'medium', 'low'],
      resolution: ['720p', '1080p', '2k', '4k'], outputFps: ['1x', '2x', '3x', '4x', '24', '25', '30', '60'] } }],
    nodeParameters: { 'director-storyboard': [],
      text: ['prompt', 'text', 'textLocalPrompt', 'textUseUpstream'],
      'material-set': ['materialSetItems', 'materialSetKind', 'materialSetSyncUpstream', 'materialSetExcludedUpstream'],
      llm: ['model', 'userPrompt', 'system', 'temperature', 'maxTokens', 'pickedFiles'],
      image: ['apiModel', 'prompt', 'aspectRatio', 'sizeLevel', 'n', 'referenceImages', 'materialOrder'],
      video: ['model', 'prompt', 'ratio', 'duration', 'resolution', 'localRefImages', 'localRefVideos', 'localRefAudios', 'materialOrder'],
      output: ['pickKind', 'pickIndex', 'outputText', 'directOutputSingleSnapshot', 'directOutputText', 'directTextSegments',
        'directImageUrl', 'directImageUrls', 'directVideoUrl', 'directVideoUrls', 'directAudioUrl', 'directAudioUrls', 'hiddenMaterialUrls'],
      'frame-pair': ['firstFrameUrl', 'lastFrameUrl'],
      'greenroom-selected': ['rhToolsActiveAppId', 'paramValues', 'materialOrder'] } })));
  app.get('/api/greenroom/defaults/:type', handle(async (req) => managedNodeDefaults(req.params.type, await engine().catalog())));
  // Member sleep reuses this run ledger: an unfinished or unreadable run keeps
  // the member awake instead of dropping its original task.
  app.get('/api/greenroom/lifecycle', handle(async () => ({ known: true, busy: engine().hasActiveWork() })));
  app.get('/api/greenroom/instance', handle(async () => ({ member_id: memberId, instance_id: instanceId })));
  app.post('/api/greenroom/drain', handle(async (req) => {
    // Only this member, this exact drain epoch and this instance's own
    // identity may be confirmed closed and idle. Anything else — a different
    // member or epoch, a foreign or missing instance, or a run that is still
    // active — is not confirmed, so a readiness reply can never stand in.
    const epoch = drainBody(req.body);
    if (epoch === null) return { member_id: memberId, epoch: 0, instance_id: instanceId, closed: false, idle: false, confirmed: false };
    // New business entry points close first, so nothing can start behind the
    // idle check below.
    drainEpoch = epoch;
    draining = true;
    const busy = engine().hasActiveWork();
    return { member_id: memberId, epoch, instance_id: instanceId, closed: !busy, idle: !busy, confirmed: !busy };
  }));
  app.post('/api/greenroom/reopen', handle(async (req) => {
    // A closed-idle answer for the drain epoch is a different phase, so only
    // the reopen body's own member, epoch and instance finish a reopen.
    const epoch = reopenBody(req.body);
    if (epoch === null) return { member_id: memberId, epoch: 0, instance_id: instanceId, opened: false, confirmed: false };
    draining = false;
    drainEpoch = 0;
    return { member_id: memberId, epoch, instance_id: instanceId, opened: true, confirmed: true };
  }));
  // A closed epoch stops new runs and compositions here. Run queries, a run's
  // own status and stopping an in-flight run keep working.
  app.post('/api/greenroom/runs', handle((req) => {
    if (canvasClosed(req)) throw Object.assign(new Error('成员运行环境正在休眠，已停止受理新任务'), { httpStatus: 409 });
    return engine().create(req.body || {});
  }));
  app.get('/api/greenroom/runs', handle((req) => engine().database.listRuns({ canvasId: req.query.canvasId, limit: 100 })
    .filter((run) => run.summary?.greenroomExecution).map((run) => engine().state(run.id))));
  app.get('/api/greenroom/runs/:id', handle((req) => engine().readState(req.params.id)));
  app.delete('/api/greenroom/runs/:id', handle((req) => engine().cancel(req.params.id)));
  app.post('/api/greenroom/compose', handle(async (req) => {
    if (canvasClosed(req)) throw Object.assign(new Error('成员运行环境正在休眠，已停止受理新任务'), { httpStatus: 409 });
    const document = engine().database.getCanvas(String(req.body?.canvasId || ''));
    if (!document) throw new Error('画布不存在');
    const ids = Array.isArray(req.body.nodeIds) ? req.body.nodeIds : document.nodes.filter((node) => node.data?.videoUrl).map((node) => node.id);
    const clips = ids.map((id) => {
      const node = document.nodes.find((item) => item.id === id);
      const url = node?.data?.videoUrl || node?.data?.urls?.[0];
      if (!node || !isAsset(url)) throw new Error(`节点 ${id} 没有已归档的视频产物`);
      return { id, url: BROKER + assetPath(url), type: 'video' };
    });
    if (!clips.length) throw new Error('没有可合成的视频');
    return jsonRequest(`http://127.0.0.1:${config.PORT}/api/video-ops/compose`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips, settings: req.body.settings || {}, async: true }) });
  }));
  return { resume: () => engine().resume(), shutdown: () => singleton?.close() };
}

module.exports = { installGreenroomCanvas, commitManagedOutputs, archiveIndexedFile, prepareMediaWrite, checkMediaWork,
  archiveProjectAsset, reserveUpload, readLegacyMedia, directoryBytes, mediaWorkBytes, GreenroomExecution, isAsset, assetPath };
