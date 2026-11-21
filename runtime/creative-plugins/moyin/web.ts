// Greenroom web transport for the original Moyin renderer and its business services.
const base = import.meta.env.BASE_URL;
const nativeFetch = globalThis.fetch.bind(globalThis);
export async function request(path: string, body?: any) {
  const response = await nativeFetch(base + path.replace(/^\//, ''), { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || `HTTP ${response.status}`);
  return result;
}
const invoke = (channel: string, ...args: any[]) => request('api/greenroom/ipc', { channel, args });
const storageWrites = new Set<Promise<any>>();
const storageQueues = new Map<string, Promise<any>>();
const storageBaselines = new Map<string, string | null>();
const storageGenerations = new Map<string, number>();
const queuedSnapshots = new Map<string, any>();
let nextStorageGeneration = 0;
let storageEditVersion = 0;
let shotRefresh = Promise.resolve();
(globalThis as any).greenroomShotRefreshes = new Map();
const scriptKey = (key: string) => key === 'moyin-script-store' || /^_p\/.+\/script$/.test(key);
const adoptReads = (reads: Map<string, string | null>) => {
  const generation = ++nextStorageGeneration;
  for (const [key, value] of reads) { storageBaselines.set(key, value); storageGenerations.set(key, generation); }
};
const baselineFor = (key: string) => {
  const source = /^_p\/.+\/script$/.test(key) && storageBaselines.get(key) == null && storageBaselines.get('moyin-script-store') != null ? 'moyin-script-store' : key;
  return { value: storageBaselines.get(source) ?? null, generation: storageGenerations.get(source) ?? 0 };
};
(globalThis as any).greenroomBeginScriptRead = () => {
  const id = crypto.randomUUID(), reads = new Map<string, string | null>();
  const guard = { id, reads, ordinary: true, isCurrent: () => true,
    accept: () => { adoptReads(reads); (globalThis as any).greenroomShotRefreshes.delete(id); },
    cancel: () => (globalThis as any).greenroomShotRefreshes.delete(id) };
  (globalThis as any).greenroomShotRefreshes.set(id, guard);
  return guard;
};
(window as any).fileStorage = Object.fromEntries(Object.entries({ getItem: 'get', setItem: 'set', removeItem: 'remove', exists: 'exists', listKeys: 'list', listDirs: 'list-dirs', removeDir: 'remove-dir' }).map(([method, action]) => [method, (...args: any[]) => {
  const writing = ['set', 'remove', 'remove-dir'].includes(action);
  if (writing) storageEditVersion++;
  const key = String(args[0]);
  // Capture the renderer's state when its snapshot is produced. A read already
  // in flight may finish before this write is sent but was not yet rendered.
  const baseline = action === 'set' ? baselineFor(key) : undefined;
  const queued = action === 'set' ? queuedSnapshots.get(key) : undefined;
  const priorSnapshot = queued?.generation === baseline?.generation ? queued : undefined;
  const snapshot = action === 'set' ? { value: args[1], prior: priorSnapshot,
    baseline: priorSnapshot?.value ?? baseline?.value ?? null, generation: baseline?.generation ?? 0,
    failed: false } : undefined;
  if (snapshot) queuedSnapshots.set(key, snapshot);
  const previous = storageQueues.get(key) || Promise.resolve();
  const result = previous.catch(() => {}).then(async () => {
    if (action === 'get') {
      const value = await invoke('file-storage-get', args[0]);
      const refresh = args[1] && (globalThis as any).greenroomShotRefreshes.get(args[1]);
      if (refresh) refresh.reads.set(key, value); else if (!scriptKey(key)) adoptReads(new Map([[key, value]]));
      return value;
    }
    if (snapshot) {
      if (snapshot.prior?.failed) snapshot.baseline = snapshot.prior.baseline;
      let value;
      try { value = await invoke('file-storage-set', args[0], args[1], snapshot.baseline); }
      catch (error) { snapshot.failed = true; throw error; }
      // The renderer still holds its own state, even if the server merged a
      // newer background selection into the file.
      if (baselineFor(key).generation === snapshot.generation) { storageBaselines.set(key, args[1]); storageGenerations.set(key, snapshot.generation); }
      return value;
    }
    const value = await invoke('file-storage-' + action, ...args);
    if (action === 'remove') adoptReads(new Map([[key, null]]));
    if (action === 'remove-dir') for (const name of storageBaselines.keys()) if (name === key || name.startsWith(key + '/')) { storageBaselines.delete(name); storageGenerations.delete(name); }
    return value;
  });
  storageQueues.set(key, result);
  const release = () => { if (storageQueues.get(key) === result) storageQueues.delete(key); if (snapshot && queuedSnapshots.get(key) === snapshot) queuedSnapshots.delete(key); };
  result.then(release, release);
  if (writing) {
    storageWrites.add(result);
    result.then(() => storageWrites.delete(result), () => storageWrites.delete(result));
  }
  return result;
}]));
async function flushStorage() { while (storageWrites.size) await Promise.all([...storageWrites]); }
async function refreshShotView() {
  const refresh = shotRefresh.catch(() => {}).then(async () => {
    await flushStorage();
    const [{ useScriptStore }, { useProjectStore }] = await Promise.all([import('@/stores/script-store'), import('@/stores/project-store')]);
    const version = storageEditVersion;
    const projectId = useProjectStore.getState().activeProjectId;
    // The native async read can finish after a manual edit or project switch.
    // Its merge hook must discard that stale response, not just suppress writes.
    const reads = new Map<string, string | null>();
    const guard = { id: crypto.randomUUID(), reads, accept: () => adoptReads(reads), isCurrent: (currentProjectId: string) => storageEditVersion === version && currentProjectId === projectId && useProjectStore.getState().activeProjectId === projectId };
    (globalThis as any).greenroomShotRefreshes.set(guard.id, guard);
    try {
      // Native getItem and onRehydrateStorage capture this only for this call.
      (globalThis as any).greenroomShotReadOnlyRefresh = guard;
      let pending;
      try { pending = useScriptStore.persist.rehydrate(); }
      finally { delete (globalThis as any).greenroomShotReadOnlyRefresh; }
      await pending;
    } finally { (globalThis as any).greenroomShotRefreshes.delete(guard.id); }
  });
  shotRefresh = refresh;
  await refresh;
}

(window as any).imageStorage = {
  saveImage: (url: string, category: string, filename: string) => invoke('save-image', { url, category, filename }),
  getImagePath: (value: string) => invoke('get-image-path', value), deleteImage: (value: string) => invoke('delete-image', value),
  readAsBase64: (value: string) => invoke('read-image-base64', value), getAbsolutePath: (value: string) => invoke('get-absolute-path', value),
};
(window as any).electronAPI = { async saveFileDialog(options: any) { const href = options.localPath.startsWith('local-image://') ? await (window as any).imageStorage.getImagePath(options.localPath) : options.localPath; const a = document.createElement('a'); a.href = href; a.download = options.defaultPath?.split(/[\\/]/).pop() || 'moyin-export'; a.click(); return { success: true }; } };
(window as any).imageHostUploader = { upload: (payload: any) => invoke('image-host-upload', { imageData: payload.imageData, name: payload.options?.name }) };
(globalThis as any).greenroomDb = Object.fromEntries(['get','set','remove','list','clear'].map(operation => [operation, (namespace: string, key?: string, value?: any) => request('api/greenroom/db', { operation, namespace, key, value })]));
(globalThis as any).greenroomCatalog = { catalog: {}, models: { image: [], video: [], llm: [] }, parameters: {} };
const { useAPIConfigStore, AI_FEATURES } = await import('@/stores/api-config-store');
await useAPIConfigStore.persist.rehydrate();
const imageFeatures = new Set(['character_generation','scene_generation','freedom_image']);
const videoFeatures = new Set(['video_generation','freedom_video']);
async function refreshCatalog() {
  try {
    const response = await nativeFetch(base + 'api/greenroom/catalog', { signal: AbortSignal.timeout(10000) });
    const controlled = await response.json();
    if (!response.ok) throw new Error(controlled.error || '模型目录暂不可用');
    (globalThis as any).greenroomCatalog = controlled;
    useAPIConfigStore.setState({ providers: [{ id: 'greenroom', name: 'Greenroom 托管', platform: 'memefast', apiKey: 'greenroom-managed', baseUrl: base + 'managed/v1', model: Object.values(controlled.models).flat(), enabled: true }], featureBindings: Object.fromEntries(AI_FEATURES.map(item => [item.key, (controlled.models[imageFeatures.has(item.key) ? 'image' : videoFeatures.has(item.key) ? 'video' : 'llm'] || []).map((id: string) => 'memefast:' + id)])) } as any);
  } catch { setTimeout(() => void refreshCatalog(), 5000); }
}
void refreshCatalog();


async function hydrate() {
  const [{ useProjectStore }, { useScriptStore }, { useDirectorStore }, { useMediaStore }] = await Promise.all([import('@/stores/project-store'), import('@/stores/script-store'), import('@/stores/director-store'), import('@/stores/media-store')]);
  await useProjectStore.persist.rehydrate();
  await Promise.all([useScriptStore.persist.rehydrate(), useDirectorStore.persist.rehydrate(), useMediaStore.persist.rehydrate()]);
}
export async function business(operation: string, args: any) {
  const { useProjectStore } = await import('@/stores/project-store');
  const shotTask = operation === 'shot_image' || operation === 'shot_video';
  if (shotTask) await flushStorage();
  const task = await request('api/greenroom/submit', { operation, arguments: { projectId: useProjectStore.getState().activeProjectId, ...args }, submissionId: crypto.randomUUID() });
  for (let attempt = 0; attempt < 1800; attempt++) {
    const state = await request('api/greenroom/tasks/' + encodeURIComponent(task.taskId));
    if (state.state === 'succeeded') {
      if (shotTask) {
        await refreshShotView();
        if (state.result?.selection?.message) { const { toast } = await import('sonner'); toast.info(state.result.selection.message); }
      } else await hydrate();
      return state.result;
    }
    if (state.state === 'failed' || state.state === 'waiting') { if (shotTask) await refreshShotView(); else await hydrate(); throw new Error(state.error || '生成结果尚未确认；原任务编号：' + task.taskId); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('查询达到上限，任务仍保留在后台；原任务编号：' + task.taskId);
}
export async function media(kind: string, options: any) {
  const task = await request('api/greenroom/media/submit', { kind, options, submissionId: crypto.randomUUID() });
  for (let attempt = 0; attempt < 1800; attempt++) {
    const state = await request('api/greenroom/tasks/' + encodeURIComponent(task.taskId));
    if (state.state === 'succeeded') return { imageUrl: state.result.url, videoUrl: state.result.url, taskId: task.taskId };
    if (state.state === 'failed' || state.state === 'waiting') throw new Error(state.error || '生成结果尚未确认；原任务编号：' + task.taskId);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('查询达到上限，任务仍保留在后台；原任务编号：' + task.taskId);
}
(globalThis as any).greenroomBusiness = business;
(globalThis as any).greenroomMedia = media;
// Native text, video and image endpoint selection remains in Moyin; all calls terminate at the member service.
globalThis.fetch = (input: any, init?: RequestInit) => {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:18803/managed/')) url = base + url.split('http://127.0.0.1:18803/')[1];
  if (url.startsWith('local-image://')) return (window as any).imageStorage.getImagePath(url).then((value: string) => nativeFetch(value, init));
  return nativeFetch(url, init);
};
// Reloading the renderer reads the member's persisted state. This view also retains query errors and task IDs.
const inbox = document.createElement('details');
inbox.style.cssText = 'position:fixed;bottom:5px;right:5px;z-index:1000;background:#18181b;color:#eee;border:1px solid #555;padding:6px;font:12px sans-serif;max-width:560px;max-height:45vh;overflow:auto';
const title = document.createElement('summary'); title.textContent = 'Greenroom 后台任务 · 模型由管理员配置'; inbox.append(title);
const rows = document.createElement('div'); inbox.append(rows);
const legal = document.createElement('div');
for (const [label, href] of [['魔因漫创 · MemeCalculate', 'https://github.com/MemeCalculate/moyin-creator'], ['已修改版本 · 下载对应源码', base + '_greenroom/source']]) { const link = document.createElement('a'); link.textContent = label; link.href = href; link.target = '_blank'; link.style.cssText = 'display:block;color:#aaa;margin-top:6px'; legal.append(link); }
inbox.append(legal); document.body.append(inbox);
async function updateInbox() { const value = await request('api/greenroom/tasks'); rows.replaceChildren(); for (const task of [...value.jobs, ...value.media].slice(0, 30)) { const item = document.createElement('div'); item.style.cssText = 'border-top:1px solid #444;padding:5px;white-space:pre-wrap;overflow-wrap:anywhere'; item.textContent = `${task.operation || task.kind} · ${task.state}\n${task.id}${task.upstream_id ? '\n平台任务：' + task.upstream_id : ''}${task.error ? '\n' + task.error : ''}`; if (task.result) { const result = typeof task.result === 'string' ? JSON.parse(task.result) : task.result; if (result?.selection?.message) item.append(document.createTextNode('\n' + result.selection.message)); if (result?.url) { const link = document.createElement('a'); link.href = result.url; link.target = '_blank'; link.textContent = ' 查看成员私有产物'; link.style.color = '#93c5fd'; item.append(link); } } rows.append(item); } }
inbox.addEventListener('toggle', () => { if (inbox.open) void updateInbox(); });
setInterval(() => { if (inbox.open) void updateInbox(); }, 5000);
