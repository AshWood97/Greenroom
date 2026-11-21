import { chmod, copyFile, cp, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const projectIdSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' };
export const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const textSchema = { type: 'string', minLength: 1 };
export const toolDefinition = (prefix, suffix, description, inputSchema) => ({ name: prefix + '_' + suffix, description, inputSchema });

export async function projectFile(api, projectId, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('文件路径不属于当前工程');
  const root = await realpath(api.projectPath(projectId));
  const path = await realpath(join(root, name));
  if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('文件路径不属于当前工程');
  return path;
}

async function makeReadonly(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await makeReadonly(path);
    else if (entry.isFile()) await chmod(path, 0o444);
    else throw new Error('渲染输入不能含符号链接');
  }
  await chmod(directory, 0o555);
}

/** Freeze accepted source and member assets. No member code runs in this process. */
export async function prepareRenderInput(api) {
  const { project, job, knowledgeRoot } = api;
  if (!uuid.test(job.jobId)) throw new Error('渲染任务编号无效');
  const allowed = ['entry', 'width', 'height', 'fps', 'duration', 'audioAssetId'];
  if (Object.keys(job.parameters).some(key => !allowed.includes(key))) throw new Error('渲染仅支持 entry、width、height、fps、duration 和 audioAssetId');
  const { entry = 'index.html', width = 1920, height = 1080, fps = 30, duration, audioAssetId } = job.parameters;
  if (typeof entry !== 'string' || !/^[A-Za-z0-9_-]+\.html$/.test(entry)) throw new Error('渲染入口必须为工程内 HTML 文件名');
  if (![width, height].every(value => Number.isInteger(value) && value >= 2 && value <= 3840 && value % 2 === 0)) throw new Error('渲染宽高须为 2–3840 范围内的偶数');
  if (!Number.isInteger(fps) || fps < 1 || fps > 60 || !Number.isFinite(duration) || duration < 0.05 || duration > 600) throw new Error('渲染需指定 1–60 fps 和 0.05–600 秒时长');
  if (job.sourceDocument !== 'film') throw new Error('渲染入口必须来自已接受的 film 文档');
  const film = await api.readDocument({ projectId: project.projectId, document: 'film' });
  const projectRoot = await realpath(api.projectPath(project.projectId));
  const projectsRoot = await realpath(join(api.ctx.root, 'projects'));
  if (!projectRoot.startsWith(projectsRoot + sep)) throw new Error('渲染工程路径越过成员目录');
  const renders = join(projectRoot, 'renders');
  await mkdir(renders, { recursive: true });
  if (await realpath(renders) !== renders) throw new Error('渲染目录不能使用符号链接');
  const directory = join(renders, job.jobId);
  const input = join(directory, 'input');
  await mkdir(join(input, 'assets'), { recursive: true });
  await mkdir(join(directory, 'output'), { recursive: true });
  await writeFile(join(input, entry), film.content, 'utf8');
  // These image-built resources contain only the pinned local helpers, fonts
  // and Three.js package. The renderer serves only the frozen input tree.
  await cp(join(knowledgeRoot, 'assets/runtime'), input, { recursive: true });
  const assetFiles = {};
  const assetIds = [...new Set([...(job.referenceAssetIds || []), ...(audioAssetId ? [audioAssetId] : [])])];
  for (const assetId of assetIds) {
    const asset = await api.importAsset({ projectId: project.projectId, assetId });
    const source = await projectFile(api, project.projectId, asset.path);
    const extension = extname(source);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(assetId) || !/^\.[A-Za-z0-9]{1,8}$/.test(extension)) throw new Error('渲染素材编号或格式无效');
    const name = 'assets/' + assetId + extension;
    await copyFile(source, join(input, name));
    assetFiles[assetId] = name;
  }
  if (audioAssetId && !/\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(assetFiles[audioAssetId])) throw new Error('渲染音轨必须为已导入的音频素材');
  const specification = { version: 1, suiteId: project.suiteId, projectId: project.projectId, jobId: job.jobId, entry, width, height, fps, duration, ...(audioAssetId ? { audio: assetFiles[audioAssetId] } : {}) };
  await writeFile(join(input, 'job.json'), JSON.stringify(specification, null, 2));
  await makeReadonly(input);
  return { ...specification, assetFiles, sourceRevision: film.revision };
}
