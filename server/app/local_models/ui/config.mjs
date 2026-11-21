const ID = /^[A-Za-z0-9_-]{1,128}$/;
const METHODS = new Set(['POST', 'PUT', 'GET', 'PATCH']);
const KINDS = new Set(['image', 'video', 'text', 'audio']);
const RESERVED_HEADERS = new Set(['host','cookie','content-type','content-length','connection','transfer-encoding','proxy-authorization','origin','referer']);
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function jsonObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label}必须是有效 JSON 对象`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象`);
  return parsed;
}

function endpoint(value, label, allowHttp, poll = false) {
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(poll ? raw.replaceAll('{task_id}', 'TASK_ID') : raw); }
  catch { throw new Error(`${label}必须是完整 HTTP / HTTPS 地址`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${label}不支持此协议、用户名密码或片段；Key 请放在认证栏`);
  }
  if (url.protocol === 'http:' && !allowHttp) throw new Error('使用 HTTP 前请明确确认明文传输风险');
  return raw;
}

function fieldPath(value, label) {
  const path = String(value || '').trim();
  if (!path || path.length > 256 || path.split('.').some(p => !p || UNSAFE.has(p))) throw new Error(`${label}必须是非空点分字段路径`);
  return path;
}

function pointer(value, label, wildcard = false) {
  const path = String(value || '').trim();
  if (!path) return '';
  if (!path.startsWith('/') || /~(?![01])/u.test(path) || (!wildcard && path.split('/').includes('*'))) {
    throw new Error(`${label}必须是 JSON Pointer（例如 /data/id）；* 仅用于结果数组`);
  }
  return path;
}

function values(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw || '[]')); } catch { throw new Error('状态值必须是 JSON 数组，例如 ["succeeded",200,true]'); }
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' && typeof value !== 'boolean' && !Number.isSafeInteger(value))) {
    throw new Error('状态值仅支持字符串、布尔值或安全范围内的整数 JSON 数组');
  }
  return [...new Map(parsed.map(value => [JSON.stringify(value),value])).values()];
}

export function formToProfile(form) {
  const id = String(form.id || '').trim();
  if (!ID.test(id)) throw new Error('配置 ID 仅允许 1–128 个英文字母、数字、下划线和连字符');
  if (!String(form.name || '').trim() || [...String(form.name)].length > 100) throw new Error('请填写不超过 100 字的显示名称');
  if (!KINDS.has(form.kind) || !METHODS.has(form.method)) throw new Error('不支持的能力或请求方法');
  if (!['json', 'multipart'].includes(form.encoding)) throw new Error('不支持的请求格式');
  const fields = Object.create(null), files = Object.create(null), targets = new Set();
  for (const row of form.inputs || []) {
    const target = fieldPath(row.target, '请求字段'), source = fieldPath(row.source, '运行输入字段');
    if (targets.has(target)) throw new Error(`请求字段 ${target} 重复映射`);
    targets.add(target);
    if (row.type === 'file') {
      if (form.encoding !== 'multipart') throw new Error('文件字段需要 multipart/form-data');
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(target)) throw new Error('文件字段名仅支持 1–100 个字母、数字、点、下划线或连字符');
      files[target] = source;
    } else if (row.type === 'json') fields[target] = source;
    else throw new Error('不支持的输入字段类型');
  }
  if (form.method === 'GET' && form.encoding === 'multipart') throw new Error('GET 不支持文件上传，请选择 POST 或 PUT');
  const outputs = (form.outputs || []).map(row => {
    if (!KINDS.has(row.type) || row.type !== form.kind) throw new Error('本候选单配置只映射其声明类型，混合结果需专用适配；不要为领取原结果重复生成');
    const path = pointer(row.path, '结果路径', true);
    if (!path) throw new Error('本候选不支持根标量结果，请配置非空结果 JSON Pointer');
    return { type: row.type, path };
  });
  if (!outputs.length) throw new Error('请至少配置一个结果映射');
  const auth = { type: form.authType };
  if (!['none', 'bearer', 'header'].includes(auth.type)) throw new Error('不支持的认证方式；特殊签名需专用适配');
  if (auth.type === 'header') {
    auth.header = String(form.authHeader || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9-]{0,80}$/.test(auth.header) || RESERVED_HEADERS.has(auth.header.toLowerCase())) throw new Error('Key 请求头名称不受支持：不能使用保留头，最多 81 个字母、数字或连字符');
  }
  const response = {
    task_id_path: pointer(form.taskIdPath, '任务编号路径') || null,
    status_path: pointer(form.statusPath, '状态路径') || null,
    error_path: pointer(form.errorPath, '失败原因路径') || null,
    success_values: values(form.successValues), failure_values: values(form.failureValues),
    not_accepted_values: values(form.notAcceptedValues), outputs,
  };
  const states = [...response.success_values, ...response.failure_values, ...response.not_accepted_values];
  if (new Set(states.map(value => JSON.stringify(value))).size !== states.length) throw new Error('成功、失败、未受理状态不能重叠');
  if (states.length && !response.status_path) throw new Error('配置状态值时必须提供状态路径');
  const profile = { id, name: form.name.trim(), kind: form.kind, allow_private_network: Boolean(form.allowPrivate), request: {
    url: endpoint(form.url, '提交地址', form.allowHttp), method: form.method, encoding: form.encoding,
    constants: jsonObject(form.constants, '固定参数'), fields, files,
  }, auth, response };
  if (String(form.pollUrl || '').trim()) {
    if (!response.task_id_path) throw new Error('异步查询需要原任务编号映射');
    if (!['GET', 'POST'].includes(form.pollMethod)) throw new Error('查询仅支持 GET 或 POST');
    profile.poll = { url: endpoint(form.pollUrl, '查询地址', form.allowHttp, true), method: form.pollMethod,
      constants: jsonObject(form.pollConstants || '{}', '查询固定参数') };
    if (String(form.pollIdField || '').trim()) profile.poll.task_id_field = fieldPath(form.pollIdField, '查询任务编号字段');
    if (!form.pollUrl.includes('{task_id}') && !profile.poll.task_id_field) throw new Error('查询地址或字段须包含原 task_id');
    const submitUrl = new URL(profile.request.url), pollUrl = new URL(profile.poll.url.replaceAll('{task_id}', 'TASK_ID'));
    if (submitUrl.origin !== pollUrl.origin || profile.poll.url.split('/').slice(0,3).join('/').includes('{task_id}')) throw new Error('查询地址必须与提交地址同源，任务编号不能改变主机');
  }
  return profile;
}

export function profileToForm(profile = {}) {
  profile = profile || {};
  const r = profile.request || {}, s = profile.response || {}, p = profile.poll || {};
  return {
    id: profile.id || '', name: profile.name || '', kind: profile.kind || 'image',
    method: r.method || 'POST', url: r.url || '', encoding: r.encoding || 'json',
    constants: JSON.stringify(r.constants || {}, null, 2), authType: profile.auth?.type || 'none',
    authHeader: profile.auth?.header || '', allowHttp: false, allowPrivate: profile.allow_private_network === true,
    inputs: [...Object.entries(r.fields || {}).map(([target, source]) => ({target, source, type:'json'})),
      ...Object.entries(r.files || {}).map(([target, source]) => ({target, source, type:'file'}))],
    outputs: s.outputs || [{type:profile.kind || 'image',path:'/data/url'}],
    taskIdPath: s.task_id_path || '', statusPath: s.status_path || '', errorPath: s.error_path || '',
    successValues: JSON.stringify(s.success_values || []), failureValues: JSON.stringify(s.failure_values || []),
    notAcceptedValues: JSON.stringify(s.not_accepted_values || []),
    pollUrl: p.url || '', pollMethod: p.method || 'GET', pollIdField: p.task_id_field || '',
    pollConstants: JSON.stringify(p.constants || {}, null, 2),
  };
}

export function keyUpdate(profile, key, clear) {
  if (key && clear) throw new Error('不能同时替换和清除 Key');
  if (key && profile.auth.type === 'none') throw new Error('无认证配置不会保存 Key，请先选择认证方式');
  return { profile, ...(key ? {api_key:key} : {}), ...(clear ? {clear_key:true} : {}) };
}

export function newRequestId(now = Date.now, random = Math.random) {
  return `ui-${now().toString(36)}-${random().toString(36).slice(2,12)}`;
}

export function createApi(fetcher = globalThis.fetch) {
  async function call(path, method = 'GET', body) {
    let response;
    try { response = await fetcher(`/api/local-models${path}`, {
      method, credentials:'same-origin', cache:'no-store', redirect:'error',
      headers: body === undefined ? {} : {'Content-Type':'application/json'},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    }); } catch { throw new Error('本机服务回执未收到；请读取原编号确认，不要自动重发'); }
    let data;
    try { data = await response.json(); } catch { throw new Error(`本机服务返回不可读回执（HTTP ${response.status}）；请按原编号确认`); }
    if (!response.ok) {
      // Only the service's deliberately sanitized message is displayed, never a raw body/detail object.
      const message = typeof data?.error?.message === 'string' ? data.error.message : `本机服务拒绝请求（HTTP ${response.status}）`;
      throw new Error(message);
    }
    return data;
  }
  const idPath = id => {
    if (!ID.test(id)) throw new Error('请输入有效的本机请求或配置编号');
    return encodeURIComponent(id);
  };
  return {
    list: () => call('/profiles'),
    listRuns: () => call('/runs'),
    save: (id, body) => call(`/profiles/${idPath(id)}`, 'PUT', body),
    start: body => call('/runs', 'POST', body),
    read: id => call(`/runs/${idPath(id)}`),
    poll: id => call(`/runs/${idPath(id)}/poll`, 'POST', {}),
  };
}

// This per-page guard consumes the submit opportunity before fetch, including an unreadable receipt.
export class RunSession {
  constructor(api, requestId = newRequestId(), attempted = false) {
    this.api = api; this.id = requestId; this.attempted = attempted;
  }
  async submit(profileId, inputs, files, confirmed) {
    if (!confirmed) throw new Error('请明确确认新任务和可能的费用');
    if (this.attempted) throw new Error(`此编号已提交或受理未知，只能读取或查询原任务：${this.id}`);
    this.attempted = true;
    return this.api.start({request_id:this.id,profile_id:profileId,inputs,files});
  }
}

export function safeOutputUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export const STATE_LABELS = {
  not_accepted:'明确未受理（未自动重试）', acceptance_unknown:'受理未知（保留原编号，不重投）',
  accepted:'已受理（仅查询原任务）', succeeded:'服务商已返回成功结果', failed:'服务商明确失败（未自动重试）',
};
