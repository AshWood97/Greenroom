import { mkdir, readFile, writeFile, rename, readdir, realpath, stat, lstat, readlink } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { generationErrorText } from '../../shared/generation-error.ts';
import { createAssetCache } from './asset-cache.mjs';

const text = { type: 'string', minLength: 1 };
const projectId = { ...text, pattern: '^[A-Za-z0-9_-]+$' };
const episode = { type: 'integer', minimum: 1 };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const now = () => new Date().toISOString();
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value,
  ...(value?.isError || value?.status === 'failed' ? { isError: true } : {}) });
const id = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('工程或素材编号无效');
  return value;
};
const inside = (root, name) => {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('仅可读取已登记的工程内路径');
  }
  const path = resolve(root, name);
  if (!path.startsWith(resolve(root) + sep)) throw new Error('路径不属于当前工程');
  return path;
};
async function existingFile(root, name) {
  const path = await realpath(inside(root, name));
  if (!path.startsWith(await realpath(root) + sep) || !(await stat(path)).isFile()) throw new Error('文件不属于当前工程');
  return path;
}
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}
async function optionalText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function files(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) names.push(...await files(root, name));
    else if (entry.isFile()) names.push(name);
  }
  return names.sort();
}

const parameterSchema = object({
  size: text, aspect_ratio: text, n: { type: 'integer', minimum: 1 }, seed: { type: 'integer' }, quality: text,
  duration: { type: 'number', exclusiveMinimum: 0 }, resolution: text, generate_audio: { type: 'boolean' },
  voice: text, speed: { type: 'number', minimum: 0.25, maximum: 4 },
  response_format: { type: 'string', enum: ['mp3', 'wav', 'flac', 'opus'] }, instrumental: { type: 'boolean' },
  entry: text, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 },
  fps: { type: 'number', exclusiveMinimum: 0 }, audioAssetId: projectId,
});
const bindingSchema = object({ assetId: projectId, slot: text, order: { type: 'integer', minimum: 1 },
  name: text, purpose: text, controls: text, prohibitedControls: text },
['assetId', 'slot', 'order', 'name', 'purpose', 'controls', 'prohibitedControls']);

/** Fixed business tools shared by the installed AIGC suites. */
export function suiteTools(config) {
  const keys = Object.keys(config.documents || {});
  const productionKinds = config.productionKinds || ['image', 'video', 'tts', 'music', 'render'];
  const document = { type: 'string', enum: keys };
  const ref = { projectId, document, episode };
  const job = object({ label: text, kind: { type: 'string', enum: productionKinds },
    prompt: { type: 'string' }, model: text, sourceDocument: document, sourceEntry: text, episode,
    referenceAssetIds: { type: 'array', items: projectId }, referenceBindings: { type: 'array', items: bindingSchema },
    parameters: parameterSchema }, ['label', 'kind', 'sourceDocument']);
  const tool = (name, description, schema) => ({ name: config.prefix + '_' + name, description, inputSchema: schema });
  const definitions = [
    tool('list_projects', '列出当前成员的私有创作工程。', object({})),
    tool('create_project', '创建当前套件的私有工程，保留原生文档格式。', object({ title: text }, ['title'])),
    tool('get_project', '读取工程、文档版本、素材及原任务状态；不会重新提交生成。', object({ projectId }, ['projectId'])),
    tool('read_document', '读取已注册的工程文档。', object(ref, ['projectId', 'document'])),
    tool('write_document', '保存工程文档并递增版本；输入变化使尚未执行的生产确认失效。',
      object({ ...ref, content: { type: 'string' }, accepted: { type: 'boolean' }, expectedRevision: { type: 'integer', minimum: 0 } }, ['projectId', 'document', 'content'])),
    tool('import_asset', '将当前成员已上传素材导入工程；只接收资产编号。', object({ projectId, assetId: projectId }, ['projectId', 'assetId'])),
    tool('read_knowledge', '列出或读取本套件只读知识、引用及模板；resource 只接受列出的资源名。', object({ resource: text })),
    tool('prepare_production', '准备并展示当前准确任务、模型、提示词全文、参考绑定、参数和输出；此步不生成。展示后须等待用户明确确认当前 jobId。',
      object({ projectId, jobs: { type: 'array', minItems: 1, items: job } }, ['projectId', 'jobs'])),
    tool('confirm_production', '仅在用户明确确认已展示的当前任务后调用。确认只可消费一次。',
      object({ projectId, jobId: projectId, confirmed: { type: 'boolean', const: true } }, ['projectId', 'jobId', 'confirmed'])),
    tool('execute_production', '消费当前确认后逐项提交。成功、失败或提交结果未知后均不能重用确认；重试须准备并确认新任务。',
      object({ projectId, jobId: projectId }, ['projectId', 'jobId'])),
    tool('get_production', '查询并恢复已保存任务，保留逐项失败及原任务编号；查询异常不重提生成。', object({ projectId, jobId: projectId }, ['projectId'])),
    tool('archive_project', '将本工程文档和媒体打包归档到当前成员资产。', object({ projectId }, ['projectId'])),
  ];
  for (const [key, script] of Object.entries(config.scripts || {})) {
    if (!script.hidden) definitions.push(tool(key, script.description || '运行本套件已注册的固定脚本。', script.inputSchema));
  }
  return [...definitions.filter((definition) => productionKinds.length || !/_(?:prepare|confirm|execute|get)_production$/.test(definition.name)), ...(config.extraTools || [])];
}

