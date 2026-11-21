import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const CANVAS_TOOL_NAMES = Object.freeze([
  't8_canvas_list', 't8_canvas_create', 't8_canvas_get_state', 't8_canvas_create_node',
  't8_canvas_connect_nodes', 't8_canvas_update_node', 't8_canvas_delete_node',
  't8_canvas_batch_update_prompts', 't8_canvas_run_node', 't8_canvas_capabilities',
  't8_canvas_bind_asset', 't8_canvas_run', 't8_canvas_get_run', 't8_canvas_cancel_run',
  't8_canvas_compose_videos', 't8_canvas_get_composition',
  't8_canvas_list_runs', 't8_canvas_cancel_composition', 't8_canvas_import_storyboard_scripts',
]);

const CONFIG_FIELDS = {
  llm: ['model', 'prompt', 'userPrompt', 'system', 'temperature', 'maxTokens', 'pickedFiles', 'materialOrder'],
  image: ['prompt', 'apiModel', 'aspectRatio', 'sizeLevel', 'n', 'referenceImages', 'materialOrder'],
  video: ['model', 'prompt', 'ratio', 'duration', 'resolution', 'localRefImages', 'localRefVideos', 'localRefAudios', 'materialOrder'],
  'greenroom-selected': ['rhToolsActiveAppId', 'paramValues', 'materialOrder'],
  'rh-tools': ['rhToolsActiveAppId', 'paramValues', 'materialOrder'],
  text: ['prompt', 'text', 'textLocalPrompt', 'textUseUpstream'], upload: ['imageUrl', 'videoUrl', 'audioUrl', 'mimeType', 'filename'],
  'material-set': ['materialSetItems', 'materialSetKind', 'materialSetSyncUpstream', 'materialSetExcludedUpstream'],
  output: ['pickKind', 'pickIndex', 'outputText', 'directOutputSingleSnapshot', 'directOutputText', 'directTextSegments',
    'directImageUrl', 'directImageUrls', 'directVideoUrl', 'directVideoUrls', 'directAudioUrl', 'directAudioUrls', 'hiddenMaterialUrls'],
  'frame-pair': ['firstFrameUrl', 'lastFrameUrl'],
  'director-storyboard': [], // Draft scripts only, through the dedicated append operation.
};
const objectParameter = (description) => ({ type: 'object', additionalProperties: true, description });
const stringArray = (description) => ({ type: 'array', items: { type: 'string' }, description });

