import { generationErrorText, formatGenerationError } from '../shared/generation-error.ts';
import { ATTACHMENT_TOOL_NAMES, installAttachmentTools, installManagedAttachmentStorage, getAttachment, readAttachmentDocument, importAttachment } from './attachment-tools.mjs';
import { installCanvasTools, CANVAS_TOOL_NAMES } from './canvas-tools.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfileDirectory, loadOverlayPatches, createRuntimeResolution, composeEntries } from '@deepseek-ai/dsh-app-boot';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { installCreativeSkillProvider } from './creative-skills.mjs';
import { startCreativeMcp } from './creative-mcp.mjs';
import { publicMcpName } from './creative-catalog.mjs';
import { installManagedTrajectory } from './trajectory-view.mjs';
import { installSkillDocuments } from './skill-documents.mjs';
import { installSessionFork } from './session-fork.mjs';
import { PLANNING_TOOL_NAMES, installPlanningControls } from './planning-controls.mjs';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const unknownImageModels = new Set();
const declaredModelInputs = new Map();
export const isManagedModelImageCapabilityUnknown = (id) => unknownImageModels.has(id);
export const MANAGED_PRESET = 'greenroom-aigc';
export const MANAGED_WORKSPACE = resolve(process.env.DSH_DEFAULT_WORKSPACE || '/workspace');
export const BASE_MANAGED_TOOLS = Object.freeze([
  'aigc_models', 'aigc_generate_image', 'aigc_generate_video', 'aigc_get_task',
  'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
  ...ATTACHMENT_TOOL_NAMES,
]);
export const MANAGED_TOOLS = Object.freeze([
  ...BASE_MANAGED_TOOLS, ...PLANNING_TOOL_NAMES, 'greenroom_select_plugins', 'skill',
  ...CANVAS_TOOL_NAMES.map(publicMcpName),
]);

// Runs before any personal profile, patch, environment file or dependency is read.
export async function composeManagedProfile(installAnchor, name, patchFiles, fromDefaultProfile, resolvedProfile) {
  if (name !== 'web' || fromDefaultProfile !== undefined || resolvedProfile !== undefined) {
    throw new Error('Greenroom only supports its managed web profile');
  }
  const profileDir = join(runtimeDir, 'managed-profile');
  const profile = loadProfileDirectory('greenroom', profileDir, installAnchor, { userLayer: false });
  if (profile.skippedBundles.length || profile.layers.length !== 2) {
    throw new Error('Greenroom managed profile could not load its official components');
  }
  const overlays = patchFiles.flatMap((file) => loadOverlayPatches('greenroom', resolve(file)));
  // Deployment configuration supplies models; the image policy is always last.
  for (const file of ['cordis.patch.yml', 'creative.patch.yml']) {
    overlays.push(...loadOverlayPatches('greenroom', join(profileDir, file)));
  }
  const rows = composeEntries([...profile.layers.map((layer) => layer.patches), overlays]);
  if (!rows.some((row) => row.id === 'greenroom-managed' && row.disabled !== true)
      || rows.filter((row) => row.name === '@deepseek-ai/dsh-agent-preset' && row.disabled !== true).length !== 1) {
    throw new Error('Greenroom managed policy is unavailable');
  }
  return {
    profile: { ...profile, patches: [] },
    resolution: await createRuntimeResolution({ installAnchor, profile, home: profileDir }),
    overlays,
  };
}

export async function assertManagedRuntime(ctx) {
  if (ctx.get('greenroomManaged') !== true) throw new Error('Greenroom managed execution policy did not activate');
  const presets = await ctx.agentPresets.list();
  if (presets.length !== 1 || presets[0].id !== MANAGED_PRESET || presets[0].broken) {
    throw new Error('Greenroom AIGC preset did not activate');
  }
}

const endpoint = 'http://127.0.0.1:3081';
const huobaoEndpoint = 'http://127.0.0.1:5679';
const canvasEndpoint = 'http://127.0.0.1:18766';

