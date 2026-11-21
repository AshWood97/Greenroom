// Exact public task-card fields only, not a generic recursive redactor.
function taskCardResult(tool, message) {
  if (!['aigc_generate_image', 'aigc_generate_video', 'aigc_get_task'].includes(tool)) return {};
  const text = message.content?.find(part => part.type === 'text')?.text;
  if (typeof text !== 'string' || text.length > 262144) return {};
  let body;
  try { body = JSON.parse(text); } catch { return {}; }
  if (body?.success === false) return { resultSummary: '业务返回未成功，详情请查看聊天中的任务卡' };
  const task = body?.data;
  if (!task || typeof task !== 'object') return {};
  const result = {};
  if (typeof task.taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(task.taskId)) result.taskId = task.taskId;
  const statuses = { pending: '任务等待中', running: '任务运行中', succeeded: '任务已完成',
    failed: '任务失败', cancelled: '任务已取消', unknown: '任务状态未知' };
  if (Object.hasOwn(statuses, task.status)) result.resultSummary = statuses[task.status];
  else if (result.taskId) result.resultSummary = '已记录任务编号，请在聊天任务卡查询结果';
  result.outputs = (Array.isArray(task.outputs) ? task.outputs : []).slice(0, 20)
    .filter(output => typeof output?.url === 'string' && /^\/api\/media\/[A-Za-z0-9_-]+$/.test(output.url))
    .map(output => ({ url: output.url }));
  return result;
}

// A deliberately small projection, not a raw transcript or developer inspector.
export function projectManagedTrajectory(events, allowedTools = new Set()) {
  const rows = [];
  const turns = new Map();
  const calls = new Map();
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const finish = (row, event, status) => {
    row.status = status;
    const end = number(event.time);
    if (row.time !== undefined && end !== undefined && end >= row.time) row.durationMs = end - row.time;
  };
  for (const event of events) {
    const data = event.data || {};
    const turn = number(data.turn);
    const row = { seq: number(event.seq), time: number(event.time), turn };
    if (event.type === 'turn/start') {
      const item = { ...row, kind: 'turn', title: '对话轮次', status: 'unresolved' };
      rows.push(item); turns.set(turn, item);
    } else if (event.type === 'turn/end') {
      const item = turns.get(turn);
      if (item) finish(item, event, data.reason?.kind === 'completed' ? 'completed' : 'interrupted');
    } else if (event.type === 'tool/call') {
      const item = { ...row, step: number(data.step), kind: 'tool',
        title: allowedTools.has(data.name) ? data.name : '受控工具调用', status: 'unresolved' };
      rows.push(item);
      calls.set(`${turn}:${data.step}:${data.callId}`, item);
    } else if (event.type === 'tool/result') {
      const message = data.message;
      const item = calls.get(`${turn}:${data.step}:${message?.toolCallId}`);
      if (item) {
        finish(item, event, message.isError ? 'failed' : 'returned');
        if (!message.isError) Object.assign(item, taskCardResult(item.title, message));
      }
    }
  }
  return { rows: rows.slice(-500), omitted: Math.max(0, rows.length - 500) };
}

export function installManagedTrajectory(ctx, allowedTools) {
  // The native shared Fetch transport authenticates owner peers, rejects every
  // non-owner principal, and applies its Host/Origin fence before this callback.
  ctx.connection.fetch.register({
    path: '/api/greenroom/trajectory', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const query = new URL(request.url).searchParams;
      const sessionId = query.get('sessionId');
      if (query.getAll('sessionId').length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId || '')) {
        return Response.json({ error: '请选择有效对话' }, { status: 400 });
      }
      try {
        const log = await ctx.sessionQuery.readSession(sessionId);
        return Response.json(projectManagedTrajectory(log.events, allowedTools), {
          headers: { 'Cache-Control': 'no-store' },
        });
      } catch {
        return Response.json({ error: '对话轨迹暂不可读取' }, { status: 404 });
      }
    },
  });
}

// Serialized into the existing brand companion by patch-dsh.mjs.
export function installTrajectoryClient(ctx, React, jsx) {
  ctx.inject(['sessions', 'connection'], ctx => {
    const labels = { unresolved: '尚未记录结束', completed: '对话已结束', interrupted: '对话中断',
      returned: '调用已返回', failed: '调用失败' };
    function Trajectory({ sessionId }) {
      const [value, setValue] = React.useState(null);
      const [error, setError] = React.useState('');
      const [refresh, setRefresh] = React.useState(0);
      React.useEffect(() => {
        const controller = new AbortController();
        let timer;
        setValue(null); setError('');
        const load = async () => {
          try {
            const response = await fetch('/api/greenroom/trajectory?sessionId=' + encodeURIComponent(sessionId), {
              credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            });
            if (!response.ok) throw new Error('轨迹暂不可读取，请检查连接后刷新');
            const body = await response.json();
            if (controller.signal.aborted) return;
            setValue(body); setError('');
            timer = setTimeout(load, 3000);
          } catch (reason) {
            if (!controller.signal.aborted) setError(reason.message);
          }
        };
        load();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [sessionId, refresh]);
      return jsx('section', { 'aria-label': '创作轨迹', style: { padding: 20, overflowY: 'auto', height: '100%' }, children: [
        jsx('h3', { children: '创作轨迹' }, 'title'),
        jsx('p', { children: '只读查看当前对话的调用顺序和记录时长。调用返回不代表作品生成完成；不展示系统提示词、原始参数、凭据或文件路径。' }, 'description'),
        jsx('button', { type: 'button', onClick: () => setRefresh(value => value + 1), children: '刷新轨迹' }, 'refresh'),
        error && jsx('p', { role: 'alert', children: error }, 'error'),
        !value && !error && jsx('p', { role: 'status', children: '正在读取…' }, 'loading'),
        value?.omitted > 0 && jsx('p', { children: `显示最近 500 条记录，更早 ${value.omitted} 条未展示。` }, 'omitted'),
        value && !value.rows.length && jsx('p', { children: '本对话尚无调用轨迹。' }, 'empty'),
        jsx('ol', { children: (value?.rows || []).map(row => jsx('li', {
          style: { margin: '12px 0', overflowWrap: 'anywhere' },
          children: [jsx('strong', { children: `${row.turn !== undefined ? '第 ' + row.turn + ' 轮 · ' : ''}${row.title}` }, 'name'),
            jsx('div', { children: `${labels[row.status] || '状态未知'}${row.durationMs !== undefined ? ' · ' + (row.durationMs / 1000).toFixed(2) + ' 秒' : ''}` }, 'status'),
            row.resultSummary && jsx('div', { children: row.resultSummary }, 'result'),
            row.taskId && jsx('div', { children: '任务编号：' + row.taskId }, 'task'),
            ...(row.outputs || []).map((output, index) => jsx('a', { href: output.url, download: '', children: `下载产物 ${index + 1}`, style: { marginRight: 12 } }, output.url)),
            row.time !== undefined && jsx('time', { dateTime: new Date(row.time).toISOString(), children: new Date(row.time).toLocaleString() }, 'time')],
        }, row.seq)) }, 'rows'),
      ] });
    }
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view', id: 'greenroom-trajectory', order: 10,
      label: () => '创作轨迹', inject: sessionId => ({ sessionId }),
    }, Trajectory));
  });
}
