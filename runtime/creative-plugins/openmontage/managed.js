const base = '/plugins/openmontage';
async function call(name, args) {
  let ticket;
  const admission = '/creative-admission/openmontage';
  const controller = new AbortController();
  const abort = () => controller.abort();
  window.addEventListener('pagehide', abort, { once: true });
  try {
    for (;;) {
      const response = await fetch(base + '/_greenroom/call', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ name: 'openmontage_' + name, arguments: args, ...(ticket ? { admissionId: ticket } : {}) }) });
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
dock.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:100;background:#10202b;color:#e6f1f5;padding:12px;border:1px solid #36505b;border-radius:10px;max-width:min(560px,90vw);max-height:70vh;overflow:auto';
const summary = document.createElement('summary'); summary.textContent = 'Greenroom · 工程与生产'; dock.append(summary);
const output = document.createElement('pre'); output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:35vh;overflow:auto';
const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:12px 0';
let projectId = decodeURIComponent(location.pathname.split('/p/')[1] || '');
const select = document.createElement('select');
select.onchange = () => { projectId = select.value; };
row.append(select);
async function refresh() {
  const projects = await call('list_projects', {});
  select.replaceChildren(...projects.map((item) => { const option = document.createElement('option'); option.value = item.project_id; option.textContent = item.title; return option; }));
  if (projects.some((item) => item.project_id === projectId)) select.value = projectId;
  projectId = select.value;
  return projects;
}
function button(label, run) {
  const button = document.createElement('button'); button.textContent = label;
  button.onclick = async () => { button.disabled = true; try { output.textContent = JSON.stringify(await run(), null, 2); } catch (error) { output.textContent = error.message; } finally { button.disabled = false; } };
  row.append(button);
}
button('新建工程', async () => {
  const pipelines = await call('list_pipelines', {});
  const title = window.prompt('工程名称'); if (!title) return;
  const pipeline = window.prompt('流水线：' + pipelines.map((item) => item.name).join('、'), 'cinematic');
  if (!pipeline) return;
  const result = await call('create_project', { title, pipeline }); projectId = result.project_id; await refresh(); return result;
});
button('系列分组', async () => {
  const series = window.prompt('系列名称（留空取消分组）'); if (series === null) return;
  return call('set_series', { projectId, series });
});
button('刷新原任务', async () => { await refresh(); return call('get_tasks', { projectId }); });
button('查看待批准阶段', async () => {
  const result = await call('get_project', { projectId }); controls.replaceChildren();
  for (const stage of result.board.stages.filter((stage) => stage.status === 'awaiting_human')) {
    const pre = document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap';
    pre.textContent = JSON.stringify({ stage: stage.name, artifacts: result.board.artifacts }, null, 2); controls.append(pre);
    const approve = document.createElement('button'); approve.textContent = `认可 ${stage.name} 当前产物`;
    approve.onclick = async () => { approve.disabled = true; try { output.textContent = JSON.stringify(await call('approve_stage', { projectId, stage: stage.name, approved: true }), null, 2); } catch (error) { output.textContent = error.message; } finally { approve.disabled = false; } }; controls.append(approve);
  }
  return result;
});
button('渲染已保存剪辑', () => call('render', { projectId }));
button('归档工程', () => call('archive_project', { projectId }));
const controls = document.createElement('div');
const notice = document.createElement('p'); notice.textContent = '由 DSH 驱动原生产流水线，API 由管理员统一配置。';
const credit = document.createElement('p'); credit.textContent = 'OpenMontage · calesthio · AGPL-3.0 · Greenroom 托管修改';
const source = document.createElement('a'); source.href = base + '/_greenroom/source'; source.textContent = '下载当前版本对应源码与构建材料';
dock.append(notice, row, controls, output, credit, source); document.body.append(dock);
refresh().catch((error) => { output.textContent = error.message; });