async function canvasRequest(path, exec, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const method = options.method || (options.body === undefined ? 'GET' : 'POST');
  const response = await fetch(canvasEndpoint + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: exec?.signal,
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status}: T8 画布服务返回非 JSON 响应`);
  }
  if (!response.ok) {
    throw new Error(generationErrorText({ error: result.error, message: result.message, error_code: result.error_code ?? result.code, httpStatus: response.status }) || `T8 画布请求失败 (HTTP ${response.status})`);
  }
  if (result.success === false) {
    throw new Error(generationErrorText({ error: result.error, message: result.message, error_code: result.error_code ?? result.code }) || 'T8 画布操作失败');
  }
  return result.data !== undefined ? result.data : result;
}

async function resolveCanvasId(canvasId, exec) {
  if (canvasId) return canvasId;
  const list = await canvasRequest('/api/canvas', exec);
  const items = Array.isArray(list) ? list : (list?.data || []);
  if (!items.length) {
    // 自动创建一个默认画布
    const created = await canvasRequest('/api/canvas', exec, {
      method: 'POST',
      body: { name: '创作画布' },
    });
    return created.id;
  }
  return items[0].id;
}

async function huobaoRequest(ctx, path, exec, options = {}) {
  const service = ctx?.get?.('greenroomHuobao');
  let release;
  if (service?.ensureStarted) {
    try {
      if (service.acquire) release = await service.acquire({ usage: true, signal: exec?.signal });
      else await service.ensureStarted({ signal: exec?.signal });
    } catch (e) {
      throw new Error(`火宝短剧服务启动失败: ${e.message}`);
    }
  }
  try {
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const method = options.method || (options.body === undefined ? 'GET' : 'POST');
    const response = await fetch(huobaoEndpoint + path, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: exec?.signal,
    });
    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status}: 火宝短剧服务返回非 JSON 响应`);
    }
    if (!response.ok) {
      throw new Error(generationErrorText({ error: result.error, message: result.message, error_code: result.error_code ?? result.code, httpStatus: response.status }) || `火宝短剧请求失败 (HTTP ${response.status})`);
    }
    if (result.code !== undefined && result.code !== 0 && !(Number.isInteger(result.code) && result.code >= 200 && result.code < 300) && result.success !== true) {
      throw new Error(generationErrorText({ error: result.error, message: result.message, code: result.code }) || '火宝服务未返回具体失败原因');
    }
    return result.data !== undefined ? result.data : result;
  } finally { release?.(); }
}

// Input modalities count only when the catalog declares them for real: a non-empty array
// of non-empty strings, and not an explicitly unknown verification status. Anything else
// is not evidence of compatibility, so it returns undefined instead of an empty list that
// every subset check would pass.
function declaredModalities(capabilities) {
  if (!capabilities || capabilities.verification_status === 'unknown') return undefined;
  const declared = capabilities.input_modalities;
  if (!Array.isArray(declared) || !declared.length) return undefined;
  if (!declared.every((value) => typeof value === 'string' && value)) return undefined;
  return declared;
}

// The first preference for a member who has not chosen a model yet. The family comes
// solely from a non-empty, exactly equal base_slug, and the channel from the catalog's own
// 星网 provider_label; both sides must carry a real modality declaration, and the
// candidate must include every modality the declared entry requires.
function preferredFirstModel(models, declared) {
  if (!declared?.base_slug) return undefined;
  const required = declaredModalities(declared.capabilities);
  if (!required) return undefined;
  return models.find((model) => {
    if (model.id === declared.id || model.base_slug !== declared.base_slug) return false;
    if (model.provider_label !== '星网') return false;
    const input = declaredModalities(model.capabilities);
    return !!input && required.every((value) => input.includes(value));
  });
}

// The initial default the deployment declared for this member, read from the immutable
// managed profile. It is the deployment default, never evidence that the member has not
// chosen a model: agent.model.current() prefers the pending selection and last used model
// before the default, so this value is what a real session falls back to, not a record of
// absent choice.
function declaredDefaultModel(ctx) {
  const config = ctx.loader.resolve('include:llm-pi-ai').options.config.providers['greenroom-gateway'];
  if (!config?.models?.length) return undefined;
  const declared = ctx.loader.resolve('include:agent-default-model').options.config;
  if (declared.provider !== 'greenroom-gateway' || typeof declared.model !== 'string') return undefined;
  return config.models.some((model) => model.id === declared.model) ? declared.model : undefined;
}

// The deployment default applied once, at the first successful valid catalog. This is an
// in-process guard only: it holds no session event, writes no selection store and does not
// survive a DSH restart, so a restarted process re-initializes from the profile's declared
// default while every running session keeps the native pending/last-used priority.
const appliedFirstDefault = new Set();

// Applies the first preference exactly once, at the first successful valid catalog. A
// catalog that is unavailable or carries no rows leaves the deployment default alone and
// allows the next success to initialize it; once the deployment default has been applied,
// no later catalog refresh changes it again. The update is a volatile config change: it
// commits in memory and publishes the native events without rewriting the immutable
// managed profile.
function applyFirstDefault(ctx, catalogRows) {
  if (!catalogRows.length || appliedFirstDefault.has(ctx)) return;
  const declared = declaredDefaultModel(ctx);
  if (!declared) return;
  const preferred = preferredFirstModel(catalogRows, catalogRows.find((row) => row.id === declared));
  if (!preferred || preferred.id === declared) return;
  appliedFirstDefault.add(ctx);
  ctx.loader.resolve('include:agent-default-model')
    .update({ config: { provider: 'greenroom-gateway', model: preferred.id } });
}

