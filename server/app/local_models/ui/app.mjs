import { createApi, formToProfile, profileToForm, keyUpdate, jsonObject, RunSession,
  newRequestId, MAX_FILE_BYTES, safeOutputUrl, STATE_LABELS } from './config.mjs';

const $ = id => document.getElementById(id);
const api = createApi();
let profiles = [], selectedId = '', loading = false, saving = false, submitting = false, querying = false;
let currentQuery = 0, loadingRuns = false;
const priorId = new URLSearchParams(location.hash.slice(1)).get('request');
let run = new RunSession(api, /^[A-Za-z0-9_-]{1,128}$/.test(priorId || '') ? priorId : newRequestId(), Boolean(priorId));

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'error' : '';
  $('notice').setAttribute('role', error ? 'alert' : 'status');
}
function element(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function option(value, label = value) {
  const el = element('option', label); el.value = value; return el;
}
function inputRow(row = {target:'', source:'', type:'json'}) {
  const container = element('div'); container.className = 'mapping-row';
  const fields = [['请求字段（点分）', 'target', row.target], ['运行输入名', 'source', row.source]];
  for (const [labelText, name, value] of fields) {
    const label = element('label', labelText), input = element('input');
    input.value = value; input.dataset.field = name; input.spellcheck = false; input.required = true;
    label.append(input); container.append(label);
  }
  const label = element('label', '类型'), select = element('select'); select.dataset.field = 'type';
  select.append(option('json','JSON 值'),option('file','文件')); select.value = row.type;
  label.append(select); container.append(label);
  const remove = element('button','移除'); remove.type = 'button'; remove.onclick = () => container.remove(); container.append(remove);
  $('input-mappings').append(container);
}
function outputRow(row = {type:'image', path:'/data/url'}) {
  const container = element('div'); container.className = 'mapping-row';
  const typeLabel = element('label','结果类型'), type = element('select'); type.dataset.field = 'type';
  for (const [value,label] of [['image','图片'],['video','视频'],['text','文本'],['audio','音频']]) type.append(option(value,label));
  type.value = row.type; typeLabel.append(type);
  const label = element('label','JSON Pointer'), path = element('input'); path.dataset.field = 'path'; path.value = row.path; path.placeholder = '/data/url'; path.required = true; path.spellcheck = false; label.append(path);
  const remove = element('button','移除'); remove.type = 'button'; remove.onclick = () => container.remove();
  container.append(typeLabel,label,remove); $('output-mappings').append(container);
}
function rows(id) {
  return [...$(id).children].map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input => [input.dataset.field,input.value])));
}
const controls = {
  id:'profile-id',name:'profile-name',kind:'kind',method:'method',url:'endpoint',encoding:'body-mode',constants:'fixed-json',
  authType:'auth',authHeader:'auth-header',taskIdPath:'task-id-path',statusPath:'status-path',errorPath:'error-path',
  successValues:'success-values',failureValues:'failed-values',notAcceptedValues:'not-accepted-values',
  pollUrl:'poll-url',pollMethod:'poll-method',pollIdField:'poll-id-field',pollConstants:'poll-constants',
};
function collectForm() {
  return {...Object.fromEntries(Object.entries(controls).map(([key,id]) => [key,$(id).value])),
    allowHttp:$('allow-http').checked,allowPrivate:$('allow-private').checked,
    inputs:rows('input-mappings'),outputs:rows('output-mappings')};
}
function authState() {
  const none = $('auth').value === 'none';
  $('key').disabled = none; $('auth-header').disabled = $('auth').value !== 'header';
  if (none) $('key').value = '';
}
function editProfile(profile) {
  const form = profileToForm(profile); selectedId = profile?.id || '';
  for (const [key,id] of Object.entries(controls)) $(id).value = form[key];
  $('profile-id').readOnly = Boolean(selectedId);
  $('allow-http').checked = false; $('allow-private').checked = form.allowPrivate;
  $('key').value = ''; $('clear-key').checked = false;
  $('key-status').textContent = profile?.has_key ? '服务端已配置 Key，留空保留。不提供读取或导出原 Key；旧任务仍使用自身冻结的配置。' : '未配置 Key。没有读取或导出已存 Key 的入口。';
  $('input-mappings').replaceChildren(); $('output-mappings').replaceChildren();
  for (const row of form.inputs.length ? form.inputs : [{target:'prompt',source:'prompt',type:'json'}]) inputRow(row);
  for (const row of form.outputs) outputRow(row);
  authState(); renderProfileList();
}
function confirmDiscard() {
  return !selectedId && !$('profile-id').value && !$('key').value || window.confirm('切换会放弃当前表单中未保存的修改和未保存 Key，继续？');
}
function renderProfileList() {
  $('profiles').replaceChildren();
  for (const profile of profiles) {
    const li = element('li'), button = element('button',`${profile.name} · ${profile.kind}`); button.type = 'button';
    if (profile.id === selectedId) button.className = 'selected';
    button.disabled = saving;
    button.onclick = () => { if (confirmDiscard()) editProfile(profile); };
    li.append(button); $('profiles').append(li);
  }
  const prior = $('run-profile').value;
  $('run-profile').replaceChildren(option('','请选择已保存配置'));
  for (const profile of profiles) $('run-profile').append(option(profile.id,`${profile.name} · ${profile.kind}`));
  if (profiles.some(profile => profile.id === prior)) $('run-profile').value = prior;
  else if (selectedId) $('run-profile').value = selectedId;
  renderRunFiles();
}
function renderRunFiles() {
  $('run-files').replaceChildren();
  const profile = profiles.find(value => value.id === $('run-profile').value);
  for (const name of new Set(Object.values(profile?.request?.files || {}))) {
    const label = element('label',`文件输入：${name}（本次文件总计不超过 10 MiB）`), input = element('input');
    input.type = 'file'; input.dataset.name = name; label.append(input); $('run-files').append(label);
  }
}
async function loadProfiles() {
  if (loading || saving) return;
  loading = true; $('reload').disabled = true;
  try {
    const data = await api.list();
    if (!Array.isArray(data.profiles)) throw new Error('配置回执缺少 profiles，未替换当前表单');
    profiles = data.profiles; renderProfileList();
    notice('已读取本机配置，未调用模型；当前编辑草稿不会被刷新覆盖。');
  } catch (error) { notice(error.message, true); }
  finally { loading = false; $('reload').disabled = false; }
}
async function saveProfile(event) {
  event.preventDefault(); if (saving) return;
  let profile, body;
  try { profile = formToProfile(collectForm()); body = keyUpdate(profile,$('key').value,$('clear-key').checked); }
  catch (error) { notice(error.message,true); return; }
  saving = true; $('profile-fields').disabled = true; $('new-profile').disabled = true;
  // Discard the only UI-held key as soon as the write starts. Never log/export it or retain it on a failed reply.
  $('key').value = '';
  try {
    await api.save(profile.id,body);
    const data = await api.list();
    if (!Array.isArray(data.profiles)) throw new Error('保存后的读回未确认，请重新读取本机配置；不会自动重发保存');
    profiles = data.profiles;
    const saved = profiles.find(value => value.id === profile.id);
    if (!saved) throw new Error('保存回执已收到，但读回未找到该配置，请重新读取确认');
    editProfile(saved);
    notice('配置已保存并从本机服务读回；未调用模型。Key 未回显。');
  } catch (error) { notice(`${error.message}。如果保存回执丢失，请先重新读取配置确认；Key 输入已清空。`,true); }
  finally { body = null; saving = false; $('profile-fields').disabled = false; $('new-profile').disabled = false; renderProfileList(); }
}
async function collectFiles() {
  const entries = [...$('run-files').querySelectorAll('input[type=file]')].filter(input => input.files?.[0]);
  const size = entries.reduce((sum,input) => sum + input.files[0].size,0);
  if (size > MAX_FILE_BYTES) throw new Error('文件总计不得超过 10 MiB');
  const files = Object.create(null);
  for (const input of entries) {
    const file = input.files[0], bytes = new Uint8Array(await file.arrayBuffer());
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset,offset+32768));
    files[input.dataset.name] = {name:file.name,mime:file.type || 'application/octet-stream',base64:btoa(binary)};
  }
  return files;
}
function runControls() {
  $('request-id').value = run.id;
  $('submit-run').disabled = submitting || run.attempted;
  $('new-run').disabled = submitting;
  $('confirm-submit').disabled = run.attempted || submitting;
}
function showRun(result) {
  const holder = $('run-result'); holder.replaceChildren();
  const dl = element('dl');
  for (const [label,value] of [['本机请求编号',result.request_id],['状态',STATE_LABELS[result.state] || `未知状态：${result.state || '未返回'}`],['原服务商编号',result.provider_task_id || '尚未获得'],['最近错误',result.error],['最近查询错误',result.last_query_error]]) {
    if (value !== undefined && value !== null && value !== '') dl.append(element('dt',label),element('dd',typeof value === 'string' ? value : '服务端未返回可显示的错误说明'));
  }
  holder.append(dl);
  if (!result.can_poll) holder.append(element('p','当前不能查询原服务商任务：缺少原任务编号或查询合同，或已进入终态。保留原本机记录，不自动重投。'));
  for (const [index,output] of (result.outputs || []).entries()) {
    if (output.type === 'text' && typeof output.text === 'string') holder.append(element('pre',output.text));
    else {
      const url = safeOutputUrl(output.url);
      if (!url) { holder.append(element('p',`结果 ${index+1} 无可用 HTTP(S) 地址，未自动下载或归档。`)); continue; }
      const p = element('p'), a = element('a',`打开结果 ${index+1}（${output.type}，服务商链接，未归档为素材）`);
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; p.append(a); holder.append(p);
    }
  }
}
async function submitRun(event) {
  event.preventDefault(); if (submitting || run.attempted) return;
  if (!$('confirm-submit').checked) { notice('请明确确认这是新的可能付费任务',true); return; }
  const profileId = $('run-profile').value;
  if (!profiles.some(profile => profile.id === profileId)) { notice('请选择已保存配置',true); return; }
  let inputs;
  try { inputs = jsonObject($('run-input').value,'运行输入'); } catch (error) { notice(error.message,true); return; }
  submitting = true; $('run-fields').disabled = true; runControls();
  try {
    const files = await collectFiles();
    history.replaceState(null,'',`#request=${encodeURIComponent(run.id)}`);
    $('lookup-id').value = run.id;
    const sequence = ++currentQuery;
    const result = await run.submit(profileId,inputs,files,true);
    if (sequence === currentQuery) showRun(result);
    notice('本机提交回执已收到。后续只通过原编号读取或查询；不会自动重投。');
  } catch (error) { notice(`${error.message}。本机请求编号：${run.id}`,true); }
  finally { submitting = false; $('run-fields').disabled = false; $('confirm-submit').checked = false; runControls(); }
}
async function loadRuns() {
  if (loadingRuns) return;
  loadingRuns = true; $('reload-runs').disabled = true;
  try {
    const data = await api.listRuns();
    if (!Array.isArray(data.runs)) throw new Error('任务列表回执不可读，保留原编号查询入口');
    $('recent-runs').replaceChildren(option('', '请选择原编号'));
    for (const item of data.runs) $('recent-runs').append(option(item.request_id, `${item.request_id} · ${STATE_LABELS[item.state] || '未知状态'}`));
  } catch (error) { notice(error.message, true); }
  finally { loadingRuns = false; $('reload-runs').disabled = false; }
}
async function queryRun(poll) {
  if (querying) return;
  const id = $('lookup-id').value.trim();
  if (!id) { notice('请输入原本机请求编号',true); return; }
  querying = true; $('read-run').disabled = true; $('poll-run').disabled = true;
  const sequence = ++currentQuery;
  try {
    const result = await (poll ? api.poll(id) : api.read(id));
    if (sequence === currentQuery) showRun(result);
    notice(poll ? '已处理原任务查询或回执保存，没有提交新生成。' : '已读取本机记录，未请求服务商。');
  } catch (error) { if (sequence === currentQuery) notice(error.message,true); }
  finally { querying = false; $('read-run').disabled = false; $('poll-run').disabled = false; }
}