function scriptProcess(command, argv, cwd, signal) {
  return new Promise((accept, reject) => {
    const child = spawn(command, argv, { cwd, signal, shell: false,
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: cwd,
        PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', LANG: 'C.UTF-8' } });
    let stdout = '', stderr = '';
    const collect = (kind, chunk) => {
      if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      if (stdout.length + stderr.length > 2 * 1024 * 1024) child.kill();
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    let processError;
    child.on('error', error => { processError = error; if (!child.pid) reject(error); });
    // Abort emits error before close; keep the input lease until the child has exited.
    child.on('close', (exitCode) => processError ? reject(processError) : accept({ exitCode, stdout, stderr }));
  });
}

// Tar's gzip stream is limited before each disk write; partial/unknown archives
// are retained, never replaced on retry. This is not a native render output limit.
async function packProject(argv, path, limit, cwd, signal) {
  const sink = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  // Open exclusively before starting a writer, so a pending package is immutable.
  await new Promise((accept, reject) => { sink.once('open', accept); sink.once('error', reject); });
  const child = spawn('tar', argv, { cwd, signal, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', processError, received = 0;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const closed = new Promise((accept, reject) => {
    child.on('error', error => { processError = error; if (!child.pid) reject(error); });
    child.on('close', code => processError ? reject(processError) : code === 0 ? accept() : reject(new Error(stderr || '工程打包失败')));
  });
  const bounded = new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length;
    callback(received > limit ? new Error('工程归档达到预留容量，原件及未完成包保留') : null, received > limit ? undefined : chunk);
  } });
  const copied = pipeline(child.stdout, bounded, sink).catch(error => { child.kill(); throw error; });
  const results = await Promise.allSettled([closed, copied]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
async function archiveReserve(directory, suiteId) {
  // GNU tar file/header/long-name blocks + final record padding, then a
  // conservative gzip expansion allowance. The writer separately enforces it.
  let bytes = 10240;
  const visit = async (path, prefix = '') => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      if (/^renders\/[^/]+\/input\/(?:core|vendor)(?:\/|$)/.test(name)
        || suiteId === 'hypit' && /^renders\/[^/]+\/output\/hypit-project\/(?:\.hypit\/runtimes|node_modules|packages)(?:\/|$)/.test(name)) continue;
      const info = await lstat(join(path, entry.name));
      bytes += 2048 + Math.ceil(Buffer.byteLength(name) / 512) * 512;
      if (entry.isDirectory()) await visit(join(path, entry.name), name);
      else if (entry.isFile()) bytes += Math.ceil(info.size / 512) * 512;
      else if (entry.isSymbolicLink()) bytes += 1024 + Math.ceil(Buffer.byteLength(await readlink(join(path, entry.name))) / 512) * 512;
      else throw new Error('工程归档不接受特殊文件');
    }
  };
  await visit(directory);
  return Math.ceil(bytes * 1.01) + 65536;
}

/**
 * ctx.root is already isolated by member and suite. Knowledge and executable
 * scripts always come from the image's fixed read-only knowledgeRoot.
 */
