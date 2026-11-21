import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

const actions = {
  aid_studio_step_status: ['/api/user/step/status', '读取原生创作步骤和前置条件，不改变进度', { projectId: { type: 'integer' }, episodeId: { type: 'integer' } }, ['projectId']],
  aid_studio_advance_step: ['/api/user/step/advance', '按当前 completedStep 校验真实业务数据并推进一步；不能越级或绕过素材要求', { projectId: { type: 'integer' }, episodeId: { type: 'integer' }, completedStep: { type: 'integer', minimum: 1, maximum: 7 } }, ['projectId', 'completedStep']],
  aid_studio_list_projects: ['/api/user/project/list', '列出成员自己的 AID 项目', {}],
  aid_studio_create_project: ['/api/user/project/create', '创建原生 AID 项目', { projectName: { type: 'string' }, projectDesc: { type: 'string' }, projectType: { type: 'string', enum: ['series', 'movie'] }, aspectRatio: { type: 'string' }, scriptType: { type: 'string', enum: ['plot', 'monologue'] }, videoStyleType: { type: 'string' }, videoStyleValue: { type: 'string' } }, ['projectName', 'projectType']],
  aid_studio_get_project: ['/api/user/project/detail', '读取自己的 AID 项目与业务状态', { id: { type: 'integer' } }, ['id']],
  aid_studio_update_project: ['/api/user/project/update', '修改原生 AID 工程参数', { id: { type: 'integer' }, projectName: { type: 'string' }, projectDesc: { type: 'string' }, aspectRatio: { type: 'string' } }, ['id']],
  aid_studio_list_episodes: ['/api/user/episode/list', '列出工程剧集', { projectId: { type: 'integer' } }, ['projectId']],
  aid_studio_create_episode: ['/api/user/episode/create', '创建原生 AID 剧集', { projectId: { type: 'integer' }, comicTitle: { type: 'string' }, comicDesc: { type: 'string' } }, ['projectId', 'comicTitle']],
  aid_studio_get_script: ['/api/user/script/detailByProject', '读取工程剧本；电影 episodeId 传 0', { projectId: { type: 'integer' }, episodeId: { type: 'integer' } }, ['projectId', 'episodeId']],
  aid_studio_save_script: ['/api/user/script/save', '保存工程剧本；已有基线时将 get_script 返回的 id/contentHash 原样作为 baseScriptId/baseContentHash 成对传回，不自行计算摘要', { projectId: { type: 'integer' }, episodeId: { type: 'integer' }, originalText: { type: 'string' }, baseScriptId: { type: 'integer' }, baseContentHash: { type: 'string' } }, ['projectId', 'episodeId', 'originalText']],
  aid_studio_extract_assets: ['/api/user/asset/extract/parallel', '用 AID 原生流水线提取角色、场景和道具；返回后在后台继续运行。agentCodes从模板目录选择。', { projectId: { type: 'integer' }, episodeId: { type: 'integer' }, extractTypes: { type: 'array', items: { type: 'string' } }, agentCodes: { type: 'object', additionalProperties: { type: 'string' } }, modelCodes: { type: 'object', additionalProperties: { type: 'string' } }, overwrite: { type: 'boolean' } }, ['projectId', 'extractTypes', 'agentCodes']],
  aid_studio_list_assets: ['/api/user/asset/rps/list', '读取当前成员工程中原生提取的角色、场景和道具', { projectId: { type: 'integer' }, episodeId: { type: 'integer' }, assetType: { type: 'string', enum: ['character', 'scene', 'prop'] } }, ['projectId']],
  aid_studio_generate_asset_forms: ['/api/user/asset/extract/form/generate', '为成员已有资产生成原生形态和视觉提示词；同批资产须同类型、同项目/剧集，agentCode从对应main_*_form模板目录选择；返回单个父taskId，使用get_task查询，不重提', { assetIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer' } }, agentCode: { type: 'string', minLength: 1 }, modelCode: { type: 'string' } }, ['assetIds', 'agentCode']],
  aid_studio_generate_asset_image: ['/api/user/asset/extract/form/generate-image', '提交 AID 原生资产形态图生成', { formIds: { type: 'array', items: { type: 'integer' } }, agentCode: { type: 'string' }, modelCode: { type: 'string' }, resolution: { type: 'string' }, aspectRatio: { type: 'string' } }, ['formIds', 'agentCode']],
  aid_studio_list_agents: ['/aid/agent/list', '读取 AID 原生创作模板目录', { bizCategoryCodes: { type: 'array', items: { type: 'string' } } }],
  aid_studio_list_models: ['/api/user/model/list', '读取管理员批准的成员模型', { modelType: { type: 'string' }, generateMode: { type: 'string' } }],
  aid_studio_list_storyboards: ['/api/user/storyboard/list', '读取原生分镜列表', { projectId: { type: 'integer' }, episodeId: { type: 'integer' } }, ['projectId', 'episodeId']],
  aid_studio_create_storyboard: ['/api/user/storyboard/create', '在成员工程中创建原生分镜', { projectId: { type: 'integer' }, episodeId: { type: 'integer' }, title: { type: 'string' } }, ['projectId', 'episodeId']],
  aid_studio_update_storyboard: ['/api/user/storyboard/update', '保存原生分镜的剧本与对白', { id: { type: 'integer' }, title: { type: 'string' }, storyScript: { type: 'string' }, dialogueText: { type: 'string' } }, ['id']],
  aid_studio_generate_video: ['/api/user/storyboard/generate/video', '提交已有分镜的视频生成，返回后在原任务中继续', { storyboardIds: { type: 'array', items: { type: 'integer' } }, modelName: { type: 'string' }, capabilityCode: { type: 'string' }, videoPrompt: { type: 'string' }, durationSeconds: { type: 'integer' }, aspectRatio: { type: 'string' }, resolution: { type: 'string' }, generateAudio: { type: 'boolean' } }, ['storyboardIds']],
  aid_studio_get_timeline: ['/api/user/episode/timeline/get', '读取原生剪辑时间轴', { projectId: { type: 'integer' }, episodeId: { type: 'integer' }, episodeEditorId: { type: 'integer' } }],
  aid_studio_export_video: ['/api/user/episode/export', '用 AID 原生 FFmpeg 合成：保留视频/配音/BGM/字幕分组与工程，结果归档到成员私有媒体', { projectId: { type: 'integer' }, episodeId: { type: 'integer' }, episodeEditorId: { type: 'integer' }, groups: { type: 'array', items: { type: 'object', properties: { storyboardId: { type: 'integer' }, videoUrls: { type: 'array', items: { type: 'string' } }, videoDurations: { type: 'array', items: { type: 'number' } }, audioUrls: { type: 'array', items: { type: 'string' } }, audioDurations: { type: 'array', items: { type: 'number' } }, subtitle: { type: 'string' }, bgmUrl: { type: 'string' } }, required: ['storyboardId', 'videoUrls', 'videoDurations'] } }, globalBgmUrl: { type: 'string' }, resolution: { type: 'string' }, timelineJson: { type: 'string' } }, ['groups']],
  aid_studio_export_status: ['/api/user/episode/export/status', '查询原生导出任务及私有成片', { projectId: { type: 'integer' }, episodeId: { type: 'integer' }, episodeEditorId: { type: 'integer' } }],
  aid_studio_list_tasks: ['/api/user/task/list', '读取自己的后台任务及失败原因；不重新提交生成', { projectId: { type: 'integer' }, episodeId: { type: 'integer' } }],
  aid_studio_get_task: ['/api/user/task/detail', '查询原任务与产物', { taskId: { type: 'integer' } }, ['taskId']],
};

// Pure metadata for core preparation. Do not construct an adapter to discover tools.
export function listTools() {
  return Object.entries(actions).map(([name, [, description, properties, required]]) => ({ name, description, inputSchema: { type: 'object', properties, ...(required ? { required } : {}) } }));
}

// Explicit consumer of the shared in-process activation client. The trusted host
// owns the client and its immutable member/unit binding; plugin arguments and
// environment variables are not authority. No mkdir/read/timer/request occurs
// until runStartupOnce invokes the factory. This is not production wiring.
const activatedAdapters = new WeakMap();
export function createActivatedAdapter(ctx, activation) {
  // #31 defines the unit, but a trusted host-to-capabilities binding is not yet
  // wired. Do not treat a caller-supplied client/status object as authentication.
  const error = new Error('AID trusted activation binding is not connected');
  error.code = 'AID_ACTIVATION_BINDING_UNAVAILABLE';
  throw error;
}

// Kept private until the shared host supplies the verified binding contract.
function createPreparedActivation(ctx, activation) {
  if (typeof activation?.runStartupOnce !== 'function') throw new TypeError('AID requires an injected activation client');
  const prior = activatedAdapters.get(activation);
  if (prior) {
    if (prior.ctx !== ctx) throw new TypeError('Activation client already bound to another capabilities object');
    return prior.promise;
  }
  // The shared client resolves only after its imported receipt is confirmed.
  // Constructing inside the callback must not leave a running recovery timer
  // when markImported fails or its result is unknown.
  const promise = activation.runStartupOnce(() => constructAdapter(ctx)).then(prepared => {
    prepared.startRecovery();
    return prepared.adapter;
  });
  activatedAdapters.set(activation, { ctx, promise });
  return promise;
}

// Existing already-active/legacy callers retain their original behavior.
export async function createAdapter(ctx) {
  const prepared = await constructAdapter(ctx);
  prepared.startRecovery();
  return prepared.adapter;
}

async function constructAdapter(ctx) {
  await mkdir(ctx.root, { recursive: true });
  const path = join(ctx.root, 'managed-tasks.json');
  let bindings;
  try { bindings = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; bindings = {}; }
  let active;
  let synchronizedCatalog;
  const pendingProviderPersistence = new Set();
  const pendingTextPersistence = new Set();
  const save = async () => { await writeFile(path + '.tmp', JSON.stringify(bindings)); await rename(path + '.tmp', path); };
  const api = async (route, body, signal, returnEnvelope = false) => {
    const value = await ctx.request(route, { method: body === undefined ? 'GET' : 'POST', body, signal });
    if (value.code !== 200) throw new Error(value.msg || 'AID 未返回具体业务原因');
    return returnEnvelope ? value : value.data;
  };
  async function verifyArchivedAsset(asset) {
    if (!asset?.assetId) throw new Error('归档结果缺少媒体标识');
    const response = await fetch(ctx.brokerUrl + '/api/media/' + encodeURIComponent(asset.assetId));
    if (response.status !== 200 || !response.body) throw new Error('归档结果暂不可读取（HTTP ' + response.status + '）');
    const expected = asset.fileSize ?? asset.size;
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (expected !== undefined && bytes > expected) throw new Error('归档结果大小与原媒体不符');
    }
    if (expected !== undefined ? bytes !== expected : bytes <= 0) throw new Error('归档结果未完整读取');
  }
  async function pump() {
    const deferred = [];
    const failures = [];
    let settings, permitted;
    const process = async (row, recovering) => {
      let binding = bindings[row.id];
      const textOutcome = row.kind === 'llm' && (binding?.result || binding?.textRejection);
      const unknownText = row.kind === 'llm' && binding?.textStarted && !textOutcome;
      let textSubmissionAttempted = false;
      const acceptedMedia = ['image', 'video', 'tts', 'music'].includes(row.kind)
        && (row.providerTaskId || binding?.providerTaskId);
      // Existing results and accepted provider IDs must not wait behind the
      // current model catalogue. Unsent or unknown work stays for the normal
      // catalogue-gated pass and is never submitted during an outage.
      if (recovering && row.kind !== 'compose' && !acceptedMedia && !textOutcome) {
        deferred.push(row);
        return;
      }
      try {
        if (row.kind === 'compose') {
          binding ||= bindings[row.id] = { kind: 'compose' };
          const route = '/greenroom/compose/' + encodeURIComponent(row.id);
          const status = await api(route + '/status');
          if (status.status === 'failed') throw new Error(status.error);
          if (status.status === 'pending') {
            if (recovering) { deferred.push(row); return; }
            const inputs = row.body.composePlan.tracks.fileInfos.map(file => file.url);
            await api(route + '/run', { inputs });
          } else if (status.status === 'ready') {
            if (!binding.output) {
              binding.output = await ctx.archiveFrom(route + '/output', {
                filename: 'aid-' + row.id.replace(':', '-') + '.mp4', assetType: 'video',
                operationId: 'aid-studio:' + row.id, operationTarget: 'aid-studio:' + row.id,
              });
              try { await save(); }
              catch (error) { delete binding.output; throw error; }
            }
            if (!binding.verified) {
              await verifyArchivedAsset(binding.output);
              binding.verified = true;
              try { await save(); }
              catch (error) { delete binding.verified; throw error; }
            }
            await api('/greenroom/task-update', { id: row.id, status: 'succeeded', outputs: [{ ...binding.output, mimeType: 'video/mp4', url: '/creative-managed/media/' + encodeURIComponent(binding.output.assetId) }] });
          }
          return;
        }
        if (!binding) {
          const acceptedMedia = row.providerTaskId && ['image', 'video', 'tts', 'music'].includes(row.kind);
          const body = acceptedMedia ? { ...row.body } : { ...(settings.parameters?.[row.kind] || {}), ...row.body };
          if (!acceptedMedia && row.kind === 'image' && body.quality !== undefined) {
            body.providerParams = { quality: body.quality, ...body.providerParams };
            delete body.quality;
          }
          if (!acceptedMedia) {
            const models = permitted[row.kind] || [];
            if (!body.model) body.model = models[0]?.id;
            if (!body.model) throw new Error('管理员尚未启用该类模型');
            if (!models.some(v => v.id === body.model)) throw new Error('管理员未批准该模型');
          }
          binding = bindings[row.id] = { kind: row.kind, body, submissionId: 'aid-studio:' + row.id, providerTaskId: row.providerTaskId };
          if (['image', 'video', 'tts', 'music'].includes(row.kind) && !row.providerTaskId) binding.submissionState = 'prepared';
          try { await save(); }
          catch (error) { delete bindings[row.id]; binding = undefined; throw error; }
        }
        if (row.kind === 'llm') {
          if (!binding.result && !binding.textRejection) {
            if (binding.textStarted) throw new Error('上次文本请求的结果尚未确认，保留原任务编号 ' + row.id);
            if (!(permitted.llm || []).some(model => model.id === binding.body.model)) throw new Error('管理员未批准该模型');
            const hadTextStarted = Object.prototype.hasOwnProperty.call(binding, 'textStarted');
            const previousTextStarted = binding.textStarted;
            binding.textStarted = true;
            try { await save(); }
            catch (error) {
              if (hadTextStarted) binding.textStarted = previousTextStarted;
              else delete binding.textStarted;
              throw error;
            }
            textSubmissionAttempted = true;
            const response = await fetch(ctx.brokerUrl + '/v1/chat/completions', {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer greenroom-managed' },
              body: JSON.stringify(binding.body),
            });
            const value = await response.json();
            if (!response.ok) {
              const reason = ctx.formatGenerationError(value) || `HTTP ${response.status}`;
              if (response.status !== 400 || value?.error?.type !== 'invalid_request_error') {
                throw new Error(reason);
              }
              binding.textRejection = reason;
            } else {
              binding.result = value;
            }
            pendingTextPersistence.add(row.id);
            await save();
            pendingTextPersistence.delete(row.id);
          }
          // A received text response may still be in memory if its previous
          // binding write failed. Persist it before marking the queue complete.
          if (pendingTextPersistence.has(row.id)) {
            await save();
            pendingTextPersistence.delete(row.id);
          }
          await api('/greenroom/task-update', binding.textRejection
            ? { id: row.id, status: 'failed', error: binding.textRejection }
            : { id: row.id, status: 'succeeded', result: binding.result });
          return;
        }
        // The native queue may have persisted the accepted ID after the local
        // binding was written. Recover that original task before considering a send.
        if (row.providerTaskId) {
          if (binding.providerTaskId && binding.providerTaskId !== row.providerTaskId) {
            throw new Error('原任务编号与本地绑定不一致，保留两份记录，不重新提交');
          }
          if (!binding.providerTaskId) {
            binding.providerTaskId = row.providerTaskId;
            try { await save(); }
            catch (error) { delete binding.providerTaskId; throw error; }
          }
        }
        if (!binding.providerTaskId) {
          // Legacy no-ID records cannot prove that a previous request was not sent.
          if (binding.submissionState !== 'prepared') throw new Error('原媒体提交受理状态未知，保留原任务，不自动重新提交');
          if (!(permitted[row.kind] || []).some(model => model.id === binding.body.model)) throw new Error('管理员未批准该模型');
          binding.submissionState = 'submitting';
          try { await save(); }
          catch (error) { binding.submissionState = 'prepared'; throw error; }
          const task = await ctx.submit(row.kind, binding.body, binding.submissionId);
          if (!task?.taskId) throw new Error('媒体提交未返回原任务编号，受理状态未知');
          binding.providerTaskId = task.taskId;
          pendingProviderPersistence.add(row.id);
        }
        // Retain a received ID in this process while its durable write is pending.
        // A restart before that write still has only the original unknown intent.
        if (pendingProviderPersistence.has(row.id)) {
          await save();
          pendingProviderPersistence.delete(row.id);
        }
        await api('/greenroom/task-update', { id: row.id, status: 'processing', providerTaskId: binding.providerTaskId });
        const task = await ctx.getTask(binding.providerTaskId);
        if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
          await api('/greenroom/task-update', {
            id: row.id, providerTaskId: binding.providerTaskId, status: task.status,
            outputs: (task.outputs || []).map(output => ({ ...output, url: output.assetId ? '/creative-managed/media/' + encodeURIComponent(output.assetId) : output.url })),
            ...(task.error ? { error: ctx.formatGenerationError(task.error) } : {}),
          });
        }
      } catch (error) {
        // Accepted jobs remain bound to their original provider task after query errors.
        const unknownMedia = binding && ['image', 'video', 'tts', 'music'].includes(row.kind) && binding.submissionState !== 'prepared';
        const savedText = row.kind === 'llm' && (binding?.result || binding?.textRejection);
        let reason;
        try {
          reason = ctx.formatGenerationError(error) || error.message;
          await api('/greenroom/task-update', row.providerTaskId || binding?.providerTaskId || binding?.kind === 'compose' || unknownMedia || unknownText || textSubmissionAttempted || pendingTextPersistence.has(row.id) || savedText
            ? { id: row.id, queryError: reason }
            : { id: row.id, status: 'failed', error: reason });
        } catch (writeError) {
          const writeReason = ctx.formatGenerationError(writeError) || writeError.message;
          failures.push(new AggregateError([error, writeError], `${reason || error.message}；任务状态回写失败：${writeReason}`));
        }
      }
    };
    let after;
    for (;;) {
      const rows = await api('/greenroom/pending' + (after === undefined ? '' : '?after=' + encodeURIComponent(after)));
      for (const row of rows) await process(row, true);
      if (rows.length < 100) break;
      after = rows.at(-1).id;
    }

    let catalogReady = false;
    try {
      settings = await ctx.getSettings();
      const catalog = await ctx.managedModels();
      permitted = Object.fromEntries(['llm', 'image', 'video', 'tts', 'music'].map(kind => [kind,
        settings.configured ? (settings.models[kind] || []).flatMap(id => (catalog[kind] || []).filter(item => item.id === id)) : catalog[kind] || []]));
      const serializedCatalog = JSON.stringify(permitted);
      if (synchronizedCatalog !== serializedCatalog) {
        await api('/greenroom/models', permitted);
        synchronizedCatalog = serializedCatalog;
      }
      catalogReady = true;
    } catch (error) {
      failures.push(error);
    }
    if (catalogReady) for (const row of deferred) await process(row, false);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const reasons = failures.map(error => {
        try {
          const reason = ctx.formatGenerationError(error);
          return typeof reason === 'string' && reason.trim() ? reason : '中文原因：服务商未返回具体失败原因';
        } catch {
          return '中文原因：服务商未返回具体失败原因';
        }
      });
      throw new AggregateError(failures, 'AID 任务恢复或模型同步未完成：\n' + reasons.join('\n'));
    }
  }
  const restore = () => active ||= pump().finally(() => { active = undefined; });
  let timer;
  const startRecovery = () => {
    if (timer) return;
    timer = setInterval(() => { restore().catch(() => {}); }, 5_000);
    timer.unref?.();
  };
  const adapter = {
    listTools,
    async callTool(name, args, { signal } = {}) {
      if (!actions[name]) throw new Error('未知 AID 工具');
      args = { ...args };
      if (name === 'aid_studio_create_project' && args.projectDesc === undefined) args.projectDesc = '';
      const defaultModel = async modelType => {
        const models = await api('/api/user/model/list', { modelType }, signal);
        const code = models[0]?.modelCode;
        if (!code) throw new Error('管理员尚未启用该类模型');
        return code;
      };
      if (name === 'aid_studio_generate_asset_forms' && !args.modelCode) args.modelCode = await defaultModel('text');
      if (name === 'aid_studio_generate_asset_image' && !args.modelCode) args.modelCode = await defaultModel('image');
      if (name === 'aid_studio_generate_video' && !args.modelName) args.modelName = await defaultModel('video');
      if (name === 'aid_studio_extract_assets' && !args.modelCodes) {
        const code = await defaultModel('text');
        args.modelCodes = Object.fromEntries(args.extractTypes.map(kind => [kind, code]));
      }
      const result = await api(actions[name][0], args, signal, ['aid_studio_update_storyboard', 'aid_studio_advance_step'].includes(name));
      if (result === undefined) throw new Error('AID 未返回必要业务数据');
      restore().catch(() => {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
    getUiTarget: () => ctx.endpoint.replace(/\/$/, '') + '/plugins/aid-studio',
    restore,
    close: async () => { clearInterval(timer); await active; },
  };
  return { adapter, startRecovery };
}
