import { topologicalSort } from './utils/topologicalSort';
import { selectSourceHandleData } from './utils/sourceHandleData';
import { collectUpstreamMaterials } from './components/nodes/greenroomUpstreamMaterials';
import { resolveMediaMentions } from './components/nodes/mediaMentions';
import { resolveTextNodeInput, textInputHasCycle } from './utils/textNodeInput';
import { isMaterialSetKind, normalizeMaterialSetItems, materialSetItemsToData } from './utils/materialSet';
import { syncMaterialSetUpstream } from './utils/materialSetUpstream';

type CanvasNode = { id: string; type?: string; data?: Record<string, any>; [key: string]: any };
type CanvasEdge = { source: string; target: string; sourceHandle?: string | null; [key: string]: any };
export type ManagedGraph = { nodes: CanvasNode[]; edges: CanvasEdge[] };
type Catalog = Record<'llm' | 'image' | 'video', Array<{ id: string; label?: string; capabilities?: any }>>;
type Material = { id: string; kind: 'text' | 'image' | 'video' | 'audio'; url: string };

export const MANAGED_RELAY_TYPES = new Set(['output', 'frame-pair']);
export const MANAGED_EXECUTABLE_TYPES = new Set(['output', 'frame-pair', 'llm', 'image', 'video', 'greenroom-selected', 'rh-tools', 'runninghub', 'runninghub-wallet']);
export const MANAGED_INPUT_TYPES = new Set(['text', 'prompt', 'upload', 'image-input', 'video-input', 'audio-input', 'material-set']);

export function isManagedNode(node: CanvasNode): boolean {
  const d = node.data || {};
  if (MANAGED_RELAY_TYPES.has(node.type || '')) return true;
  if (d.providerSource && d.providerSource !== 'zhenzhen') return false;
  if (node.type === 'llm') return d.llmApiSource !== 'seedance-nz';
  if (node.type === 'image') return d.model === 'greenroom-image' && d.imageBuiltinSource !== 'seedance-nz';
  if (node.type === 'video') return d.mainId === 'greenroom-video' && d.videoBuiltinSource !== 'seedance-nz';
  return ['greenroom-selected', 'rh-tools', 'runninghub', 'runninghub-wallet'].includes(node.type || '')
    && (d.rhToolsActiveAppId || d.webappId) === 'greenroom-rh-upscale';
}

export function managedDependencies(graph: ManagedGraph, nodeIds: string[]): Record<string, string[]> {
  const executable = new Set(nodeIds);
  return Object.fromEntries(nodeIds.map((id) => {
    const dependencies = new Set<string>();
    const visited = new Set<string>();
    const visit = (target: string) => {
      for (const edge of graph.edges) if (edge.target === target && !visited.has(edge.source)) {
        visited.add(edge.source);
        if (executable.has(edge.source)) dependencies.add(edge.source);
        else visit(edge.source);
      }
    };
    visit(id);
    return [id, [...dependencies]];
  }));
}

export function managedOrder(graph: ManagedGraph, requested?: string[], includeDependencies = true): string[] {
  const ids = new Set(requested?.length ? requested : graph.nodes.filter(isManagedNode).map((node) => node.id));
  for (const id of ids) if (!graph.nodes.some((node) => node.id === id)) throw new Error(`画布节点不存在：${id}`);
  if (includeDependencies) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of graph.edges) if (ids.has(edge.target) && !ids.has(edge.source)) {
        ids.add(edge.source); changed = true;
      }
    }
  }
  const selected = graph.nodes.filter((node) => ids.has(node.id));
  const executable = selected.filter((node) => MANAGED_EXECUTABLE_TYPES.has(node.type || ''));
  for (const node of executable) if (!isManagedNode(node)) throw new Error(`节点 ${node.id} 尚未配置托管业务能力`);
  for (const node of selected) if (!MANAGED_EXECUTABLE_TYPES.has(node.type || '') && !MANAGED_INPUT_TYPES.has(node.type || '')) {
    throw new Error(`节点 ${node.id} 的类型 ${node.type} 不属于已配置的托管执行能力`);
  }
  const dependencies = managedDependencies(graph, executable.map((node) => node.id));
  const edges = Object.entries(dependencies).flatMap(([target, sources]) => sources.map((source) => ({ source, target })));
  const order = topologicalSort(selected as any, edges as any, MANAGED_EXECUTABLE_TYPES);
  const position = new Map(order.map((id, index) => [id, index]));
  if (edges.some((edge) => position.has(edge.source) && position.has(edge.target)
    && position.get(edge.source)! >= position.get(edge.target)!)) throw new Error('生成节点连线存在循环，无法按依赖运行');
  return order;
}