export async function createSuiteAdapter(ctx, config) {
  const root = resolve(ctx.root);
  const knowledgeRoot = resolve(ctx.knowledgeRoot || config.knowledgeRoot || '/opt/creative-skills/' + config.id);
  const projects = join(root, 'projects');
  const definitions = suiteTools(config);
  await mkdir(projects, { recursive: true });
  const cache = await createAssetCache({ root, suiteId: config.id, loadProject, download: ctx.importAsset });
  let queue = Promise.resolve(), closed = false, restoring;
  const runExclusive = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  const message = (error) => ctx.formatGenerationError(error instanceof Error
    ? { message: error.message, code: error.error_code ?? error.code, httpStatus: error.httpStatus ?? error.status } : error);
  const projectPath = (value) => join(projects, id(value));
  const projectExclusive = (value, fn) => config.withProjectLock ? config.withProjectLock(projectPath(value), fn) : fn();
  async function loadProject(value) {
    const project = JSON.parse(await readFile(join(projectPath(value), 'state.json'), 'utf8'));
    if (project.projectId !== value || project.suiteId !== config.id) throw new Error('当前套件没有此工程');
    return project;
  }
  async function saveProject(project) {
    const saved = await optionalText(join(projectPath(project.projectId), 'state.json'));
    project.revision = Math.max(project.revision || 0, saved ? JSON.parse(saved).revision : 0) + 1;
    project.updatedAt = now();
    await atomicJson(join(projectPath(project.projectId), 'state.json'), project);
    return project;
  }
  function documentName(args) {
    const definition = config.documents?.[args.document];
    let name = typeof definition === 'string' ? definition : definition?.path;
    if (!name) throw new Error('文档未在本套件注册');
    if (name.includes('{episode}')) {
      if (!Number.isInteger(args.episode) || args.episode < 1) throw new Error('该文档需要集数');
      name = name.replaceAll('{episode}', String(args.episode));
    }
    return name;
  }
  function invalidate(project) {
    for (const production of Object.values(project.productions)) {
      if (['prepared', 'confirmed'].includes(production.status)) {
        production.status = 'invalidated';
        production.invalidatedAt = now();
        delete production.confirmedAt;
      }
    }
  }
  async function readDocument(args) {
    const project = await loadProject(args.projectId);
    const name = documentName(args);
    const content = await optionalText(inside(projectPath(args.projectId), name));
    const entry = project.documents[name] || { revision: 0, accepted: false };
    return { document: args.document, ...(args.episode ? { episode: args.episode } : {}), path: name, content, ...entry };
  }
  async function writeDocument(args) {
    const project = await loadProject(args.projectId);
    const name = documentName(args);
    const entry = project.documents[name] || { revision: 0, accepted: false };
    if (args.expectedRevision !== undefined && args.expectedRevision !== entry.revision) throw new Error('文档版本已改变，请先读取当前内容');
    const path = inside(projectPath(args.projectId), name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, args.content, 'utf8');
    project.documents[name] = { revision: entry.revision + 1, accepted: args.accepted === true, updatedAt: now(),
      document: args.document, ...(args.episode ? { episode: args.episode } : {}) };
    invalidate(project);
    await saveProject(project);
    return readDocument(args);
  }
  async function importAsset(args, signal, recovery) {
    const project = await loadProject(args.projectId);
    id(args.assetId);
    if (project.assets[args.assetId]) {
      await cache.materialize(args.projectId, project.assets[args.assetId], signal);
      return project.assets[args.assetId];
    }
    const imported = await ctx.importAsset(args.assetId, signal, {
      directory: join(projectPath(args.projectId), 'media'), admit: cache.reserve,
      ...(recovery?.preserveExisting ? { preserveExisting: true, contentSha256: recovery.contentSha256, maxBytes: recovery.maxBytes } : {}),
    });
    const origin = await realpath(imported.path);
    const mediaRoot = await realpath(join(projectPath(args.projectId), 'media'));
    if (!origin.startsWith(mediaRoot + sep) || !(await stat(origin)).isFile()) throw new Error('素材不属于当前成员工程的受控缓存');
    const name = relative(projectPath(args.projectId), origin);
    const cacheSha256 = await cache.identity(origin);
    if (recovery?.preserveExisting && cacheSha256 !== recovery.contentSha256) throw new Error('原资产本地内容已改变，保留原件，不能恢复登记');
    const asset = { assetId: args.assetId, path: name, name: imported.name || args.assetId,
      mimeType: imported.mimeType, cacheManaged: true, cacheSha256 };
    project.assets[args.assetId] = asset;
    await saveProject(project);
    return asset;
  }
  async function archiveAudio(project, job, signal) {
    if (job.status !== 'archiving' || !job.archiveOperation) throw new Error('音频归档任务不存在');
    const path = await existingFile(projectPath(project.projectId), job.path);
    const unchanged = (info) => info.size === job.fileSize && info.ino === job.ino && info.mtimeMs === job.mtimeMs;
    if (!unchanged(await stat(path))) throw new Error('音频结果已改变，保留原文件');
    const asset = await ctx.archiveFile(path, { assetType: 'audio', mimeType: 'audio/wav', signal,
      operationId: job.archiveOperation, operationTarget: job.archiveOperation });
    if (!asset?.assetId) throw new Error('音频归档未返回原资产编号');
    if (!unchanged(await stat(path))) throw new Error('音频结果已改变，保留原文件');
    project.assets[asset.assetId] = { ...asset, path: job.path, name: job.operation + '.wav', mimeType: 'audio/wav' };
    job.assetId = asset.assetId;
    job.status = 'completed';
    delete job.archiveError;
    return project.assets[asset.assetId];
  }
  async function knowledge(args = {}) {
    const allowed = (await files(knowledgeRoot)).filter((name) =>
      /(?:^|\/)(?:SKILL\.md|LICENSE(?:\.[^/]*)?|NOTICE)$/.test(name)
      || /(?:^|\/)(?:references|templates|assets|data)\//.test(name)
      || (config.knowledgeFiles || []).includes(name));
    if (!args.resource) return { resources: allowed };
    if (!allowed.includes(args.resource)) throw new Error('知识资源未登记，请先列出资源');
    const path = await existingFile(knowledgeRoot, args.resource);
    const hypitSource = config.id === 'hypit' && /\.(?:svml|svs|svrun)$/i.test(path);
    if (!hypitSource && !/\.(?:md|txt|json|jsonl|yaml|yml|csv|tsv|html|css|svg|js|mjs|cjs|ts|py|sh)$/i.test(path) && !/(?:LICENSE|NOTICE)(?:\.[^/]*)?$/.test(path)) {
      return { resource: args.resource, mimeType: 'application/octet-stream', available: true, note: '该资源是只读媒体，不能作为已导入的成员参考素材。' };
    }
    return { resource: args.resource, content: await readFile(path, 'utf8') };
  }
  async function currentInputs(project, production) {
    for (const [name, snapshot] of Object.entries(production.inputs)) {
      const entry = project.documents[name];
      if (!entry?.accepted || entry.revision !== snapshot.revision || await optionalText(inside(projectPath(project.projectId), name)) !== snapshot.content) {
        production.status = 'invalidated';
        await saveProject(project);
        throw new Error('生产输入已改变，需要重新准备、展示并确认');
      }
    }
  }
  async function prepareProduction(args, signal) {
    let project = await loadProject(args.projectId);
    await cache.admit(0);
    if (!Array.isArray(args.jobs) || !args.jobs.length) throw new Error('生产任务不能为空');
    const productionKinds = config.productionKinds || ['image', 'video', 'tts', 'music', 'render'];
    if (args.jobs.some((job) => !productionKinds.includes(job.kind))) throw new Error('本套件未配置所选生产能力');
    if (config.beforePrepareProduction) await config.beforePrepareProduction(args, { ...api(signal), project });
    if (config.singleModality && new Set(args.jobs.map((job) => job.kind)).size !== 1) throw new Error('当前任务只允许一种生产模态');
    const settings = await ctx.getSettings(signal);
    const models = await ctx.managedModels(signal);
    const production = { jobId: randomUUID(), status: 'prepared', createdAt: now(), inputs: {}, jobs: [] };
    for (const incoming of args.jobs) {
      const job = { ...incoming, parameters: { ...(settings.parameters?.[incoming.kind] || {}), ...(incoming.parameters || {}) }, jobId: randomUUID(), status: 'prepared' };
      if (!['image', 'video', 'tts', 'music', 'render'].includes(job.kind)) throw new Error('生产模态无效');
      const doc = await readDocument({ projectId: args.projectId, document: job.sourceDocument, episode: job.episode });
      if (!doc.accepted || !doc.content?.trim()) throw new Error('先接受对应创作文档，再准备生产');
      if (job.kind !== 'render' && (!job.prompt?.trim() || !job.sourceEntry || !doc.content.includes(job.sourceEntry))) throw new Error('生产条目必须来自所选已接受文档，且包含完整提示词');
      production.inputs[doc.path] = { revision: doc.revision, content: doc.content };
      if (job.kind !== 'render') {
        const available = (settings.configured ? settings.models?.[job.kind] || [] : models[job.kind] || []).map((model) => typeof model === 'string' ? model : model.id);
        job.model = job.model || available[0];
        if (!job.model || !available.includes(job.model)) throw new Error(job.kind + ' 模型未由管理员配置或授权');
      }
      const assetIds = job.referenceAssetIds || [];
      job.referenceAssetIds = assetIds;
      if ((config.requireReferenceBindings && assetIds.length || job.referenceBindings?.length)
        && (!job.referenceBindings || job.referenceBindings.length !== assetIds.length)) throw new Error('参考素材必须逐张登记槽位、顺序、用途和控制范围');
      for (const [index, assetId] of assetIds.entries()) {
        id(assetId);
        await importAsset({ projectId: args.projectId, assetId }, signal);
        if (job.referenceBindings && (job.referenceBindings[index]?.assetId !== assetId || job.referenceBindings[index]?.order !== index + 1)) throw new Error('参考绑定与真实素材的顺序不符');
      }
      project = await loadProject(args.projectId);
      job.outputDirectory = job.kind === 'render' ? 'renders/' + job.jobId + '/output' : 'outputs/' + job.jobId;
      job.overwrite = false;
      job.quantity = job.kind === 'image' ? job.parameters.n || 1 : 1;
      job.cost = job.kind === 'render' ? '本地渲染，占用成员计算资源' : '使用管理员托管服务，按所选模型实际计费';
      if (config.validateProduction) await config.validateProduction(job, { ...api(signal), project, document: doc });
      if (job.kind === 'render') {
        if (!config.prepareRender) throw new Error('本套件未配置渲染能力');
        job.render = await config.prepareRender({ ...api(signal), project, job, production });
      } else job.request = bodyFor(job);
      production.jobs.push(job);
    }
    project = await loadProject(args.projectId);
    invalidate(project);
    project.productions[production.jobId] = production;
    project.currentProductionId = production.jobId;
    await saveProject(project);
    return production;
  }
  async function confirmProduction(args) {
    const project = await loadProject(args.projectId);
    const production = project.productions[args.jobId];
    if (args.confirmed !== true || project.currentProductionId !== args.jobId || production?.status !== 'prepared') throw new Error('只能确认已展示的当前准备任务');
    await currentInputs(project, production);
    production.status = 'confirmed';
    production.confirmedAt = now();
    await saveProject(project);
    return production;
  }
  function applyTask(job, task) {
    const taskId = task.taskId || task.id;
    if (!taskId) throw new Error('服务商未返回任务编号，提交结果未知；禁止自动重新提交');
    job.platformTaskId = taskId;
    job.taskStatus = task.status;
    job.status = ['succeeded', 'completed'].includes(task.status) ? 'archiving' : task.status === 'failed' ? 'failed' : task.status || 'pending';
    job.progress = task.progress;
    job.outputs = task.outputs || [];
    if (task.error || job.status === 'failed') job.error = message(task.error);
    else delete job.error;
    delete job.lastQueryError;
  }
  function bodyFor(job) {
    const body = { model: job.model, [job.kind === 'tts' ? 'text' : 'prompt']: job.prompt };
    const allowed = { image: ['size', 'aspect_ratio', 'n', 'seed'], video: ['duration', 'resolution', 'aspect_ratio', 'seed', 'generate_audio'],
      tts: ['voice', 'speed', 'response_format'], music: ['duration', 'instrumental'] }[job.kind];
    for (const key of allowed) if (job.parameters[key] !== undefined) body[key] = job.parameters[key];
    if (job.kind === 'image' && job.parameters.quality) body.providerParams = { quality: job.parameters.quality };
    if (job.referenceAssetIds.length) {
      if (!['image', 'video'].includes(job.kind)) throw new Error('当前模态不支持参考图');
      body[job.kind === 'image' ? 'reference_images' : 'reference_image_urls'] = job.referenceAssetIds.map((assetId) => '/api/media/' + assetId);
    }
    return body;
  }
  async function executeProduction(args, signal) {
    let project = await loadProject(args.projectId);
    const production = project.productions[args.jobId];
    if (project.currentProductionId !== args.jobId || production?.status !== 'confirmed') throw new Error('先展示并明确确认当前任务；重试须准备和确认新任务');
    await currentInputs(project, production);
    await cache.admit(0);
    if (config.beforeExecuteProduction) await config.beforeExecuteProduction(args, { ...api(signal), project, production });
    production.status = 'submitted';
    production.confirmationConsumedAt = now();
    await saveProject(project);
    for (const job of production.jobs) {
      job.status = 'submitting';
      job.submissionId = config.id + ':' + project.projectId + ':' + production.jobId + ':' + job.jobId;
      job.submittedAt = now();
      if (job.kind === 'render') job.renderSubmitted = true;
      await saveProject(project);
      try {
        if (job.kind === 'render') {
          const task = await ctx.renderSubmit({ suiteId: config.id, projectId: project.projectId, jobId: job.jobId }, signal);
          job.status = task.status || 'pending';
          if (task.waiting_memory === true) { job.status = 'queued'; job.memoryWaiting = true; }
          else delete job.memoryWaiting;
          if (task.error) job.error = message(task.error);
        } else applyTask(job, await ctx.submit(job.kind, job.request, job.submissionId, signal));
      } catch (error) {
        job.status = 'submission_unknown'; job.error = message(error);
        if (job.kind === 'render' && signal?.aborted) job.cancelRequested = true;
      }
      await saveProject(project);
    }
    return production;
  }
  async function recoveredHypitOutput(project, job, finished) {
    if (job.outputDirectory !== 'renders/' + id(job.jobId) + '/output') throw new Error('Hypit 原任务输出目录不匹配');
    const output = await realpath(join(projectPath(project.projectId), job.outputDirectory));
    if (!output.startsWith(await realpath(projectPath(project.projectId)) + sep)) throw new Error('Hypit 原任务输出不属于当前工程');
    const exportPath = join(output, 'hypit-project', 'greenroom-export.json');
    let exportInfo;
    try { exportInfo = await lstat(exportPath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!exportInfo.isFile() || await realpath(exportPath) !== exportPath) throw new Error('Hypit 原导出记录路径无效');
    const buildPath = join(output, 'hypit-project', 'greenroom-build.json');
    let buildInfo;
    try { buildInfo = await lstat(buildPath); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Hypit 原 Build 记录不可用'); throw error; }
    if (!buildInfo.isFile() || await realpath(buildPath) !== buildPath) throw new Error('Hypit 原 Build 记录路径无效');
    const build = JSON.parse(await readFile(buildPath, 'utf8'));
    const receipt = JSON.parse(await readFile(exportPath, 'utf8'));
    if (typeof build.id !== 'string' || !/^bld_[A-Za-z0-9_]+$/.test(build.id)
        || job.hypitBuildId && job.hypitBuildId !== build.id
        || finished?.hypitBuildId && finished.hypitBuildId !== build.id
        || receipt.version !== 1 || receipt.build !== build.id || receipt.output !== 'final.video'
        || !/^hypit-export-[A-Za-z0-9]+\/video\.mp4$/.test(receipt.path)
        || !Number.isSafeInteger(receipt.size) || receipt.size <= 0) throw new Error('Hypit 原导出记录与当前 Build 不匹配');
    const path = join(output, receipt.path);
    let file;
    try { file = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Hypit 原导出文件不可用'); throw error; }
    if (await realpath(path) !== path) throw new Error('Hypit 原导出路径不能使用符号链接');
    if (!file.isFile() || file.size !== receipt.size) throw new Error('Hypit 原导出文件不可用');
    return { status: 'completed', hypitBuildId: build.id, artifact: { path: receipt.path, mimeType: 'video/mp4' } };
  }
  async function archiveOutputs(project, job, signal, recovered) {
    if (job.kind === 'render') {
      const output = join(projectPath(project.projectId), job.outputDirectory);
      let finished = recovered;
      if (!finished) {
        let readError;
        try {
          const value = await optionalText(join(output, 'result.json'));
          finished = value === null ? null : JSON.parse(value);
        } catch (error) { readError = error; }
        if (config.id === 'hypit' && (finished?.status !== 'completed' || !finished.artifact?.path)) {
          const original = await recoveredHypitOutput(project, job, finished);
          if (original) { finished = original; readError = undefined; }
        }
        if (readError) throw readError;
      }
      if (!finished) throw new Error('渲染服务尚未返回真实成片');
      if (config.id === 'hypit' && finished.hypitBuildId) job.hypitBuildId = finished.hypitBuildId;
      if (config.id === 'hypit' && finished.status === 'unknown') { job.status = 'pending'; delete job.error; job.lastQueryError = message(finished.error); return; }
      if (finished.status === 'failed') { job.status = 'failed'; job.error = message(finished.error); return; }
      if (finished.status !== 'completed' || !finished.artifact?.path) throw new Error('渲染服务尚未返回真实成片');
      const local = await existingFile(output, finished.artifact.path);
      const operation = config.id === 'hypit' ? 'hypit:render:' + id(project.projectId) + ':' + id(job.jobId) : null;
      const asset = await ctx.archiveFile(local, { assetType: 'video', mimeType: finished.artifact.mimeType || 'video/mp4', signal,
        ...(operation ? { operationId: operation, operationTarget: operation } : {}) });
      job.outputs = [{ ...asset, projectPath: relative(await realpath(projectPath(project.projectId)), local) }];
    } else {
      if (!job.outputs?.length) throw new Error('服务商未返回可读取的产物');
      const outputs = [];
      for (const output of job.outputs) {
        if (!output.assetId) throw new Error('服务商未返回可读取的产物资产编号');
        const asset = await importAsset({ projectId: project.projectId, assetId: output.assetId }, signal);
        outputs.push({ ...output, projectPath: asset.path });
      }
      job.outputs = outputs;
    }
    job.status = 'completed';
    job.archivedAt = now();
    delete job.archiveError;
  }
  async function synchronize(projectId, signal, resume = false) {
    let project = await loadProject(projectId);
    for (const audio of project.audio || []) {
      if (audio.outputProtocol === 'atomic-v1' && ['processing', 'unknown'].includes(audio.status)) {
        try {
          const path = await existingFile(projectPath(projectId), audio.path);
          const info = await stat(path);
          Object.assign(audio, { status: 'archiving', fileSize: info.size, ino: info.ino, mtimeMs: info.mtimeMs });
          delete audio.archiveError;
        } catch (error) {
          if (audio.status !== 'unknown') {
            audio.status = 'unknown';
            audio.archiveError = error.code === 'ENOENT' ? '音频执行结果暂无法确认，保留原任务与临时文件，不会重新执行' : message(error);
            await saveProject(project);
          }
          continue;
        }
      }
      if (audio.status !== 'archiving' || !audio.archiveOperation) continue;
      try { await archiveAudio(project, audio, signal); }
      catch (error) { audio.archiveError = message(error); }
      await saveProject(project);
    }
    const productions = Object.values(project.productions);
    let changed = false;
    for (const production of productions) {
      for (const job of production.jobs) {
        let updated = false;
        if (job.status === 'submitting') {
          job.status = 'submission_unknown';
          job.error = message('上次提交未返回任务编号，结果未知；不会自动重新提交');
          updated = true;
        }
        if (resume && job.queryCount >= 120) { job.queryCount = 0; updated = true; }
        if ((job.platformTaskId || job.renderSubmitted) && (['pending', 'queued', 'running', 'processing', 'succeeded'].includes(job.status)
          || job.kind === 'render' && job.status === 'submission_unknown') && (job.memoryWaiting || (job.queryCount || 0) < 120)) {
          if (!job.memoryWaiting) job.queryCount = (job.queryCount || 0) + 1;
          updated = true;
          try {
            if (job.kind === 'render') {
              const body = { suiteId: config.id, projectId, jobId: job.jobId };
              let task = await ctx.renderStatus(body, signal);
              if (task.waiting_memory === true) {
                // Persist the confirmed waiting identity before another POST.
                // A lost response is resolved by querying the original ID.
                job.status = 'queued'; job.memoryWaiting = true; job.queryCount = 0;
                await saveProject(project);
                if (job.cancelRequested) {
                  const cancellation = await ctx.renderCancelWaiting(body, signal);
                  task = cancellation.cancelled === true
                    ? { status: 'cancelled', error: '已取消等待，未创建渲染任务' }
                    : null;
                  if (!task) job.lastQueryError = '取消状态尚未确认，继续查询原任务';
                } else {
                  try { task = await ctx.renderSubmit(body, signal); }
                  catch (error) { if (signal?.aborted) job.cancelRequested = true; throw error; }
                }
              }
              if (task) {
                job.status = task.status === 'succeeded' ? 'archiving' : task.status;
                if (task.waiting_memory === true) { job.status = 'queued'; job.memoryWaiting = true; }
                else delete job.memoryWaiting;
                if (task.error || task.status === 'failed') job.error = message(task.error);
                else delete job.error;
                delete job.lastQueryError;
              }
            } else applyTask(job, await ctx.getTask(job.platformTaskId, signal));
          } catch (error) { job.lastQueryError = message(error); }
        }
        if (job.status === 'archiving') {
          updated = true;
          try { await archiveOutputs(project, job, signal); }
          catch (error) { job.archiveError = message(error); }
        }
        if (job.kind === 'render' && job.status === 'failed') {
          let actualError;
          try {
            let finished = null, readError;
            try {
              const text = await optionalText(join(projectPath(projectId), job.outputDirectory, 'result.json'));
              finished = text === null ? null : JSON.parse(text);
            } catch (error) { readError = error; }
            const recovered = config.id === 'hypit' && (finished?.status !== 'completed' || !finished.artifact?.path)
              ? await recoveredHypitOutput(project, job, finished) : null;
            if (config.id === 'hypit' && (recovered || finished?.status === 'completed' && finished.artifact?.path)) {
              job.status = 'archiving'; delete job.error; updated = true;
              try { await archiveOutputs(project, job, signal, recovered || finished); }
              catch (error) { job.archiveError = message(error); }
            } else if (readError) {
              throw readError;
            } else if (config.id === 'hypit' && finished?.status === 'unknown') {
              job.status = 'pending'; delete job.error; job.hypitBuildId = finished.hypitBuildId || job.hypitBuildId;
              job.lastQueryError = message(finished.error); updated = true;
            } else if (finished) actualError = message(finished.error);
          } catch (error) {
            if (config.id === 'hypit' && error.code !== 'ENOENT') {
              job.status = 'pending'; delete job.error; job.lastQueryError = message(error); updated = true;
            } else if (error.code !== 'ENOENT') actualError = message(error);
          }
          if (actualError !== undefined && job.error !== actualError) { job.error = actualError; updated = true; }
        }
        if (updated) {
          // importAsset saves the same project independently; retain imported assets.
          project.assets = (await loadProject(projectId)).assets;
          await saveProject(project);
          changed = true;
        }
      }
      if (production.confirmationConsumedAt) {
        const status = production.jobs.every((job) => job.status === 'completed') ? 'completed'
          : production.jobs.every((job) => ['completed', 'failed', 'submission_unknown', 'cancelled'].includes(job.status))
            ? production.jobs.some((job) => job.status === 'failed' || job.status === 'submission_unknown') ? 'failed' : 'cancelled'
            : 'submitted';
        if (production.status !== status) { production.status = status; changed = true; }
      }
    }
    if (changed) await saveProject(project);
    return project;
  }
  async function getProduction(args, signal) {
    const project = await synchronize(args.projectId, signal, true);
    if (args.jobId) {
      if (!project.productions[args.jobId]) throw new Error('当前工程没有此生产任务');
      return project.productions[args.jobId];
    }
    return { projectId: args.projectId, currentJobId: project.currentProductionId, productions: Object.values(project.productions) };
  }
  async function runScript(key, args, signal) {
    await cache.admit(0);
    const script = config.scripts?.[key];
    if (!script || !['python3', 'node'].includes(script.runtime)) throw new Error('脚本未在本套件固定白名单注册');
    const project = await loadProject(args.projectId);
    const snapshots = {};
    for (const [name, entry] of Object.entries(project.documents)) snapshots[name] = { entry, content: await optionalText(inside(projectPath(args.projectId), name)) };
    const executable = await existingFile(knowledgeRoot, script.file);
    const argv = await script.args(args, api(signal));
    if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string' || value.includes('\0'))) throw new Error('固定脚本参数无效');
    const output = await scriptProcess(script.runtime === 'node' ? process.execPath : 'python3', [executable, ...argv], projectPath(args.projectId), signal);
    const latest = await loadProject(args.projectId);
    for (const [name, snapshot] of Object.entries(snapshots)) {
      if (await optionalText(inside(projectPath(args.projectId), name)) !== snapshot.content) {
        latest.documents[name] = { ...snapshot.entry, revision: snapshot.entry.revision + 1, accepted: false, updatedAt: now() };
        invalidate(latest);
      }
    }
    for (const key of script.outputDocuments || []) {
      const name = documentName({ ...args, document: key });
      if (!snapshots[name] && await optionalText(inside(projectPath(args.projectId), name)) !== null) {
        latest.documents[name] = { revision: 1, accepted: false, updatedAt: now(), document: key, ...(args.episode ? { episode: args.episode } : {}) };
        invalidate(latest);
      }
    }
    await saveProject(latest);
    let parsed;
    try { parsed = JSON.parse(output.stdout); } catch { /* Native scripts may produce a human-readable report. */ }
    // Some fixed native validators emit a JSON validation report inside stderr.error.
    // Keep their local issue codes and sanitized summaries, not a fabricated provider failure.
    if (output.exitCode !== 0 && parsed === undefined) {
      let report;
      try {
        report = JSON.parse(output.stderr);
        if (typeof report?.error === 'string') report = JSON.parse(report.error);
      } catch { report = undefined; }
      if (report?.structural_status === 'error' && Array.isArray(report.issues) && report.issues.length
        && report.issues.every(issue => issue && typeof issue.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(issue.code))) {
        const issues = report.issues.map(issue => ({ code: issue.code,
          ...(['ERROR', 'WARNING', 'INFO'].includes(issue.level) ? { level: issue.level } : {}),
          ...(typeof issue.path === 'string' && /^[A-Za-z_][A-Za-z0-9_.\[\]-]*$/.test(issue.path) ? { path: issue.path } : {}),
          message: generationErrorText(typeof issue.message === 'string' ? issue.message : ''),
        }));
        return { isError: true, exitCode: output.exitCode,
          error: '中文原因：原生校验未通过\n本地校验：' + issues.map(issue => `[${issue.code}] ${issue.path || ''}: ${issue.message}`).join('\n'),
          result: { structural_status: 'error', ...(report.semantic_status === 'needs_review' ? { semantic_status: 'needs_review' } : {}), issues } };
      }
    }
    const failed = output.exitCode !== 0 || parsed?.success === false || ['failed', 'error'].includes(parsed?.status) || Boolean(parsed?.error);
    const cleanErrors = (value) => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(cleanErrors);
      return Object.fromEntries(Object.entries(value).filter(([key]) => !['stack', 'traceback', 'response', 'headers'].includes(key))
        .map(([key, entry]) => [key, (/^(?:error|error_message|errorMessage|reason)$/.test(key) || failed && ['message', 'detail'].includes(key)) && entry
          ? message(entry) : cleanErrors(entry)]));
    };
    if (parsed !== undefined) parsed = cleanErrors(parsed);
    if (failed) return { isError: true, exitCode: output.exitCode,
      error: message({ message: output.stderr || parsed?.error || parsed?.message || (parsed === undefined ? output.stdout : '原生检查未通过，具体问题见结构化结果'),
        code: parsed?.error_code ?? parsed?.code ?? output.exitCode, httpStatus: parsed?.httpStatus ?? parsed?.statusCode }),
      ...(parsed !== undefined ? { result: parsed } : {}) };
    return { exitCode: 0, ...(parsed === undefined ? { stdout: output.stdout } : { result: parsed }), ...(output.stderr.trim() ? { warning: message(output.stderr) } : {}) };
  }
  async function archiveProject(args, signal) {
    let project = await loadProject(args.projectId);
    const directory = join(root, 'archives');
    const journal = join(directory, project.projectId + '.archive.json');
    const saved = await optionalText(journal);
    let intent = saved ? JSON.parse(saved) : null;
    if (intent && (intent.projectId !== project.projectId || intent.suiteId !== config.id
      || !['packing', 'packed', 'uploaded', 'referenced'].includes(intent.status))) throw new Error('工程归档记录无效');
    if (intent?.status === 'packing') throw new Error('上次打包结果未知，原件和未完成包保留，禁止覆盖');
    if (intent?.status === 'referenced' && intent.referencedRevision === project.revision) {
      const archive = project.archives?.find(item => item.archiveKey === intent.archiveKey);
      if (!archive) throw new Error('归档引用记录不一致');
      return { projectId: project.projectId, archive: intent.asset };
    }
    if (!intent || intent.status === 'referenced') {
      for (const asset of Object.values(project.assets)) if (asset.cacheManaged === true) await cache.materialize(project.projectId, asset, signal);
      const reserve = await archiveReserve(projectPath(args.projectId), config.id);
      const release = await cache.reserve(reserve);
      try {
        await mkdir(directory, { recursive: true });
        if (await realpath(directory) !== directory) throw new Error('工程归档目录不能为符号链接');
        const version = randomUUID();
        const next = { projectId: project.projectId, suiteId: config.id, sourceRevision: project.revision,
          file: project.projectId + '-r' + project.revision + '-' + version + '.tar.gz',
          archiveKey: 'skills:' + config.id + ':' + project.projectId + ':' + version,
          status: 'packing', createdAt: now() };
        if (!intent) await writeFile(journal, JSON.stringify(next), { flag: 'wx' });
        else await atomicJson(journal, next);
        intent = next;
        const path = join(directory, intent.file);
        await packProject(['-czf', '-',
          '--exclude=./renders/*/input/core', '--exclude=./renders/*/input/vendor',
          ...(config.id === 'hypit' ? ['--exclude=./renders/*/output/hypit-project/.hypit/runtimes', '--exclude=./renders/*/output/hypit-project/node_modules', '--exclude=./renders/*/output/hypit-project/packages'] : []),
          '-C', projectPath(project.projectId), '.'], path, reserve, root, signal);
        intent.status = 'packed';
        intent.contentSha256 = await cache.identity(path);
        await atomicJson(journal, intent);
      } finally { await release(); }
    }
    if (!new RegExp('^' + project.projectId + '-r[0-9]+-[0-9a-f-]{36}\\.tar\\.gz$').test(intent.file)) throw new Error('工程归档路径无效');
    const path = await existingFile(directory, intent.file);
    if (await cache.identity(path) !== intent.contentSha256) throw new Error('待归档包内容已改变，原包保留，禁止换键重传');
    if (intent.status === 'packed') {
      // Requires the shared runtime's scoped archiveKey contract (c5c68f8).
      const archive = await ctx.archiveFile(path, { assetType: 'document', mimeType: 'application/gzip', signal, archiveKey: intent.archiveKey });
      if (!archive?.assetId) throw new Error('资产归档未返回原资产编号');
      intent.asset = { ...archive, archiveKey: intent.archiveKey };
      intent.status = 'uploaded';
      await atomicJson(journal, intent);
    }
    project = await loadProject(args.projectId);
    project.archives ||= [];
    const existing = project.archives.find(item => item.archiveKey === intent.archiveKey);
    if (existing && existing.assetId !== intent.asset.assetId) throw new Error('归档资产引用冲突');
    const unchanged = project.revision === intent.sourceRevision;
    if (!existing) {
      project.archives.push({ ...intent.asset, createdAt: intent.createdAt, sourceRevision: intent.sourceRevision,
        referenceRevision: unchanged ? project.revision + 1 : null });
      await saveProject(project);
    }
    intent.status = 'referenced';
    const reference = project.archives.find(item => item.archiveKey === intent.archiveKey);
    intent.referencedRevision = reference.referenceRevision === project.revision ? project.revision : null;
    await atomicJson(journal, intent);
    return { projectId: project.projectId, archive: intent.asset };
  }
  const api = (signal) => ({ ctx, config, signal, knowledgeRoot, projectPath, loadProject, saveProject, documentName, invalidate,
    reserveOutput: bytes => cache.reserve(bytes),
    materializeAsset: (projectId, asset) => cache.materialize(projectId, asset, signal),
    archiveAudio: (project, job) => archiveAudio(project, job, signal),
    readDocument, writeDocument, importAsset: (args, recovery) => importAsset(args, signal, recovery),
    runScript: (key, args) => runScript(key, args, signal),
    prepareProduction: (args) => prepareProduction(args, signal), confirmProduction,
    executeProduction: (args) => executeProduction(args, signal), getProduction: (args) => getProduction(args, signal),
    archiveProject: (args) => archiveProject(args, signal), readKnowledge: knowledge });
  async function call(name, args, extra) {
    if (!definitions.some((definition) => definition.name === name)) throw new Error('本套件没有此业务工具');
    const key = name.startsWith(config.prefix + '_') ? name.slice(config.prefix.length + 1) : name;
    const signal = extra.signal;
    if (config.handlers?.[name] || config.handlers?.[key]) return (config.handlers[name] || config.handlers[key])(args, api(signal));
    if (config.scripts?.[key]) return runScript(key, args, signal);
    switch (key) {
      case 'list_projects': {
        const values = [];
        for (const entry of await readdir(projects, { withFileTypes: true })) {
          if (entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)) {
            const project = await loadProject(entry.name);
            values.push({ projectId: project.projectId, title: project.title, revision: project.revision, updatedAt: project.updatedAt });
          }
        }
        return { projects: values };
      }
      case 'create_project': {
        const project = { projectId: randomUUID(), suiteId: config.id, title: args.title, revision: 0,
          createdAt: now(), documents: {}, assets: {}, productions: {}, currentProductionId: null };
        await saveProject(project);
        if (config.createProject) await config.createProject(args, { ...api(signal), project });
        return loadProject(project.projectId);
      }
      case 'get_project': return synchronize(args.projectId, signal, true);
      case 'read_document': return readDocument(args);
      case 'write_document': return writeDocument(args);
      case 'import_asset': return importAsset(args, signal);
      case 'read_knowledge': return knowledge(args);
      case 'prepare_production': return prepareProduction(args, signal);
      case 'confirm_production': return confirmProduction(args);
      case 'execute_production': return executeProduction(args, signal);
      case 'get_production': return getProduction(args, signal);
      case 'archive_project': return archiveProject(args, signal);
      default: throw new Error('本套件没有此业务操作');
    }
  }
  const restore = () => restoring ||= runExclusive(async () => {
    for (const entry of await readdir(projects, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)) await projectExclusive(entry.name, () => cache.withLease(entry.name, () => synchronize(entry.name)));
    }
  }).finally(() => { restoring = undefined; });
  const timer = setInterval(() => { if (!closed) restore().catch(() => {}); }, 10_000);
  timer.unref?.();
  async function leasedCall(name, args, extra) {
    const key = name.startsWith(config.prefix + '_') ? name.slice(config.prefix.length + 1) : name;
    if (['list_projects', 'read_document', 'read_knowledge'].includes(key)) return result(await call(name, args, extra));
    // During unresolved coordination, metadata remains readable as its last
    // persisted snapshot; do not enter synchronize's upload/query write path.
    if (key === 'get_project' && await cache.coordinationBlocked()) return result(await loadProject(args.projectId));
    if (key === 'create_project') await cache.admit(0);
    const invoke = async () => {
      const key = name.startsWith(config.prefix + '_') ? name.slice(config.prefix.length + 1) : name;
      if (args.projectId && (config.scripts?.[key] || config.handlers?.[key] || config.handlers?.[name])) {
        const project = await loadProject(args.projectId);
        for (const asset of Object.values(project.assets)) if (asset.cacheManaged === true) await cache.materialize(project.projectId, asset, extra.signal);
      }
      return result(await call(name, args, extra));
    };
    return args.projectId ? projectExclusive(args.projectId, () => cache.withLease(id(args.projectId), invoke)) : invoke();
  }
  return { listTools: () => definitions, callTool: (name, args, extra = {}) => runExclusive(() => leasedCall(name, args, extra)),
    withMediaLease: (projectId, fn) => runExclusive(() => projectExclusive(projectId, () => cache.withLease(id(projectId), fn))),
    runExclusive, api, restore, async close() { closed = true; clearInterval(timer); await queue; } };
}