export function installCanvasTools(ctx, helpers) {
  const { text, output, canvasRequest, resolveCanvasId, importAttachment } = helpers;
  const register = (name, description, parameters, execute, readOnly = false) => ctx.tools.register(defineTool({
    name, description, parameters, output, ...(readOnly ? { isConcurrencySafe: () => true } : {}), execute,
  }));
  const canvas = async (args, exec) => {
    const id = await resolveCanvasId(args.canvasId, exec);
    return { id, document: await canvasRequest(`/api/canvas/${encodeURIComponent(id)}`, exec) };
  };
  const mutate = (id, document, operations, exec) => canvasRequest(`/api/canvas/${encodeURIComponent(id)}/operations`, exec, {
    method: 'POST', body: { baseRevision: document.revision, operations: operations.map((operation) => ({ ...operation,
      opId: randomUUID(), actorId: 'local-owner', sessionId: 'greenroom-dsh', baseRevision: document.revision })) },
  });
  const configure = (node, args) => {
    const parameters = args.parameters || {};
    const fields = CONFIG_FIELDS[node.type];
    if (node.type === 'director-storyboard' && (args.prompt !== undefined || args.model !== undefined)) throw new Error('导演分镜仅支持标题和显式 ID 的草稿脚本追加；模型/执行尚未接入');
    if (!fields) throw new Error(`节点类型 ${node.type} 没有已配置的托管参数`);
    for (const field of Object.keys(parameters)) if (!fields.includes(field)) throw new Error(`节点 ${node.type} 不支持参数 ${field}`);
    if (node.type === 'output') {
      if (parameters.pickKind !== undefined && !['text', 'image', 'video', 'audio'].includes(parameters.pickKind)) throw new Error('Output pickKind 仅支持 text/image/video/audio');
      if (parameters.pickIndex !== undefined && (!Number.isInteger(parameters.pickIndex) || parameters.pickIndex < 0)) throw new Error('Output pickIndex 必须为非负整数');
    }
    const data = { ...parameters, ...(args.prompt === undefined ? {} : { prompt: args.prompt, text: args.prompt }),
      ...(args.title === undefined ? {} : { title: args.title }) };
    if (node.type === 'text' && (args.prompt !== undefined || parameters.prompt !== undefined || parameters.text !== undefined)) {
      const prompt = args.prompt ?? parameters.prompt ?? parameters.text;
      Object.assign(data, { prompt, text: prompt, textLocalPrompt: prompt, promptResolved: '',
        promptMentions: [], textLocalMentions: [], textUseUpstream: parameters.textUseUpstream ?? false });
    }
    if (node.type === 'llm' && args.prompt !== undefined) data.userPrompt = args.prompt;
    if (args.model !== undefined) {
      if (node.type === 'image') Object.assign(data, { model: 'greenroom-image', apiModel: args.model });
      else if (node.type === 'video') Object.assign(data, { mainId: 'greenroom-video', model: args.model });
      else if (['greenroom-selected', 'rh-tools'].includes(node.type)) data.rhToolsActiveAppId = args.model;
      else data.model = args.model;
    }
    return data;
  };
  const canvasId = { canvasId: text('画布 ID；省略时使用最近画布。') };
  register('t8_canvas_capabilities', '查询平台已配置的模型、节点、RH应用和节点可配置参数。', {},
    async (_args, exec) => ({ success: true, data: await canvasRequest('/api/greenroom/capabilities', exec) }), true);
  register('t8_canvas_list', '列出本人已有的 T8 画布。', {},
    async (_args, exec) => ({ success: true, data: await canvasRequest('/api/canvas', exec) }), true);
  register('t8_canvas_create', '创建新的 T8 画布。', { name: text('画布名称。', true) },
    async (args, exec) => ({ success: true, data: await canvasRequest('/api/canvas', exec, { method: 'POST', body: { name: args.name } }) }));
  register('t8_canvas_get_state', '读取画布节点、完整业务参数、素材、连线、状态和版本。', canvasId,
    async (args, exec) => ({ success: true, data: (await canvas(args, exec)).document }), true);
  const nodeParameters = { ...canvasId, prompt: text('提示词或文本。'), model: text('实际模型 ID；RH节点填写已配置应用 ID。'),
    title: text('节点标题。'), parameters: objectParameter('按 t8_canvas_capabilities 返回的节点参数配置。') };
  register('t8_canvas_create_node', '添加文本、素材、托管生成、Output/FramePair 或只支持草稿脚本的 director-storyboard 节点。', {
    ...nodeParameters, type: text('节点类型：text、upload、material-set、llm、image、video、output、frame-pair、greenroom-selected、director-storyboard（仅草稿，不能托管生成）。FramePair 从连接的成员视频资产抽帧；无视频时可转发已有首尾帧。', true),
    x: { type: 'number', description: 'X坐标。' }, y: { type: 'number', description: 'Y坐标。' },
  }, async (args, exec) => {
    if (!CONFIG_FIELDS[args.type]) throw new Error('节点类型未在平台配置');
    const { id, document } = await canvas(args, exec);
    const defaults = await canvasRequest('/api/greenroom/defaults/' + encodeURIComponent(args.type), exec);
    const nodeId = 'node-' + randomUUID();
    const node = { id: nodeId, type: args.type, position: {
      x: args.x ?? ((document.nodes || []).reduce((max, item) => Math.max(max, item.position?.x || 0), -260) + 360), y: args.y ?? 100,
    }, data: { ...defaults } };
    Object.assign(node.data, configure(node, args));
    const saved = await mutate(id, document, [{ type: 'node.add', payload: { node } }], exec);
    return { success: true, data: { canvasId: id, nodeId, revision: saved.document?.revision } };
  });
  register('t8_canvas_update_node', '修改节点的提示词、模型、标题及受支持的业务参数。', {
    ...nodeParameters, nodeId: text('节点 ID。', true),
  }, async (args, exec) => {
    const { id, document } = await canvas(args, exec);
    const node = document.nodes.find((item) => item.id === args.nodeId);
    if (!node) throw new Error('节点不存在');
    const saved = await mutate(id, document, [{ type: 'node.patch', payload: { nodeId: node.id, dataPatch: configure(node, args) } }], exec);
    return { success: true, data: { canvasId: id, nodeId: node.id, revision: saved.document?.revision } };
  });
  register('t8_canvas_connect_nodes', '连接两个节点的输出和输入，后台执行会解析该素材依赖。', {
    ...canvasId, sourceNodeId: text('源节点 ID。', true), targetNodeId: text('目标节点 ID。', true),
    sourceHandle: text('源端口，可省略。'), targetHandle: text('目标端口，可省略。'),
  }, async (args, exec) => {
    const { id, document } = await canvas(args, exec);
    for (const nodeId of [args.sourceNodeId, args.targetNodeId]) if (!document.nodes.some((node) => node.id === nodeId)) throw new Error(`节点不存在：${nodeId}`);
    const edge = { id: 'edge-' + randomUUID(), source: args.sourceNodeId, target: args.targetNodeId,
      sourceHandle: args.sourceHandle || null, targetHandle: args.targetHandle || null };
    await mutate(id, document, [{ type: 'edge.add', payload: { edge } }], exec);
    return { success: true, data: { canvasId: id, edgeId: edge.id } };
  });
  register('t8_canvas_delete_node', '删除指定节点或连线；删除节点会同步移除关联连线。', {
    ...canvasId, nodeId: text('节点 ID。'), edgeId: text('连线 ID。'),
  }, async (args, exec) => {
    if (!args.nodeId && !args.edgeId) throw new Error('请提供 nodeId 或 edgeId');
    const { id, document } = await canvas(args, exec);
    const operations = args.nodeId ? [{ type: 'node.delete', payload: { nodeId: args.nodeId } }]
      : [{ type: 'edge.delete', payload: { edgeId: args.edgeId } }];
    await mutate(id, document, operations, exec);
    return { success: true, data: { canvasId: id, nodeId: args.nodeId, edgeId: args.edgeId } };
  });
  register('t8_canvas_batch_update_prompts', '为选定节点批量替换提示词或追加前后缀。', {
    ...canvasId, nodeIds: stringArray('目标节点；省略时匹配文本/LLM/图像/视频节点。'),
    prefix: text('提示词前缀。'), suffix: text('提示词后缀。'), replacePrompt: text('完整替换提示词。'),
  }, async (args, exec) => {
    const { id, document } = await canvas(args, exec);
    const selected = args.nodeIds?.length ? new Set(args.nodeIds) : null;
    const promptTypes = ['text', 'llm', 'image', 'video'];
    if (selected) for (const nodeId of selected) {
      const node = document.nodes.find((item) => item.id === nodeId);
      if (!node || !promptTypes.includes(node.type)) throw new Error(`节点 ${nodeId} 不支持托管批量提示词；DirectorStoryboard 请使用显式 ID 的专用草稿工具`);
    }
    const operations = document.nodes.filter((node) => selected ? selected.has(node.id) : promptTypes.includes(node.type))
      .map((node) => {
        const current = node.type === 'llm' ? node.data?.userPrompt ?? (node.data?.reply == null ? node.data?.prompt : '')
          : node.data?.prompt || node.data?.text;
        const prompt = args.replacePrompt ?? [args.prefix, current, args.suffix].filter(Boolean).join(', ');
        return { type: 'node.patch', payload: { nodeId: node.id, dataPatch: { prompt, text: prompt,
          ...(node.type === 'llm' ? { userPrompt: prompt } : {}),
          ...(node.type === 'text' ? { textLocalPrompt: prompt, textUseUpstream: false, promptResolved: '', promptMentions: [], textLocalMentions: [] } : {}) } } };
      });
    if (operations.length) await mutate(id, document, operations, exec);
    return { success: true, data: { canvasId: id, updatedCount: operations.length } };
  });
  register('t8_canvas_import_storyboard_scripts', '向已有导演分镜追加原生草稿脚本。必须提供稳定 shot ID；同 ID 同内容重试只读回，冲突拒绝。仅支持标题/文本/4–15 整数秒，不分割脚本、不计算摘要、不生成视频或改写已有任务。', {
    canvasId: text('原画布 ID，必填；不会创建默认画布。', true), nodeId: text('原 director-storyboard 节点 ID。', true),
    shots: { type: 'array', required: true, description: '已分段的脚本草稿；id 在首次调用前固定，重试沿用。', items: {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, title: { type: 'string' }, prompt: { type: 'string', required: true },
        durationSec: { type: 'integer', enum: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      },
    } },
  }, async (args, exec) => {
    if (typeof args.canvasId !== 'string' || !args.canvasId.trim() || typeof args.nodeId !== 'string' || !args.nodeId.trim()) throw new Error('必须提供原画布和分镜节点 ID');
    if (!Array.isArray(args.shots) || !args.shots.length) throw new Error('请提供非空脚本草稿数组');
    const ids = new Set();
    const drafts = args.shots.map((shot, index) => {
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) throw new Error('脚本必须为对象');
      for (const key of Object.keys(shot)) if (!['id', 'title', 'prompt', 'durationSec'].includes(key)) throw new Error(`脚本参数 ${key} 尚未接入；不接受素材、Provider、密钥或任务状态`);
      if (typeof shot.id !== 'string' || !shot.id.trim() || typeof shot.prompt !== 'string' || !shot.prompt.trim()) throw new Error('每段脚本必须提供稳定 ID 和非空文本');
      const id = shot.id.trim();
      if (ids.has(id)) throw new Error('同一批次不能有重复 shot ID');
      ids.add(id);
      if (shot.title !== undefined && typeof shot.title !== 'string') throw new Error('脚本标题必须为文本');
      const durationSec = shot.durationSec ?? 5;
      if (!Number.isInteger(durationSec) || durationSec < 4 || durationSec > 15) throw new Error('脚本时长必须为 4–15 整数秒');
      // Exact native draft fields from fixed v3.5.0 sanitizeDirectorStoryboardShots.
      // Explicit identity avoids the upstream importer's SHA-256-based identity.
      return { id, title: shot.title?.trim() || `S${index + 1}`, prompt: shot.prompt.trim(), durationSec,
        useUpstreamPrompt: false, negativePrompt: '', promptMentions: [], frameMode: 'auto',
        localRefImages: [], localRefVideos: [], localRefAudios: [], localRefOrder: [],
        taskId: null, taskProvider: null, videoUrl: null, error: null };
    });
    const { id, document } = await canvas(args, exec);
    const node = document.nodes.find((item) => item.id === args.nodeId);
    if (!node || node.type !== 'director-storyboard') throw new Error('目标不是原导演分镜节点');
    if (node.data?.shots != null && !Array.isArray(node.data.shots)) throw new Error('原脚本结构无效，不覆盖');
    const existing = node.data?.shots || [];
    const added = [], replayed = [];
    for (const draft of drafts) {
      const matches = existing.filter((shot) => shot?.id === draft.id);
      if (matches.length > 1) throw new Error(`原 shot ID ${draft.id} 不唯一，请先核对`);
      if (matches.length) {
        const prior = matches[0];
        if (prior.prompt !== draft.prompt || prior.title !== draft.title || prior.durationSec !== draft.durationSec || prior.useUpstreamPrompt !== false) throw new Error(`shot ID ${draft.id} 已有不同内容；保留原记录，不覆盖或生成新 ID 重试`);
        replayed.push(draft.id); // Preserve every existing task, asset and provider field verbatim.
      } else added.push(draft);
    }
    const busy = ['submitting', 'polling'].includes(node.data?.status)
      || (node.data?.bridges || []).some((bridge) => ['extracting', 'submitting', 'polling'].includes(bridge.status))
      || existing.some((shot) => ['submitting', 'polling'].includes(shot?.status));
    if (added.length && busy) throw new Error('原分镜任务仍在执行，不能追加；请先查询原任务');
    const saved = added.length ? await mutate(id, document, [{ type: 'node.patch', payload: {
      nodeId: node.id, dataPatch: { shots: [...existing, ...added] },
    } }], exec) : null;
    return { success: true, data: { canvasId: id, nodeId: node.id, addedIds: added.map((shot) => shot.id), replayedIds: replayed,
      revision: saved?.document?.revision ?? document.revision, execution: 'draft-only', generationSupported: false } };
  });
  register('t8_canvas_bind_asset', '把当前会话附件导入本人资产服务并绑定为节点参考素材。', {
    ...canvasId, nodeId: text('目标节点 ID。', true), attachmentId: text('当前会话附件 ID。', true),
  }, async (args, exec) => {
    const { id, document } = await canvas(args, exec);
    const node = document.nodes.find((item) => item.id === args.nodeId);
    if (!node) throw new Error('节点不存在');
    if (node.type === 'director-storyboard') throw new Error('导演分镜草稿的素材关联尚未接入，不导入附件');
    const asset = await importAttachment(ctx, exec, args.attachmentId);
    const kind = asset.mimeType.startsWith('video/') ? 'video' : asset.mimeType.startsWith('audio/') ? 'audio' : asset.mimeType.startsWith('image/') ? 'image' : 'document';
    if (kind === 'document') throw new Error('剧本文档请先读取后写入文本节点，图片音视频可直接绑定');
    let patch;
    if (node.type === 'upload') patch = { [kind + 'Url']: asset.fileUrl, mimeType: asset.mimeType, filename: asset.fileName };
    else if (node.type === 'material-set') patch = { materialSetItems: [...(node.data?.materialSetItems || []), { id: randomUUID(), kind, url: asset.fileUrl, name: asset.fileName }] };
    else if (node.type === 'llm' && kind === 'image') patch = { pickedFiles: [...(node.data?.pickedFiles || []), { name: asset.fileName, url: asset.fileUrl, dataUrl: asset.fileUrl }] };
    else {
      const field = node.type === 'image' && kind === 'image' ? 'referenceImages' : kind === 'image' ? 'localRefImages' : kind === 'video' ? 'localRefVideos' : 'localRefAudios';
      patch = { [field]: [...(node.data?.[field] || []), asset.fileUrl] };
    }
    await mutate(id, document, [{ type: 'node.patch', payload: { nodeId: node.id, dataPatch: patch } }], exec);
    return { success: true, data: { canvasId: id, nodeId: node.id, ...asset } };
  });
  const run = async (args, exec) => {
    const id = await resolveCanvasId(args.canvasId, exec);
    const result = await canvasRequest('/api/greenroom/runs', exec, { method: 'POST', body: {
      canvasId: id, nodeIds: args.nodeId ? [args.nodeId] : args.nodeIds, includeDependencies: args.includeDependencies !== false,
      submissionId: `dsh:${exec.agent?.session?.id || ''}:${exec.callId || randomUUID()}`,
    } });
    return { success: true, data: result, message: '任务由画布后端执行；使用 t8_canvas_get_run 查询，无需打开画布页面。' };
  };
  register('t8_canvas_run_node', '在后端运行指定节点及其上游依赖，返回可恢复的runId。', {
    ...canvasId, nodeId: text('节点 ID。', true), includeDependencies: { type: 'boolean', description: '是否同时运行上游生成节点，默认true。' },
  }, run);
  register('t8_canvas_run', '按连线依赖在后端运行选定托管节点，省略节点时运行整张托管生成图。', {
    ...canvasId, nodeIds: stringArray('目标节点 ID。'), includeDependencies: { type: 'boolean', description: '是否运行上游生成节点，默认true。' },
  }, run);
  register('t8_canvas_get_run', '查询托管运行各节点、原始任务编号、失败原因和已归档产物。', { runId: text('运行ID。', true) },
    async (args, exec) => ({ success: true, data: await canvasRequest('/api/greenroom/runs/' + encodeURIComponent(args.runId), exec) }), true);
  register('t8_canvas_list_runs', '列出指定画布最近最多100条托管运行及原submissionId；响应不明时先找原runId，不重新提交。', { canvasId: text('原画布ID；必填，不创建默认画布。', true) },
    async (args, exec) => {
      if (!args.canvasId) throw new Error('请提供原画布ID');
      return { success: true, data: await canvasRequest('/api/greenroom/runs?canvasId=' + encodeURIComponent(args.canvasId), exec) };
    }, true);
  register('t8_canvas_cancel_run', '停止该画布运行的后续步骤；已受理上游任务的编号仍保留。', { runId: text('运行ID。', true) },
    async (args, exec) => ({ success: true, data: await canvasRequest('/api/greenroom/runs/' + encodeURIComponent(args.runId), exec, { method: 'DELETE' }) }));
  register('t8_canvas_compose_videos', '用画布已有视频产物按给定顺序创建后台合成任务。', {
    ...canvasId, nodeIds: stringArray('视频节点ID，按成片顺序排列。'), settings: objectParameter('已有视频合成设置，例如width、height、fps。'),
  }, async (args, exec) => {
    const id = await resolveCanvasId(args.canvasId, exec);
    return { success: true, data: await canvasRequest('/api/greenroom/compose', exec, { method: 'POST', body: { canvasId: id, nodeIds: args.nodeIds, settings: args.settings || {} } }) };
  });
  register('t8_canvas_get_composition', '查询合成状态和已归档成片。', { jobId: text('合成任务编号。', true) },
    async (args, exec) => ({ success: true, data: await canvasRequest('/api/video-ops/jobs/' + encodeURIComponent(args.jobId), exec) }), true);
  register('t8_canvas_cancel_composition', '停止当前成员仍在执行的本地视频合成；已有本地成片正在或等待归档时不再取消，须继续查询；已终态保持原结果。以返回status为准，不取消模型供应商任务。', { jobId: text('原合成任务编号。', true) },
    async (args, exec) => ({ success: true, data: await canvasRequest('/api/video-ops/jobs/' + encodeURIComponent(args.jobId) + '/cancel', exec, { method: 'POST' }) }));
}