$('profile-form').addEventListener('submit',saveProfile);
$('run-form').addEventListener('submit',submitRun);
$('reload').onclick = () => void loadProfiles();
void loadRuns();
$('new-profile').onclick = () => { if (confirmDiscard()) editProfile(null); };
$('auth').onchange = authState;
$('add-input').onclick = () => inputRow();
$('add-output').onclick = () => outputRow({type:$('kind').value,path:''});
$('run-profile').onchange = renderRunFiles;
$('read-run').onclick = () => void queryRun(false);
$('poll-run').onclick = () => void queryRun(true);
$('reload-runs').onclick = () => void loadRuns();
$('recent-runs').onchange = () => { if ($('recent-runs').value) $('lookup-id').value = $('recent-runs').value; };
$('new-run').onclick = () => {
  if (!window.confirm('这会准备另一个独立新任务，不会取消或替代旧任务。若原任务受理未知，新提交可能再次产生费用。继续？')) return;
  run = new RunSession(api); history.replaceState(null,'',location.pathname + location.search);
  $('confirm-submit').checked = false; runControls(); notice('已准备独立新编号，尚未提交；旧任务仍可按原编号查询。');
};
editProfile(null); runControls();
if (priorId) { $('lookup-id').value = run.id; notice('已保留页面中的原请求编号。不会再次提交；请读取本机记录或查询原任务。'); }
void loadProfiles();
void loadRuns();
