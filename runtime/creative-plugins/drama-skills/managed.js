const base = location.pathname.replace(/\/$/, '');
async function call(name, args) {
  let ticket;
  const admission = '/creative-admission/drama-skills';
  const controller = new AbortController();
  const abort = () => controller.abort();
  window.addEventListener('pagehide', abort, { once: true });
  try {
    for (;;) {
      const response = await fetch(base + '/_greenroom/call', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ name: 'drama_skills_' + name, arguments: args, ...(ticket ? { admissionId: ticket } : {}) }) });
      const result = await response.json();
      if (response.status !== 202 || result.waiting_memory !== true || result.submitted !== false) {
        if (!response.ok || result.isError) throw new Error(result.content?.[0]?.text || result.error || '业务调用失败');
        return JSON.parse(result.content.find((item) => item.type === 'text').text);
      }
      ticket ||= crypto.randomUUID();
      output.textContent = '内存繁忙，正在等待可用资源…';
      for (;;) {
        const ready = await fetch(admission, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket }), signal: controller.signal });
        const status = await ready.json();
        if (!ready.ok) throw new Error(status.error || '插件准备失败');
        if (status.state === 'ready') break;
        await new Promise((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(controller.signal.reason); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', aborted); resolve(); },
            Math.min(10_000, Math.max(1_000, Number(status.retry_after_ms) || 2_000)));
          controller.signal.addEventListener('abort', aborted, { once: true });
        });
      }
    }
  } finally {
    window.removeEventListener('pagehide', abort);
    if (ticket) void fetch(admission, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }), keepalive: true }).catch(() => {});
  }
}
const dock = document.createElement('details');
dock.id = 'greenroom-drama-dock';
dock.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:100;background:#10202b;color:#e6f1f5;padding:12px;border:1px solid #36505b;border-radius:10px;max-width:min(560px,90vw);max-height:70vh;overflow:auto';
const style = document.createElement('style');
style.textContent = `
#greenroom-drama-dock button, #greenroom-drama-dock select, #greenroom-drama-dock input {
  background:#e6f1f5;color:#10202b;border:1px solid #7896a8;border-radius:6px;padding:6px 10px;font:inherit;
}
#greenroom-drama-dock button {cursor:pointer;}
#greenroom-drama-dock button:disabled {cursor:default;opacity:.65;}
#greenroom-drama-dock :is(button,select,input):focus-visible {outline:2px solid #63d9fc;outline-offset:2px;}
#greenroom-drama-dock [hidden] {display:none;}
#greenroom-drama-dock a {color:#8cddf5;}
`;
const summary = document.createElement('summary'); summary.textContent = 'Greenroom · 项目与生产'; dock.append(summary, style);
const output = document.createElement('pre'); output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:36vh;overflow:auto';
const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:12px 0';
function button(label, action) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.onclick = async () => { button.disabled = true; try { const result = await action(); if (result !== undefined) output.textContent = JSON.stringify(result, null, 2); } catch (error) { output.textContent = error.message; } finally { button.disabled = false; } };
  row.append(button);
  return button;
}
let selectedProject = '';
const completed = document.createElement('section'); completed.setAttribute('aria-label', '当前项目已完成产物');
function showCompleted(result, projectId) {
  // A late response from a previously selected project must not replace this
  // project's links. Never trust provider URLs, filesystem paths or signed URLs.
  if (projectId !== selectedProject) return;
  completed.replaceChildren();
  if (!projectId || result?.projectId !== projectId || !Array.isArray(result.tasks)) return;
  for (const task of result.tasks) {
    if (task?.status !== 'succeeded' || !Array.isArray(task.outputs)) continue;
    for (const asset of task.outputs) {
      if (typeof asset?.assetId !== 'string' || !asset.assetId || /[^A-Za-z0-9_-]/.test(asset.assetId)) continue;
      const url = '/creative-managed/media/' + encodeURIComponent(asset.assetId);
      const item = document.createElement('div'); item.style.cssText = 'margin:10px 0;padding:8px;border:1px solid #36505b;border-radius:6px;overflow-wrap:anywhere';
      const label = task.label || (task.kind === 'archive' ? '工程归档' : '已完成产物');
      const title = document.createElement('p'); title.textContent = `${label} · ${task.jobId} · ${asset.assetId}`; item.append(title);
      const mime = asset.mimeType || '';
      const tag = /^image\/(png|jpeg|webp|gif|avif)$/.test(mime) ? 'img' : /^video\/(mp4|webm|ogg)$/.test(mime) ? 'video' : /^audio\/(wav|x-wav|mpeg|mp4|ogg|webm|flac)$/.test(mime) ? 'audio' : null;
      if (tag) {
        const media = document.createElement(tag); media.src = url; media.style.cssText = 'display:block;max-width:100%;max-height:220px;margin:8px 0';
        if (tag === 'img') { media.alt = label; media.loading = 'lazy'; }
        else { media.controls = true; media.preload = 'metadata'; }
        const error = document.createElement('p'); error.setAttribute('role', 'status');
        media.onerror = () => { error.textContent = '预览读取失败，请打开原产物核实；不要重新生成。'; };
        const open = document.createElement('a'); open.href = url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = '打开原产物'; open.style.marginRight = '12px';
        item.append(media, error, open);
      }
      // Non-media (including ZIP) is download-only; never iframe/embed HTML/SVG.
      const download = document.createElement('a'); download.href = url; download.download = ''; download.textContent = '下载原产物'; item.append(download);
      completed.append(item);
    }
  }
}
const select = document.createElement('select');
select.onchange = () => { selectedProject = select.value; completed.replaceChildren(); controls.replaceChildren(); };
async function refresh() {
  const projects = await call('list_projects', {});
  select.replaceChildren(...projects.map((project) => {
    const option = document.createElement('option'); option.value = project.projectId;
    option.textContent = project.project.title; return option;
  }));
  if (projects.some((project) => project.projectId === selectedProject)) select.value = selectedProject;
  selectedProject = select.value;
  return projects;
}
row.append(select);
button('刷新项目/任务', async () => { await refresh(); const projectId = selectedProject; const result = projectId ? await call('get_production', { projectId }) : []; showCompleted(result, projectId); return result; });
// Native modal dialogs are intentionally unavailable in the DSH sandbox. Keep
// naming in the document; do not request allow-modals or bypass the scoped API.
const createForm = document.createElement('form'); createForm.hidden = true;
createForm.style.cssText = 'margin:12px 0;padding:12px;border:1px solid #36505b;border-radius:8px';
const createLabel = document.createElement('label'); createLabel.htmlFor = 'greenroom-drama-project-title'; createLabel.textContent = '项目名称';
const createInput = document.createElement('input'); createInput.id = createLabel.htmlFor; createInput.name = 'title'; createInput.type = 'text'; createInput.required = true; createInput.autocomplete = 'off'; createInput.style.cssText = 'display:block;box-sizing:border-box;width:100%;margin:8px 0';
const createSubmit = document.createElement('button'); createSubmit.type = 'submit'; createSubmit.textContent = '确认新建';
const createCancel = document.createElement('button'); createCancel.type = 'button'; createCancel.textContent = '取消'; createCancel.style.marginLeft = '8px';
const createStatus = document.createElement('p'); createStatus.setAttribute('role', 'status'); createStatus.setAttribute('aria-live', 'polite');
createForm.append(createLabel, createInput, createSubmit, createCancel, createStatus);
let creating = false, createUncertain = false;
const createOpen = button('新建项目', () => {
  if (creating || createUncertain) return;
  createForm.hidden = false; createStatus.textContent = ''; createInput.focus();
});
createCancel.onclick = () => { if (creating) return; createForm.hidden = true; createInput.value = ''; createOpen.focus(); };
createForm.onsubmit = async event => {
  event.preventDefault();
  if (createForm.hidden || creating || createUncertain) return;
  const title = createInput.value.trim();
  if (!title) { createStatus.textContent = '请输入项目名称。'; createInput.focus(); return; }
  creating = true; createOpen.disabled = createSubmit.disabled = createCancel.disabled = createInput.disabled = true;
  createSubmit.textContent = '正在新建…'; createStatus.textContent = '正在新建项目，请勿重复提交。';
  try {
    const result = await call('create_project', { title });
    if (!result.projectId) throw new Error('服务未返回项目编号');
    selectedProject = result.projectId; completed.replaceChildren(); controls.replaceChildren();
    // The create response is authoritative even if refreshing the list fails.
    createForm.hidden = true; createInput.value = ''; output.textContent = JSON.stringify(result, null, 2);
    try { await refresh(); }
    catch (error) { output.textContent = `项目已创建（${result.projectId}），列表刷新失败：${error.message}。请点“刷新项目/任务”，不要重复新建。`; }
  } catch (error) {
    createUncertain = true;
    createStatus.textContent = `新建结果未确认：${error.message}。请先点“刷新项目/任务”核实；确认未创建后再重新打开页面，不要重复提交。`;
    output.textContent = createStatus.textContent;
  } finally {
    creating = false; createCancel.disabled = false;
    createOpen.disabled = createSubmit.disabled = createInput.disabled = createUncertain;
    createSubmit.textContent = '确认新建';
  }
};
button('查看待确认预览', async () => {
  const projectId = selectedProject;
  const result = await call('get_production', { projectId });
  if (projectId !== selectedProject) return;
  showCompleted(result, projectId);
  const batches = result.previews.filter((batch) => batch.status === 'preview' || batch.status === 'confirmed');
  controls.replaceChildren();
  for (const batch of batches) {
    const pre = document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap'; pre.textContent = JSON.stringify(batch, null, 2); controls.append(pre);
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = batch.status === 'confirmed' ? '执行已确认批次' : '我确认上述完整批次并生产';
    confirm.onclick = async () => { confirm.disabled = true; try {
      if (projectId !== selectedProject) return;
      if (batch.status === 'preview') await call('confirm_production', { projectId, previewId: batch.previewId, confirmed: true });
      const result = await call('execute_production', { projectId, previewId: batch.previewId });
      showCompleted(result, projectId); output.textContent = JSON.stringify(result, null, 2);
    } catch (error) { output.textContent = error.message; } finally { confirm.disabled = false; } };
    controls.append(confirm);
  }
  return { batches: batches.length };
});
button('归档工程', () => call('archive_project', { projectId: selectedProject }));
const controls = document.createElement('div');
const notice = document.createElement('p'); notice.textContent = '创作、预览与剪辑可由 DSH 操控；API 由管理员统一配置。';
const source = document.createElement('a'); source.href = 'https://github.com/zenstory-ai/drama-skills/tree/3d813c30871b4db5f2387d83bdc3a49db8ce7b2b'; source.target = '_blank'; source.rel = 'noreferrer'; source.textContent = 'drama-skills · MIT · zenstory-ai';
dock.append(notice, row, createForm, controls, completed, output, source); document.body.append(dock); refresh().catch((error) => { output.textContent = error.message; });
