const get = id => document.getElementById(id);
const projects = get('projects');
const compose = get('compose');
const projectDialog = get('project-dialog');
const providerDialog = get('provider-dialog');
const providerForm = get('provider-form');
const modelList = get('model-list');
const labels = { text: '文字', image: '图片', audio: '音频', video: '视频', embedding: '向量', moderation: '内容审核', other: '其他' };
const statuses = { running: '处理中', done: '已完成', failed: '失败', interrupted: '已中断' };
const starters = { text: '写一段场景或对白', image: '描述想生成的画面', audio: '输入需要朗读的文本' };
let projectRows = [];
let providerRows = [];
let defaultId = null;
let activeProject = null;
let kind = 'text';
let catalogSequence = 0;
let busy = false;

const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const option = (value, title) => new Option(title, value);
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '请求失败。');
  return data;
}
function status(id, message, error = false) {
  get(id).textContent = message;
  get(id).classList.toggle('error', error);
}
function modelField() { return compose.elements.model; }
function adjustComposer() {
  compose.querySelector('button[type="submit"]').disabled = busy || !get('provider').value;
  compose.querySelector('button[type="submit"]').textContent = busy ? '生成中…' : '生成' + labels[kind];
}
async function loadProjectList() {
  projectRows = await api('/api/projects');
  activeProject = projectRows.find(row => row.id === activeProject?.id) ?? projectRows[0] ?? null;
  renderProjects();
}
function renderProjects() {
  projects.replaceChildren(...projectRows.map(project => {
    const menu = el('button', project.name);
    menu.type = 'button';
    if (project.id === activeProject?.id) menu.setAttribute('aria-current', 'true');
    menu.onclick = async () => {
      activeProject = project;
      renderProjects();
      await loadHistory(project).catch(error => status('compose-status', error.message, true));
    };
    return menu;
  }));
  get('welcome').hidden = !!activeProject;
  get('studio').hidden = !activeProject;
  if (activeProject) get('project-title').textContent = activeProject.name;
}
async function loadHistory(project) {
  if (!project) return;
  const history = await api('/api/projects/' + project.id + '/tasks');
  if (activeProject?.id !== project.id) return;
  const grid = get('history');
  grid.replaceChildren(...history.map(row => {
    const task = el('article');
    task.className = 'task';
    const header = el('header');
    header.append(el('strong', [labels[row.kind], row.model, row.provider_name].join(' · ')), el('span', statuses[row.status]));
    task.append(header);
    const original = el('p', row.prompt);
    original.className = 'prompt';
    task.append(original);
    if (row.content) task.append(el('p', row.content));
    if (row.error || row.query_error) {
      const error = el('p', row.error ?? row.query_error);
      error.className = 'status error';
      task.append(error);
    }
    if (row.status === 'running' && row.upstream_id) {
      const check = el('button', '查询原任务');
      check.type = 'button';
      check.onclick = async () => {
        check.disabled = true;
        try {
          await api('/api/tasks/' + row.id + '/poll', 'POST', {});
          await loadHistory(project);
        } catch (error) { status('compose-status', error.message, true); }
        finally { check.disabled = false; }
      };
      task.append(check);
    }
    if (row.mime) {
      const link = '/api/media/' + row.id;
      const media = el(row.mime === 'image/png' ? 'img' : 'audio');
      media.src = link;
      if (media.tagName === 'IMG') { media.alt = row.prompt; media.loading = 'lazy'; }
      else { media.controls = true; media.preload = 'none'; }
      const download = el('a', '下载产物');
      download.href = link;
      download.download = row.id + (row.mime === 'image/png' ? '.png' : '.mp3');
      task.append(media, download);
    }
    return task;
  }));
  if (!history.length) {
    const empty = el('p', '这个项目还没有创作记录。');
    empty.className = 'status';
    grid.append(empty);
  }
}
async function listProviders() {
  const list = await api('/api/providers');
  providerRows = list.providers;
  defaultId = list.defaultId;
  const gateway = providerRows.find(row => row.id === defaultId);
  get('gateway-status').textContent = gateway ? '默认网关 · ' + gateway.name : '网关未配置';
  await setComposerProviders();
}
async function setComposerProviders() {
  const select = get('provider');
  const eligible = providerRows.filter(row => row.scope.includes(kind));
  select.replaceChildren(...(eligible.length ? eligible.map(row => option(row.id, row.name + (row.id === defaultId ? ' · 默认' : ''))) : [option('', '未配置该用途')]));
  select.value = eligible.some(row => row.id === defaultId) ? defaultId : eligible[0]?.id ?? '';
  adjustComposer();
  await loadComposerModels();
}
async function loadComposerModels() {
  const serial = ++catalogSequence;
  const providerId = get('provider').value;
  get('background-control').hidden = kind !== 'text'
    || providerRows.find(row => row.id === providerId)?.protocol !== 'responses';
  modelList.replaceChildren();
  modelField().value = '';
  if (!providerId) {
    if (!busy) status('compose-status', '在「供应商与模型」中配置此工具的网关。');
    return;
  }
  if (!busy) status('compose-status', '正在读取模型目录…');
  try {
    const catalog = await api('/api/providers/' + providerId + '/models');
    if (serial !== catalogSequence) return;
    const compatible = catalog.filter(item => item.kind === kind || item.kind === 'other');
    modelList.replaceChildren(...compatible.map(model => option(model.id, model.id)));
    const preferred = { text: 'gpt-6-luna', image: 'gpt-image-2.6-flare', audio: 'tts-1' }[kind];
    const model = compatible.find(item => item.id === preferred);
    if (model && !modelField().value) modelField().value = model.id;
    if (!busy) status('compose-status', compatible.length ? '' : '目录中暂无此类别，可以手动输入模型 ID。');
  } catch (error) {
    if (serial === catalogSequence && !busy) status('compose-status', error.message + ' 也可手动输入模型 ID。', true);
  }
}
function changeTool(next) {
  kind = next;
  document.querySelectorAll('[data-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === kind)));
  document.querySelectorAll('[data-option]').forEach(label => { label.hidden = label.dataset.option !== kind; });
  get('prompt').placeholder = starters[kind];
  return setComposerProviders();
}
document.querySelectorAll('[data-kind]').forEach(button => { button.onclick = () => void changeTool(button.dataset.kind); });
get('provider').onchange = () => void loadComposerModels();
compose.onsubmit = async event => {
  event.preventDefault();
  if (busy || !activeProject) return;
  const project = activeProject;
  const fields = new FormData(compose);
  const options = Object.fromEntries([...compose.querySelectorAll('[data-option="' + kind + '"] input, [data-option="' + kind + '"] select')]
    .map(field => [field.name, field.value]));
  if (!get('background-control').hidden && fields.has('background')) options.background = true;
  busy = true;
  adjustComposer();
  status('compose-status', '正在生成 · ' + project.name);
  try {
    const result = await api('/api/projects/' + project.id + '/tasks', 'POST', {
      kind, model: fields.get('model'), prompt: fields.get('prompt'), providerId: fields.get('provider'), options,
    });
    await loadHistory(project);
    const message = result.status === 'done' ? '已保存到 ' + project.name
      : result.status === 'running' ? '已保存原任务，稍后可查询。' : result.error;
    status('compose-status', message, ['failed','interrupted'].includes(result.status));
  } catch (error) { status('compose-status', error.message, true); }
  finally { busy = false; adjustComposer(); }
};
const createProject = () => {
  get('project-form').reset();
  get('project-form').querySelector('.status').textContent = '';
  projectDialog.showModal();
};
get('start-project').onclick = createProject;
get('new-project').onclick = createProject;
get('project-form').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    activeProject = await api('/api/projects', 'POST', { name: new FormData(form).get('name') });
    projectDialog.close();
    await loadProjectList();
    await loadHistory(activeProject);
  } catch (error) {
    if (projectDialog.open) form.querySelector('.status').textContent = error.message;
    else status('compose-status', error.message, true);
  } finally { button.disabled = false; }
};
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });

function settingsMenu(selected = defaultId ?? '') {
  get('provider-edit').replaceChildren(option('', '添加供应商'), ...providerRows.map(row => option(row.id, row.name)));
  get('provider-edit').value = selected;
  selectProvider();
}
let settingsSequence = 0;
function selectProvider() {
  const selected = providerRows.find(row => row.id === get('provider-edit').value);
  providerForm.elements.name.value = selected?.name ?? 'OpenAI';
  providerForm.elements.url.value = selected?.url ?? 'https://api.openai.com/v1';
  providerForm.elements.protocol.value = selected?.protocol ?? 'responses';
  providerForm.elements.key.value = '';
  providerForm.elements.key.required = !selected;
  providerForm.elements.key.placeholder = selected ? '留空可保留已保存的密钥' : '';
  for (const checkbox of providerForm.querySelectorAll('[name="scope"]')) {
    checkbox.checked = !selected || selected.scope.includes(checkbox.value);
  }
  providerForm.elements.default.checked = selected?.id === defaultId || !providerRows.length;
  status('provider-status', '');
  get('refresh-models').disabled = !selected;
  void renderCatalog(selected?.id);
}
get('settings').onclick = () => { settingsMenu(); providerDialog.showModal(); };
get('provider-edit').onchange = selectProvider;
get('refresh-models').onclick = () => void renderCatalog(get('provider-edit').value);
async function renderCatalog(id) {
  const serial = ++settingsSequence;
  const target = get('catalog');
  target.textContent = id ? '正在读取…' : '保存供应商后自动拉取。';
  if (!id) return;
  try {
    const models = await api('/api/providers/' + id + '/models');
    if (serial !== settingsSequence) return;
    target.replaceChildren();
    for (const [kind, label] of Object.entries(labels)) {
      const group = models.filter(item => item.kind === kind);
      if (!group.length) continue;
      const box = el('details');
      if (kind === 'text') box.open = true;
      const items = el('ul');
      items.append(...group.map(item => el('li', item.id)));
      box.append(el('summary', label + ' · ' + group.length), items);
      target.append(box);
    }
    if (!models.length) target.textContent = '网关没有返回模型。';
  } catch (error) { if (serial === settingsSequence) target.textContent = error.message; }
}
providerForm.onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(providerForm);
  const id = get('provider-edit').value;
  const button = providerForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const body = Object.fromEntries(form);
    body.scope = form.getAll('scope');
    body.default = form.has('default');
    const saved = await api('/api/providers' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body);
    await listProviders();
    settingsMenu(saved.id);
    status('provider-status', '已保存');
  } catch (error) { status('provider-status', error.message, true); }
  finally { button.disabled = false; }
};
Promise.all([loadProjectList(), listProviders()])
  .then(() => loadHistory(activeProject))
  .catch(error => { get('gateway-status').textContent = error.message; });