// Text/MaterialSet publish input changes in browser effects upstream. Resolve
// those effects from the frozen run graph after producers have been replayed or
// completed. Never read the live canvas or mutate the original run snapshot.
export function managedInputData(graph: ManagedGraph, nodeId: string, visiting = new Set<string>()): Record<string, any> {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`上游节点不存在：${nodeId}`);
  const data = node.data || {};
  if (!['text', 'material-set'].includes(node.type || '')) return data;
  if (textInputHasCycle(nodeId, graph.edges, graph.nodes)) throw new Error('输入节点连线存在循环，无法同步冻结图');
  if (visiting.has(nodeId)) throw new Error('输入节点连线存在循环，无法同步冻结图');
  const nextVisiting = new Set(visiting).add(nodeId);
  const incoming = graph.edges.filter((edge) => edge.target === nodeId);
  const handles = new Map<string, Set<string | null>>();
  const targets = new Map<string, Set<string>>();
  for (const edge of incoming) {
    if (!handles.has(edge.source)) handles.set(edge.source, new Set());
    handles.get(edge.source)!.add(edge.sourceHandle || null);
    if (!targets.has(edge.source)) targets.set(edge.source, new Set());
    if (edge.targetHandle) targets.get(edge.source)!.add(edge.targetHandle);
    if (!graph.nodes.some((source) => source.id === edge.source)) throw new Error(`上游节点不存在：${edge.source}`);
  }
  const upstreamNodes = [...handles.keys()].map((id) => {
    const source = graph.nodes.find((item) => item.id === id)!;
    return { ...source, data: managedInputData(graph, id, nextVisiting) };
  });
  const upstream = collectUpstreamMaterials(upstreamNodes, handles, targets, [{ data }]);
  if (node.type === 'text') {
    const input = resolveTextNodeInput(data, upstream.texts);
    const promptResolved = input.mentions.length
      ? resolveMediaMentions(input.text, input.mentions, [...upstream.images, ...upstream.videos, ...upstream.audios, ...upstream.texts]) : '';
    return { ...data, ...input.patch, promptResolved };
  }
  const kind = data.materialSetKind;
  if (!isMaterialSetKind(kind) || !data.materialSetSyncUpstream || !incoming.length) return data;
  const bucket = { text: upstream.texts, image: upstream.images, video: upstream.videos, audio: upstream.audios }[kind];
  const items = syncMaterialSetUpstream(normalizeMaterialSetItems(data.materialSetItems, kind), bucket, {
    excluded: Array.isArray(data.materialSetExcludedUpstream) ? data.materialSetExcludedUpstream : [],
  });
  return { ...data, ...materialSetItemsToData(kind, items) };
}