function managedProfile(profile) {
  if (!profile) return {};
  const {contextWindow, maxTokens, input, reasoningLevels, reasoningMap = {}} = profile;
  return {
    ...(contextWindow ? {contextWindow} : {}), ...(maxTokens ? {maxTokens} : {}),
    ...(input ? {input} : {}),
    ...(reasoningLevels ? {reasoningEfforts: reasoningLevels.length ?
      Object.fromEntries(reasoningLevels.map(level => [level === 'none' ? 'off' : level, reasoningMap[level] || level])) :
      false} : {}),
  };
}

export async function refreshManagedModels(ctx, bootstrap, signal) {
  const timeout = AbortSignal.timeout(30_000);
  const result = await request('/canvas/api/greenroom/models', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const entry = ctx.loader.resolve('include:llm-pi-ai');
  const config = entry.options.config;
  const current = config.providers['greenroom-gateway'] || bootstrap;
  const models = result.data.llm.filter(model => !model.providerId).map((model) => {
    const initial = bootstrap.models?.find((value) => value.id === model.id);
    const declared = model.capabilities?.input_modalities?.filter((value) => ['text', 'image'].includes(value));
    // An unverified empty catalog entry means unknown, not text-only. Only
    // exact-ID bootstrap/history metadata may fill that gap.
    const usableDeclaration = declared?.length && model.capabilities?.verification_status !== 'unknown';
    if (usableDeclaration) declaredModelInputs.set(model.id, declared);
    const prior = [declaredModelInputs.get(model.id), initial?.input, initial?.inputModalities]
      .find((value) => Array.isArray(value) && value.length);
    const input = model.profile?.input || (usableDeclaration ? declared : [...(prior || ['text'])]);
    if (!model.profile?.input && !usableDeclaration && !prior) unknownImageModels.add(model.id);
    else unknownImageModels.delete(model.id);
    return { ...initial, id: model.id, name: model.label || model.id,
      input, inputModalities: input, ...managedProfile(model.profile) };
  });
  const providers = { ...config.providers };
  const api = result.data.llm.some(row => !row.providerId && row.api === 'openai-responses') ? 'openai-responses' : bootstrap.api;
  if (models.length) providers['greenroom-gateway'] = { ...current, api, models };
  else delete providers['greenroom-gateway'];
  for (const key of Object.keys(providers)) if (key.startsWith('greenroom-external-')) delete providers[key];
  for (const row of result.data.llm.filter(model => model.providerId)) {
    const key = `greenroom-external-${row.providerId.replaceAll('_', '-')}-${row.api === 'openai-responses' ? 'responses' : 'chat'}`;
    providers[key] ??= { ...bootstrap, displayName: row.provider_label, api: row.api, models: [] };
    providers[key].models.push({ id: row.id, name: row.label, ...managedProfile(row.profile) });
  }
  if (JSON.stringify(providers) !== JSON.stringify(config.providers)) {
    // Entry.update commits volatile providers in memory and publishes the native
    // route events without rewriting the immutable managed profile.
    await entry.update({ config: { ...config, providers } });
    // pi-ai's registration facts omit models, so a retained route needs the same
    // catalog notification that native route additions/removals already publish.
    if (config.providers['greenroom-gateway'] && models.length) ctx.emit('llm/adapters-updated');
  }
  // This refresh only updates the model list. It never rewrites an existing selection:
  // a selection that disappears from the active catalog has not thereby become an
  // overwritable default, and its value cannot show whether the member chose it. The
  // channel decision reads the catalog rows themselves, not the registered entries.
  applyFirstDefault(ctx, result.data.llm);
}

async function request(path, exec, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    if (!exec.agent || !exec.callId) throw new Error('AIGC generation requires a chat tool call');
    headers['Content-Type'] = 'application/json';
    const sessId = String(exec.agent.session.id || '').replace(/-/g, '').slice(-12);
    const cId = String(exec.callId || '').replace(/-/g, '').slice(-16);
    headers['X-T8-Provider-Submission'] = `dsh:${sessId}:${cId}`;
  }
  const response = await fetch(endpoint + path, {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: exec.signal,
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw new Error(formatGenerationError({ error: result.error, message: result.message, error_code: result.error_code ?? result.code, httpStatus: response.status }));
  return result;
}

const text = (description, required = false) => ({ type: 'string', description, ...(required ? { required } : {}) });
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
export const inject = ['tools', 'sandboxPolicy', 'agentPresets', 'attachments', 'sessionQuery', 'sessionProjections', 'webServer', 'connection', 'llm', 'agentDefaultModel'];
export async function apply(ctx) {
  const native = process.env.GREENROOM_DSH_NATIVE === '1';
  if (native) {
    ctx.inject(['skills'], (child) => { installCreativeSkillProvider(child); });
  } else {
    installPlanningControls(ctx);
  }
  installSkillDocuments(ctx);
  ctx.inject(['sessionController', 'agents', 'fileUploads', 'attachments', 'sessionQuery', 'connection'], child => { installSessionFork(child); });
  installManagedAttachmentStorage(ctx);
  ctx.provide('greenroomUnknownImageModels', unknownImageModels);
  ctx.inject(['llm', 'agentDefaultModel'], (child) => {
    const bootstrap = ctx.loader.resolve('include:llm-pi-ai').options.config.providers['greenroom-gateway'];
    const controller = new AbortController();
    let pending;
    const refresh = () => pending ||= refreshManagedModels(child, bootstrap, controller.signal)
      .catch(() => {}) // Keep the last successful catalog until the broker recovers.
      .finally(() => { pending = undefined; });
    child.effect(() => {
      void refresh();
      const timer = setInterval(refresh, native ? 5_000 : 60_000);
      return () => { controller.abort(); clearInterval(timer); };
    });
  });
  ctx.provide('greenroomManaged', true);
  ctx.tools.register(defineTool({
    name: 'aigc_models', description: '查询当前平台已开通的图片与视频生成模型及其支持的参数。', parameters: {}, output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const result = await request('/canvas/api/greenroom/models', exec);
      return { success: true, data: { image: result.data.image, video: result.data.video } };
    },
  }));
  ctx.tools.register(defineTool({
    name: 'aigc_generate_image', description: '在个人空间提交文生图任务。先用 aigc_models 查询可用模型和参数；返回 taskId 后用 aigc_get_task 查询结果。',
    parameters: {
      model: text('平台已开通的图片模型 ID。', true), prompt: text('图片创作提示词。', true),
      size: text('模型支持的图片尺寸。'), quality: text('渲染质量。'), complexity: text('图片规划复杂度。'), aspect_ratio: text('模型支持的宽高比。'), n: { type: 'integer', description: '生成图片数量。' },
    }, output,
    execute: (args, exec) => request('/canvas/api/proxy/image/submit', exec, args),
  }));
  ctx.tools.register(defineTool({
    name: 'aigc_generate_video', description: '在个人空间提交文生视频任务。先用 aigc_models 查询可用模型和参数；返回 taskId 后用 aigc_get_task 查询结果。',
    parameters: {
      model: text('平台已开通的视频模型 ID。', true), prompt: text('视频创作提示词。', true),
      aspect_ratio: text('模型支持的宽高比。'), duration: { type: 'number', description: '模型支持的时长，单位秒。' }, resolution: text('模型支持的分辨率。'),
    }, output,
    execute: (args, exec) => request('/canvas/api/proxy/video/submit', exec, args),
  }));
  ctx.tools.register(defineTool({
    name: 'aigc_get_task', description: '查询本人图片或视频任务的状态、进度和已归档的作品链接。',
    parameters: { taskId: text('生成工具返回的任务编号。', true) }, output,
    isConcurrencySafe: () => true,
    execute: (args, exec) => request('/canvas/api/greenroom/tasks/' + encodeURIComponent(args.taskId), exec),
  }));

  const helpers = { text, output, request, huobaoRequest, canvasRequest, resolveCanvasId, getAttachment, readAttachmentDocument, importAttachment };
  installAttachmentTools(ctx, helpers);
  const definitions = [];
  const collector = Object.create(ctx);
  Object.defineProperty(collector, 'tools', { value: { register: (definition) => definitions.push(definition) } });
  installCanvasTools(collector, helpers);
  const mcp = await startCreativeMcp(ctx, { definitions, baseTools: [...BASE_MANAGED_TOOLS, ...PLANNING_TOOL_NAMES, 'skill'] });
  ctx.provide('greenroomCreativeMcp', mcp);
  installManagedTrajectory(ctx, mcp.managedNames);
  if (!native) ctx.tools.guard((exec) => mcp.managedNames.has(exec.name) ? undefined : 'Greenroom 创作模式仅开放已配置的创作业务、对话附件与定时任务工具');
  ctx.effect(() => () => mcp.close());
}