const harnessDialog = get('harness-dialog');
function showHarness(state) {
  const link = get('harness-link');
  link.hidden = state.status !== 'ready';
  if (state.url) link.href = state.url;
  else link.removeAttribute('href');
  get('harness-start').textContent = state.status === 'ready' ? '同步网关并重启' : '启动 DSH';
  get('harness-start').dataset.restart = String(state.status === 'ready');
  status('harness-status', ['DSH ' + state.version, state.model, state.issue].filter(Boolean).join(' · '), state.status === 'error');
}
get('harness').onclick = async () => {
  harnessDialog.showModal();
  try { showHarness(await api('/api/harness')); }
  catch (error) { status('harness-status', error.message, true); }
};
get('harness-start').onclick = async () => {
  const button = get('harness-start');
  button.disabled = true;
  status('harness-status', '正在启动官方工作台…');
  try { showHarness(await api('/api/harness', 'POST', { restart:button.dataset.restart === 'true' })); }
  catch (error) { status('harness-status', error.message, true); }
  finally { button.disabled = false; }
};

const pluginsDialog = get('plugins-dialog');
const pluginForm = get('plugin-form');
const pluginList = get('plugin-list');
const modes = {
  native: '官方内置工作台', canvas: '独立安装画布，支持 OpenAI 兼容网关',
  separate: '独立 AGPL 服务', restricted: '外部选装，按上游许可使用',
  external: '从上游独立安装', skills: '通过 DSH 原生技能机制安装',
};
let editingPlugin;
async function showPlugins() {
  pluginForm.hidden = true;
  pluginList.hidden = false;
  status('plugin-status', '正在读取插件…');
  try {
    const rows = await api('/api/plugins');
    pluginList.replaceChildren(...rows.map(row => {
      const tile = el('article');
      tile.className = 'plugin-tile';
      const info = el('div');
      const connected = row.mcpUrl ? ' · 已配置 MCP' : '';
      info.append(el('strong', row.name), el('p', modes[row.mode] + ' · ' + row.license + connected));
      const links = el('div');
      const source = el('a', '上游');
      source.href = row.upstream + '/tree/' + row.revision;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      links.append(source);
      if (row.url) {
        const open = el('a', '打开');
        open.href = row.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        links.append(open);
      }
      const settings = el('button', '接入设置');
      settings.type = 'button';
      settings.onclick = () => showPluginSettings(row);
      links.append(settings);
      tile.append(info, links);
      return tile;
    }));
    status('plugin-status', '');
  } catch (error) { status('plugin-status', error.message, true); }
}
function showPluginSettings(row) {
  editingPlugin = row;
  pluginList.hidden = true;
  pluginForm.hidden = false;
  get('plugin-title').textContent = row.name;
  get('plugin-mode').textContent = modes[row.mode];
  get('plugin-address').hidden = row.mode === 'native';
  get('plugin-mcp').hidden = row.mode === 'native';
  pluginForm.elements.url.value = row.url ?? '';
  pluginForm.elements.mcpUrl.value = row.mcpUrl ?? '';
  for (const kind of ['text','image','audio']) {
    const select = pluginForm.elements[kind];
    select.replaceChildren(option('', '继承默认网关'),
      ...providerRows.filter(item => item.scope.includes(kind)).map(item => option(item.id, item.name)));
    select.value = row.bindings[kind] ?? '';
  }
  get('plugin-command').textContent = row.mode === 'native' ? '启动或同步 DSH 时读取当前绑定。'
    : '支持 OpenAI 兼容网关的插件，可用 npm run plugin -- ' + row.id + ' 读取本机接入地址与插件凭据。';
  status('plugin-save-status', '');
}
get('plugins').onclick = () => { pluginsDialog.showModal(); void showPlugins(); };
get('plugin-back').onclick = () => void showPlugins();
pluginForm.onsubmit = async event => {
  event.preventDefault();
  const fields = new FormData(pluginForm);
  const button = pluginForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const bindings = Object.fromEntries(['text','image','audio'].map(kind => [kind, fields.get(kind) || null]));
    const saved = await api('/api/plugins/' + editingPlugin.id, 'PUT', { url:fields.get('url'), mcpUrl:fields.get('mcpUrl'), bindings });
    showPluginSettings(saved);
    status('plugin-save-status', '已保存');
  } catch (error) { status('plugin-save-status', error.message, true); }
  finally { button.disabled = false; }
};