export function collectManagedMaterials(graph: ManagedGraph, nodeId: string): Material[] {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`画布节点不存在：${nodeId}`);
  const result: Material[] = [];
  const seen = new Set<string>();
  const push = (source: string, kind: Material['kind'], value: unknown, key?: string) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const url = value.trim();
    const identity = key || `${kind}:${url}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    result.push({ id: `${source}::${key || identity}`, kind, url });
  };
  const collect = (source: string, d: Record<string, any>, local = false, type = '') => {
    if (!local) {
      if (type === 'material-set' && Array.isArray(d.materialSetItems)) {
        d.materialSetItems.forEach((item: any, index: number) => push(source, item.kind, item.text || item.url, `material-set:${source}:${item.id && d.materialSetItems.filter((entry: any) => entry.id === item.id).length === 1 ? item.id : index}`));
        return;
      }
      const text = d.outputText || d.reply || d.promptResolved || d.prompt || d.text;
      // OutputNode publishes its already-selected display payload (pickKind/pickIndex).
      // Consume that payload, not the original producer's full output list.
      if (['text', 'prompt', 'llm', 'output'].includes(type)) {
        const list = d.textSegments || d.texts || d.segments;
        if (Array.isArray(list)) list.forEach((value) => push(source, 'text', value));
        else push(source, 'text', text);
      }
      for (const [kind, fields] of Object.entries({ image: ['imageUrl', 'imageUrls', 'generatedImages', 'directImageUrl'],
        video: ['videoUrl', 'videoUrls', 'directVideoUrl'], audio: ['audioUrl', 'audioUrl_1', 'audioUrls', 'directAudioUrl'] })) {
        for (const field of fields) {
          if (type === 'output' && field.startsWith('direct')) continue;
          for (const value of Array.isArray(d[field]) ? d[field] : [d[field]]) push(source, kind as Material['kind'], value);
        }
      }
      if (Array.isArray(d.urls)) d.urls.forEach((url) => {
        if (type === 'output') { push(source, 'image', url); return; }
        const kind = type === 'video' || [d.videoUrl, ...(d.videoUrls || [])].includes(url) ? 'video'
          : [d.audioUrl, d.audioUrl_1, ...(d.audioUrls || [])].includes(url) ? 'audio'
          : /\.(mp4|webm|mov|mkv)(?:[?#]|$)/i.test(url) ? 'video'
          : /\.(mp3|wav|m4a|ogg|aac|flac)(?:[?#]|$)/i.test(url) ? 'audio' : 'image';
        push(source, kind, url);
      });
    }
    if (MANAGED_RELAY_TYPES.has(node.type || '')) return;
    for (const [kind, fields] of Object.entries({ image: ['referenceImages', 'localRefImages'],
      video: ['referenceVideos', 'localRefVideos'], audio: ['referenceAudios', 'localRefAudios', 'localRefAudio'] })) {
      for (const field of fields) for (const value of Array.isArray(d[field]) ? d[field] : [d[field]]) push(source, kind as Material['kind'], value);
    }
    for (const file of d.pickedFiles || []) push(source, 'image', file.url || file.dataUrl);
    for (const item of d.materialSetItems || []) push(source, item.kind, item.text || item.url);
  };
  const incoming = graph.edges.filter((edge) => edge.target === nodeId);
  for (const sourceId of new Set(incoming.map((edge) => edge.source))) {
    const source = graph.nodes.find((item) => item.id === sourceId);
    if (!source) throw new Error(`上游节点不存在：${sourceId}`);
    const handles = new Set(incoming.filter((edge) => edge.source === sourceId).map((edge) => edge.sourceHandle || null));
    for (const data of selectSourceHandleData(managedInputData(graph, source.id), handles)) {
      if (node.type === 'output' && data.__loopAccumulate) continue;
      if ('firstFrameUrl' in data && 'lastFrameUrl' in data) {
        if (handles.has('first') || (handles.has(null) && !handles.has('last'))) push(source.id, 'image', data.firstFrameUrl);
        if (handles.has('last') || (handles.has(null) && !handles.has('first'))) push(source.id, 'image', data.lastFrameUrl);
      } else if ('audioUrl' in data && 'audioUrl_1' in data && (handles.has('audio-0') || handles.has('audio-1'))) {
        if (handles.has('audio-0')) push(source.id, 'audio', data.audioUrl);
        if (handles.has('audio-1')) push(source.id, 'audio', data.audioUrl_1);
      } else collect(source.id, data, false, source.type);
    }
  }
  collect(node.id, node.data || {}, true, node.type);
  const order: string[] = node.data?.materialOrder || [];
  const rank = (material: Material) => {
    const index = order.findIndex((id) => id === material.id || id.endsWith(`:${material.url}`));
    return index < 0 ? order.length : index;
  };
  return result.sort((left, right) => rank(left) - rank(right));
}

// The browser OutputNode effect does not run in a frozen backend graph. Publish
// its selected payload here, after the producer completes and before consumers.
export function managedRelayPatch(graph: ManagedGraph, nodeId: string): Record<string, any> {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node || !MANAGED_RELAY_TYPES.has(node.type || '')) throw new Error('不是托管中转节点');
  const d = node.data || {};
  if (node.type === 'frame-pair') {
    if (!d.firstFrameUrl || !d.lastFrameUrl) throw new Error('FramePair 缺少输入视频或已有首尾帧');
    return { firstFrameUrl: d.firstFrameUrl, lastFrameUrl: d.lastFrameUrl, imageUrl: '', imageUrls: [],
      status: 'success', error: '', greenroomExecutionMode: 'existing-frames' };
  }
  const directOnly = d.directOutputSingleSnapshot === true || Boolean(d.rhDuckDecoded);
  const materials = directOnly ? [] : collectManagedMaterials(graph, nodeId);
  const values = (kind: Material['kind']) => materials.filter((item) => item.kind === kind).map((item) => item.url);
  const buckets = { text: values('text'), image: values('image'), video: values('video'), audio: values('audio') };
  for (const kind of ['image', 'video', 'audio'] as const) {
    const field = kind[0].toUpperCase() + kind.slice(1);
    for (const value of [d['direct' + field + 'Url'], ...(d['direct' + field + 'Urls'] || [])]) {
      if (typeof value === 'string' && value.trim() && !buckets[kind].includes(value.trim())) buckets[kind].push(value.trim());
    }
  }
  for (const value of [d.directOutputText, ...(d.directTextSegments || [])]) {
    if (typeof value === 'string' && value.trim() && !buckets.text.includes(value.trim())) buckets.text.push(value.trim());
  }
  const accumulated = ['directImageUrls', 'directVideoUrls', 'directAudioUrls', 'directTextSegments']
    .some((field) => Array.isArray(d[field]) && d[field].length > 1)
    || String(d.directOutputText || '').split('\n\n').filter((item) => item.trim()).length > 1;
  if (!directOnly && !accumulated && d.pickKind && typeof d.pickIndex === 'number') {
    for (const kind of ['image', 'video', 'audio', 'text'] as const) {
      buckets[kind] = kind === d.pickKind && buckets[kind][d.pickIndex] ? [buckets[kind][d.pickIndex]] : [];
    }
  }
  for (const kind of ['image', 'video', 'audio'] as const) buckets[kind] = buckets[kind].filter((url) => !d.hiddenMaterialUrls?.[kind]?.includes(url));
  const hasMedia = buckets.image.length || buckets.video.length || buckets.audio.length;
  const override = typeof d.outputText === 'string' ? d.outputText.trim() : '';
  const texts = hasMedia ? [] : override ? [override] : buckets.text;
  const text = texts.join('\n\n');
  // outputText is the official UI's user-edited override, never a relay cache.
  return { prompt: text, promptResolved: text, text, reply: text, textSegments: texts, segments: texts,
    imageUrl: buckets.image[0] || '', imageUrls: buckets.image, urls: buckets.image,
    videoUrl: buckets.video[0] || '', videoUrls: buckets.video,
    audioUrl: buckets.audio[0] || '', audioUrl_1: buckets.audio[1] || '', audioUrls: buckets.audio,
    status: 'success', error: '', greenroomExecutionMode: 'headless-relay' };
}

export function managedNodeDefaults(type: string, catalog: Catalog): Record<string, any> {
  if (type === 'frame-pair') return { firstFrameUrl: '', lastFrameUrl: '', status: 'idle' };
  if (type === 'output') return {};
  if (type === 'image') return { model: 'greenroom-image', apiModel: catalog.image[0]?.id || '__unconfigured__', aspectRatio: '1:1', sizeLevel: '1024x1024' };
  if (type === 'video') return { mainId: 'greenroom-video', model: catalog.video[0]?.id || '__unconfigured__', ratio: '16:9', duration: 5, resolution: '720p' };
  if (type === 'llm') return { model: catalog.llm[0]?.id || '__unconfigured__' };
  if (type === 'greenroom-selected') return { rhToolsActiveAppId: 'greenroom-rh-upscale', paramValues: {}, status: 'idle' };
  return {};
}

export function buildManagedRequest(graph: ManagedGraph, nodeId: string, catalog: Catalog) {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node || !isManagedNode(node)) throw new Error(`节点 ${nodeId} 未配置托管执行能力`);
  const d = node.data || {};
  const materials = collectManagedMaterials(graph, nodeId);
  const values = (kind: Material['kind']) => materials.filter((item) => item.kind === kind).map((item) => item.url);
  const localPrompt = node.type === 'llm'
    ? String(d.userPrompt ?? (d.reply == null && typeof d.prompt === 'string' ? d.prompt : ''))
    : String(d.prompt || d.text || d.localPrompt || '');
  const prompt = (values('text').join('\n\n') || localPrompt).trim();
  const images = values('image'), videos = values('video'), audios = values('audio');
  if (node.type === 'greenroom-selected' || node.type === 'rh-tools' || node.type === 'runninghub' || node.type === 'runninghub-wallet') {
    const field = (name: string) => {
      const value = d.paramValues?.[`rh-upscale::${name}`] ?? d.paramValues?.[name]
        ?? d.appInfo?.nodeInfoList?.find((item: any) => item.fieldName === name)?.fieldValue;
      return value && typeof value === 'object' ? value.value : value;
    };
    const fileUrl = videos[0] || field('inputVideo');
    if (!fileUrl) throw new Error('RH Upscale 缺少输入视频，请绑定素材或连接上游视频节点');
    return { kind: 'runninghub', path: '/canvas/api/greenroom/runninghub/submit', body: { fileUrl,
      model: field('model') || 'max', resolution: field('resolution') || '1080p', outputFps: field('outputFps') || '1x' } };
  }
  const kind = node.type as 'llm' | 'image' | 'video';
  const model = kind === 'image' ? d.apiModel : d.model;
  if (!catalog[kind].some((item) => item.id === model)) throw new Error(`模型 ${model || '未选择'} 未在当前平台开通`);
  if (!prompt && !(kind === 'llm' && images.length)) throw new Error(`节点 ${nodeId} 缺少提示词`);
  if (kind === 'llm') {
    const content: any[] = [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
    const system = d.system ?? '你是一个提示词专家，将用户的提示词优化';
    return { kind, path: '/v1/chat/completions', body: { model, stream: false,
      messages: [...(system ? [{ role: 'system', content: String(system) }] : []), { role: 'user', content }],
      temperature: typeof d.temperature === 'number' ? d.temperature : 0.7,
      ...(typeof d.maxTokens === 'number' ? { max_tokens: d.maxTokens } : {}) } };
  }
  const references = { ...(images.length ? { images } : {}), ...(videos.length ? { reference_video_urls: videos } : {}), ...(audios.length ? { reference_audio_urls: audios } : {}) };
  return { kind, path: `/canvas/api/proxy/${kind}/submit`, body: { model, prompt, ...references,
    ...(kind === 'image' ? { size: d.sizeLevel || d.size || '1024x1024', aspect_ratio: d.aspectRatio === 'Auto' ? undefined : d.aspectRatio,
      n: Math.max(1, Math.min(4, Number(d.n || d.batchSize || 1))) } : { aspect_ratio: d.ratio || d.aspect_ratio || '16:9',
      duration: Number(d.duration || 5), resolution: d.resolution || '720p' }) } };
}

export function managedResultPatch(type: string, outputs: Array<{ sourceUrl?: string; text?: string; kind?: string }>) {
  const urls = outputs.filter((output) => output.sourceUrl).map((output) => output.sourceUrl!);
  if (type === 'llm') return { status: 'success', error: '', reply: outputs.map((output) => output.text || '').join('\n'),
    prompt: outputs.map((output) => output.text || '').join('\n'), outputText: outputs.map((output) => output.text || '').join('\n') };
  if (type === 'image') return { status: 'success', error: '', progress: '100%', imageUrl: urls[0] || '', imageUrls: urls, generatedImages: urls };
  return { status: 'success', error: '', progress: '100%', videoUrl: urls[0] || '', videoUrls: urls, urls };
}
