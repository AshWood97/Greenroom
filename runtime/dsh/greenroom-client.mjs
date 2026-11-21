// Installed into the existing brand companion; uses DSH's public extension seats.
export function installGreenroom(ctx, React, jsx, managedTools, pluginCatalog, showCreationMode = true) {
  ctx.inject(['connection', 'workspaces', 'sessions', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs', 'layout'], (ctx) => {
    const lifetime = new AbortController();
    let preparing;
    let workspace;
    let initialized = false;
    const parentOrigin = new URLSearchParams(location.search).get('greenroom_parent');
    const report = (state, detail) => {
      if (parentOrigin && window.parent !== window) {
        window.parent.postMessage({ type: 'greenroom:harness-state', state, detail }, parentOrigin);
      }
    };
    const ensureWorkspace = async () => {
      const result = await ctx.workspaces.initializeDefault(lifetime.signal);
      if (!result) throw new Error('默认工作区未能初始化');
      workspace = result;
      if (!ctx.sidebarRight.mounted.getSnapshot()) await ctx.uiWorkspace.openWorkspace(result.workspaceId);
    };
    const reconcile = () => {
      if (ctx.connection.state.getSnapshot() !== 'connected') {
        if (initialized) report('reconnecting', '工作台连接已中断，正在重新连接');
        return;
      }
      if (preparing || ctx.workspaces.list.getSnapshot().phase !== 'ready' || ctx.sessions.list.getSnapshot().phase !== 'ready') return;
      preparing = ensureWorkspace().then(() => {
        initialized = true;
        report('ready');
      }, (error) => report('error', error.message)).finally(() => { preparing = undefined; });
    };
    ctx.effect(() => {
      const releases = [ctx.connection.state.subscribe(reconcile), ctx.workspaces.list.subscribe(reconcile),
                        ctx.sessions.list.subscribe(reconcile)];
      reconcile();
      return () => { lifetime.abort(); releases.forEach((release) => release()); };
    });
    const openPlugin = async (kind) => {
      if (ctx.connection.state.getSnapshot() !== 'connected') throw new Error('工作台尚未连接，请重试');
      if (!ctx.sidebarRight.mounted.getSnapshot()) {
        if (!workspace) await ensureWorkspace();
        else await ctx.uiWorkspace.openWorkspace(workspace.workspaceId);
      }
      // The native rightbar adopts the selected Session in the next React commit.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      ctx.sidebarRight.openTab(kind);
      const sessionId = ctx.sidebarRight.mounted?.getSnapshot?.();
      if (sessionId && ctx.sidebarRight.actionsFor) {
        try { ctx.sidebarRight.actionsFor(sessionId)?.setMode?.(sessionId, 'push'); } catch (_) {}
      }
      try { ctx.layout?.focusRightbar?.(); } catch (_) {}
    };
    const catalog = pluginCatalog || {
      groups: [{ id: 'ai-drama-tools', title: 'AI剧综合工具' }],
      plugins: [
        { id: 't8', title: 'T8 画布', group: 'ai-drama-tools', icon: '▦', tabId: 'greenroom-t8-canvas', tabKind: 'greenroom-canvas', basePath: '/canvas/' },
        { id: 'huobao', title: '火宝短剧', group: 'ai-drama-tools', icon: '🎬', tabId: 'greenroom-huobao-drama', tabKind: 'greenroom-huobao', basePath: '/huobao/' },
      ],
    };
    const openSkill = async (plugin) => {
      if (ctx.connection.state.getSnapshot() !== 'connected') throw new Error('工作台尚未连接，请重试');
      if (!ctx.sidebarRight.mounted.getSnapshot()) await ensureWorkspace();
      const sessionId = ctx.sidebarRight.mounted.getSnapshot();
      if (!sessionId) throw new Error('请先打开创作对话');
      await ctx.sessions.using(sessionId, { source: 'controllerOperation', signal: lifetime.signal }, async (reference) => {
        const binding = await reference.ready;
        const instructions = plugin.kind === 'website'
          ? '先通过 greenroom_select_plugins 选择此插件并查询连接状态；如为本机开发直连，明确告知用户未使用官网登录授权；网站模式未授权时提供网页登录链接。通过 CLI 操作现有项目和任务。等待我的具体要求后再执行，不要自动提交生成或付费任务。'
          : '先通过 greenroom_select_plugins 选择此套件，再按需加载它的原生 Skill。介绍可用创作流程并询问我的需求，等待具体要求后再创作；不要自动提交生成或付费任务。';
        const text = `请启用 ${plugin.title}（插件 ID：${plugin.id}）：${instructions}`;
        const result = await binding.session.prompt([{ type: 'text', text }], 'queue');
        if (!result.ok) throw new Error(result.error.message);
      });
    };
    const plugins = catalog.plugins.map((plugin) => ({ ...plugin, name: plugin.title,
      open: () => plugin.ui === null ? openSkill(plugin) : openPlugin(plugin.tabKind) }));
    const actionStyle = {
      border: '1px solid #10b98166', borderRadius: 8, background: '#10b9810a', color: '#34d399',
      padding: '6px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12, whiteSpace: 'nowrap',
    };
    function PluginLauncher({ variant }) {
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(null);
      const [expanded, setExpanded] = React.useState(false);
      const listId = React.useId();
      const hero = variant === 'hero';
      React.useEffect(() => setExpanded(false), [variant]);
      return jsx('div', {
        'data-greenroom-plugin-launcher': variant,
        style: { boxSizing: 'border-box', width: '100%', maxWidth: 'var(--dsh-composer-card-max-width)',
                 padding: '10px 4px 0', display: 'flex', flexDirection: 'column', gap: 8,
                 alignItems: hero ? 'center' : 'flex-start' },
        children: [
          !hero && jsx('button', {
            type: 'button', 'aria-expanded': expanded, 'aria-controls': listId,
            onClick: () => setExpanded((value) => !value),
            style: { ...actionStyle, borderColor: 'var(--dsw-alias-border-l2, #ffffff26)',
                     background: 'transparent', color: 'var(--dsw-alias-label-secondary, #d1d5db)' },
            children: `▦ 插件 ${expanded ? '⌃' : '⌄'}`,
          }, 'toggle'),
          (hero || expanded) && jsx('div', {
            id: listId, role: 'group', 'aria-label': '可用插件',
            style: { display: 'flex', flexWrap: 'wrap', justifyContent: hero ? 'center' : 'flex-start', gap: 8 },
            children: catalog.groups.filter((group) => plugins.some((plugin) => plugin.group === group.id)).map((group) => jsx('section', {
              'aria-label': group.title,
              style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' },
              children: [jsx('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #d1d5db)' }, children: group.title }, 'title'),
                jsx('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: hero ? 'center' : 'flex-start' },
                  children: plugins.filter((plugin) => plugin.group === group.id).map((plugin) => jsx('span', {
                    style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
                    children: [jsx('button', {
              type: 'button', title: plugin.reason || (plugin.ui === null ? `在对话中启用 ${plugin.name}` : `在右侧打开 ${plugin.name}`), 'aria-label': `打开 ${plugin.name}`,
              disabled: busy !== null || plugin.status === 'awaiting-authorization',
              onClick: () => {
                setBusy(plugin.id); setError('');
                plugin.open().then(() => setExpanded(false))
                  .catch((reason) => { setError(reason.message); report('error', reason.message); })
                  .finally(() => setBusy(null));
              },
              style: actionStyle,
              children: busy === plugin.id ? '正在打开…' : `${plugin.icon} ${plugin.name}`,
                    }, 'open'), plugin.sourceAvailable && jsx('a', {
                      href: '/plugins/' + plugin.id + '/_greenroom/source', title: '下载当前修改版本的对应源码与许可',
                      style: { color: 'var(--dsw-alias-label-secondary, #d1d5db)', fontSize: 11 }, children: '源码',
                    }, 'source')],
                  }, plugin.id)),
                }, 'plugins')],
            }, group.id)),
          }, 'list'),
          error && jsx('div', { role: 'alert', style: { fontSize: 12, color: '#f87171' }, children: error }, 'error'),
        ],
      });
    }
    function CreationMode() {
      return jsx('span', {
        title: '使用托管插件与生成工具创作',
        style: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 6px',
                 color: 'var(--dsw-alias-label-secondary, #d1d5db)', fontSize: 13, whiteSpace: 'nowrap' },
        children: [jsx('span', { 'aria-hidden': true, children: '✧' }, 'icon'), '创作模式'],
      });
    }
    function PluginPane({ plugin, visible }) {
      const [attempt, setAttempt] = React.useState(0);
      const [enabled, setEnabled] = React.useState(true);
      const [state, setState] = React.useState('waiting');
      const [mounted, setMounted] = React.useState(false);
      const [error, setError] = React.useState('');
      const [documentVisible, setDocumentVisible] = React.useState(document.visibilityState !== 'hidden');
      React.useEffect(() => {
        const update = () => setDocumentVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
      }, []);
      React.useEffect(() => {
        if (!visible || !documentVisible) { setState('waiting'); return; }
        if (!enabled) { setState('cancelled'); return; }
        const controller = new AbortController();
        const ticket = crypto.randomUUID();
        const url = '/creative-admission/' + encodeURIComponent(plugin.id);
        let timer;
        const cancel = () => fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket }), keepalive: true }).catch(() => {});
        const poll = async () => {
          try {
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ticket }), signal: controller.signal });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '插件准备失败');
            if (controller.signal.aborted) return;
            if (result.state === 'ready') setMounted(true);
            setState(result.state === 'ready' ? 'ready' : 'waiting');
            timer = setTimeout(poll, result.state === 'ready' ? 10_000 : Math.min(10_000, Math.max(1_000, Number(result.retry_after_ms) || 2_000)));
          } catch (reason) {
            if (!controller.signal.aborted) { setError(reason.message || '插件准备失败'); setState('failed'); }
          }
        };
        setState('waiting'); setError(''); void poll();
        return () => { controller.abort(); clearTimeout(timer); void cancel(); };
      }, [plugin.id, attempt, enabled, visible, documentVisible]);
      return jsx('div', { style: { position: 'relative', width: '100%', height: '100%' }, children: [
        mounted && jsx('iframe', {
          src: plugin.basePath, title: plugin.title,
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: '#18181b' },
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups',
          allow: 'clipboard-read; clipboard-write; fullscreen',
        }, 'frame'),
        state !== 'ready' && jsx('div', { style: { position: 'absolute', inset: 0, padding: 16, color: '#d1d5db', background: '#18181b' },
          role: state === 'failed' ? 'alert' : 'status',
          children: [state === 'failed' ? error : state === 'cancelled' ? '已取消等待' : '内存繁忙，正在等待可用资源…',
          state === 'waiting' && jsx('button', { type: 'button', style: actionStyle,
            onClick: () => setEnabled(false), children: '取消等待' }, 'cancel'),
          (state === 'failed' || state === 'cancelled') && jsx('button', { type: 'button', style: actionStyle,
            onClick: () => { setEnabled(true); setAttempt((value) => value + 1); }, children: '重试' }, 'retry')],
        }, 'status'),
      ] });
    }
    const taskStatus = { pending: '等待生成', running: '正在生成', succeeded: '生成完成', failed: '生成失败', cancelled: '已取消' };
    const taskTitles = { image: '图片生成', video: '视频生成' };
    const cardStyle = {
      border: '1px solid var(--dsw-alias-border-l2, #ffffff26)', borderRadius: 12, padding: 12,
      margin: '6px 0', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
      color: 'var(--dsw-alias-label-primary, #e5e7eb)', fontSize: 13,
    };
    const resultOf = (block) => {
      try {
        return JSON.parse(block.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
      } catch {
        return null;
      }
    };
    const mediaUrl = (value) => {
      if (typeof value !== 'string') return null;
      try {
        const url = new URL(value, location.origin);
        return url.origin === location.origin && url.pathname.startsWith('/api/media/') ? url.pathname + url.search : null;
      } catch {
        return null;
      }
    };
    function TaskCard({ initialTask }) {
      const [task, setTask] = React.useState(initialTask);
      const [error, setError] = React.useState('');
      const [retry, setRetry] = React.useState(0);
      const taskId = initialTask.taskId;
      React.useEffect(() => {
        const controller = new AbortController();
        let timer;
        setError('');
        const poll = async () => {
          try {
            const response = await fetch('/canvas/api/greenroom/tasks/' + encodeURIComponent(taskId), {
              credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            });
            const body = await response.json();
            if (!response.ok || !body.success) throw new Error(body.error || '暂时无法查询生成任务');
            if (controller.signal.aborted) return;
            setTask(body.data);
            setError('');
            if (body.data.status === 'pending' || body.data.status === 'running') timer = setTimeout(poll, 3000);
          } catch (reason) {
            if (!controller.signal.aborted) setError(reason.message || '暂时无法查询生成任务');
          }
        };
        poll();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [taskId, retry]);
      const pending = task.status === 'pending' || task.status === 'running';
      const progress = typeof task.progress === 'number' ? Math.min(100, Math.max(0, task.progress)) : 0;
      const outputs = (task.outputs || []).map((output) => ({ ...output, url: mediaUrl(output.url) })).filter((output) => output.url);
      return jsx('section', {
        'data-greenroom-task': taskId, 'aria-label': taskTitles[task.kind] || '生成任务', style: cardStyle,
        children: [
          jsx('div', {
            style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
            children: [jsx('strong', { children: taskTitles[task.kind] || '生成任务' }, 'title'),
              jsx('span', { role: 'status', 'aria-live': 'polite', style: { color: 'var(--dsw-alias-label-secondary, #d1d5db)' },
                children: `${taskStatus[task.status] || '查询中'}${pending ? ` ${Math.round(progress)}%` : ''}` }, 'status')],
          }, 'header'),
          pending && jsx('progress', { max: 100, value: progress, 'aria-label': '生成进度',
            style: { width: '100%', height: 6, accentColor: '#10b981' } }, 'progress'),
          task.error && jsx('div', { role: 'alert', style: { color: '#f87171', whiteSpace: 'pre-wrap' }, children: task.error }, 'task-error'),
          outputs.map((output, index) => jsx('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' },
            children: [
              output.mimeType?.startsWith('image/') && jsx('img', {
                src: output.url, alt: `生成图片 ${index + 1}`, loading: 'lazy',
                style: { display: 'block', maxWidth: '100%', maxHeight: 360, borderRadius: 8, objectFit: 'contain' },
              }, 'preview'),
              output.mimeType?.startsWith('video/') && jsx('video', {
                src: output.url, controls: true, preload: 'metadata', 'aria-label': `生成视频 ${index + 1}`,
                style: { display: 'block', width: '100%', maxHeight: 360, borderRadius: 8 },
              }, 'preview'),
              jsx('a', { href: output.url, download: '', style: { ...actionStyle, textDecoration: 'none' },
                children: `下载${task.kind === 'video' ? '视频' : '图片'}${outputs.length > 1 ? ` ${index + 1}` : ''}` }, 'download'),
            ],
          }, output.assetId || output.url)),
          error && jsx('div', {
            role: 'alert', style: { color: '#f87171', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
            children: [jsx('span', { children: error }, 'message'), jsx('button', {
              type: 'button', style: actionStyle, onClick: () => setRetry((value) => value + 1), children: '重新查询',
            }, 'retry')],
          }, 'query-error'),
        ],
      });
    }
    function CanvasRunCard({ initialRun, title }) {
      const [run, setRun] = React.useState(initialRun);
      const [error, setError] = React.useState('');
      const [retry, setRetry] = React.useState(0);
      const runId = initialRun.runId || initialRun.id;
      React.useEffect(() => {
        const controller = new AbortController();
        let timer;
        const poll = async () => {
          try {
            const response = await fetch('/canvas/api/greenroom/runs/' + encodeURIComponent(runId), {
              credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            });
            const body = await response.json();
            if (!response.ok || !body.success) throw new Error(body.error || '画布运行状态暂不可查询');
            if (controller.signal.aborted) return;
            setRun(body.data); setError('');
            if (['queued', 'running', 'polling'].includes(body.data.status)) timer = setTimeout(poll, 3000);
          } catch (reason) {
            if (!controller.signal.aborted) setError(reason.message || '画布运行状态暂不可查询');
          }
        };
        poll();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [runId, retry]);
      const nodes = run.nodes || [];
      const outputs = nodes.flatMap((node) => node.outputs || []).map((output) => ({
        ...output, url: mediaUrl(output.url || output.sourceUrl),
      })).filter((output) => output.url);
      const reason = run.summary?.lastError || nodes.flatMap((node) => node.attempts || []).find((attempt) => attempt.error)?.error;
      const labels = { queued: '等待执行', running: '正在执行', polling: '正在生成', succeeded: '已完成',
        failed: '执行失败', interrupted: '执行中断', stopped: '已停止', cancelled: '已取消' };
      return jsx('section', { style: cardStyle, 'data-greenroom-run': runId, children: [
        jsx('strong', { children: title }, 'title'),
        jsx('span', { role: 'status', children: `${labels[run.status] || run.status || '查询中'} · ${nodes.filter((node) => node.status === 'succeeded').length}/${nodes.length} 个节点完成` }, 'status'),
        reason && jsx('div', { role: 'alert', children: typeof reason === 'string' ? reason : reason.message || '服务商未返回具体失败原因' }, 'reason'),
        ...outputs.map((output, index) => jsx('a', { href: output.url, download: '', style: actionStyle,
          children: `下载产物 ${index + 1}` }, output.id || output.url)),
        error && jsx('div', { role: 'alert', children: error }, 'query-error'),
        jsx('div', { children: [
          jsx('button', { type: 'button', style: actionStyle, onClick: () => openPlugin('greenroom-canvas'), children: '查看画布' }, 'open'),
          jsx('button', { type: 'button', style: actionStyle, onClick: () => setRetry((value) => value + 1), children: '重新查询' }, 'query'),
        ] }, 'actions'),
      ] });
    }
    function ManagedToolView({ toolName, phase, block }) {
      toolName = toolName.replace(/^mcp__greenroom__/, '');
      const title = {
        aigc_models: '可用生成模型', aigc_generate_image: '图片生成', aigc_generate_video: '视频生成', aigc_get_task: '生成任务',
        t8_canvas_list: '画布列表', t8_canvas_get_state: '画布状态', t8_canvas_create_node: '添加画布节点',
        t8_canvas_connect_nodes: '连接画布节点', t8_canvas_update_node: '更新画布节点', t8_canvas_delete_node: '删除画布节点',
        t8_canvas_run: '画布流程', t8_canvas_run_node: '画布生成', t8_canvas_get_run: '画布运行状态',
        t8_canvas_cancel_run: '停止画布流程', t8_canvas_create: '新建画布', t8_canvas_bind_asset: '绑定画布素材',
        t8_canvas_capabilities: '画布可用能力', t8_canvas_compose_videos: '画布视频合成',
        t8_canvas_import_storyboard_scripts: '追加分镜草稿', t8_canvas_get_composition: '成片状态', t8_canvas_batch_update_prompts: '批量更新提示词',
      }[toolName] || toolName;
      if (phase !== 'result') return jsx('div', { style: cardStyle, role: 'status',
        children: `${title} · ${phase === 'preparing' ? '准备中…' : '正在执行操作…'}` });
      const body = resultOf(block);
      if (block.isError || !body?.success) return jsx('div', { style: cardStyle, role: 'alert',
        children: `${title} · ${typeof body?.error === 'string' ? body.error : body?.error?.message || block.error?.reason || block.error?.message || block.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') || '服务商未返回具体失败原因'}` });

      if (toolName.startsWith('huobao_')) {
        const data = body.data || {};
        const failures = Array.isArray(data.failures) ? data.failures : [];
        const url = mediaUrl(data.merged_url || data.mergedUrl || data.video_url || data.videoUrl || data.result_url || data.resultUrl);
        return jsx('section', { style: cardStyle, children: [
          jsx('strong', { children: '火宝短剧' }, 'title'),
          jsx('span', { children: body.message || (Array.isArray(data) ? `已读取 ${data.length} 项` : data.message || data.title || data.name || '操作已完成') }, 'message'),
          Array.isArray(data.submitted) && jsx('span', { role: 'status', children: `已提交 ${data.submitted.length} 项，失败 ${failures.length} 项，跳过 ${data.skipped?.length || 0} 项` }, 'batch-status'),
          ...failures.map((failure, index) => jsx('div', { role: 'alert', style: { color: '#f87171', whiteSpace: 'pre-wrap' },
            children: `条目 ${failure.id ?? index + 1}：${failure.error || failure.message || '服务商未返回具体失败原因'}` }, 'failure-' + index)),
          data.status && jsx('span', { role: 'status', children: `状态：${data.status}` }, 'status'),
          (data.error || data.error_message) && jsx('div', { role: 'alert', children: data.error_message || (typeof data.error === 'string' ? data.error : data.error.message) }, 'error'),
          url && jsx('a', { href: url, download: '', style: actionStyle, children: '下载产物' }, 'download'),
          jsx('button', { type: 'button', style: actionStyle, onClick: () => openPlugin('greenroom-huobao'), children: '查看火宝短剧' }, 'open'),
        ] });
      }

      // 画布工具视图卡片
      if (toolName.startsWith('t8_canvas_')) {
        if ((body.data?.runId || body.data?.id) && Array.isArray(body.data?.nodes) && body.data?.summary?.greenroomExecution) {
          return jsx(CanvasRunCard, { initialRun: body.data, title }, body.data.runId || body.data.id);
        }
        // 如果是创建/连线/更新操作，自动展开右侧画布侧边栏
        if (['t8_canvas_create_node', 't8_canvas_connect_nodes', 't8_canvas_update_node'].includes(toolName)) {
          setTimeout(() => {
            try { openPlugin('greenroom-canvas'); } catch (_) {}
          }, 100);
        }
        return jsx('div', {
          style: cardStyle,
          children: [
            jsx('div', {
              style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
              children: [
                jsx('strong', { children: `▦ ${title}` }, 'title'),
                jsx('button', {
                  type: 'button',
                  style: actionStyle,
                  onClick: () => { openPlugin('greenroom-canvas'); },
                  children: '查看画布',
                }, 'action'),
              ],
            }, 'header'),
            body.message && jsx('div', { style: { color: 'var(--dsw-alias-label-secondary, #d1d5db)' }, children: body.message }, 'msg'),
          ],
        });
      }

      if (toolName === 'aigc_models') return jsx('details', {
        style: cardStyle,
        children: [jsx('summary', { style: { cursor: 'pointer' }, children: title }, 'title'),
          ...['image', 'video'].map((kind) => jsx('div', { children: [
            jsx('strong', { children: kind === 'image' ? '图片' : '视频' }, 'label'),
            jsx('ul', { style: { paddingLeft: 20, margin: '6px 0' },
              children: body.data[kind]?.length ? body.data[kind].map((model) => jsx('li', { children: model.label || model.id }, model.id))
                : jsx('li', { children: '尚未开通' }) }, 'models'),
          ] }, kind))],
      });
      if (typeof body.data?.taskId !== 'string' || !body.data.taskId) return jsx('div', { style: cardStyle, role: 'alert', children: '未返回任务编号，受理情况未确认；请先核对原请求，不要重复提交' });
      return jsx(TaskCard, { initialTask: body.data }, body.data.taskId);
    }
    for (const plugin of plugins) {
      if (plugin.ui === null || plugin.status === 'awaiting-authorization') continue;
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: plugin.tabId, kind: plugin.tabKind, keepMounted: true,
        title: () => plugin.title,
        guide: [{ id: plugin.id, order: 0, title: () => plugin.title, description: () => '在工作台中继续创作' }],
      }));
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: plugin.tabId,
      }, ({ useTabInfo }) => {
        const { tab } = useTabInfo();
        return plugin.id === 't8' ? jsx('iframe', {
          src: plugin.basePath, title: plugin.title,
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: '#18181b' },
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups',
          allow: 'clipboard-read; clipboard-write; fullscreen',
        }) : jsx(PluginPane, { plugin, visible: tab.visible });
      })));
    }
    ctx.effect(() => ctx.slots.inject('greenroom.plugins.launcher', () => ctx.slots.register({
      name: 'greenroom.plugins.launcher',
    }, PluginLauncher)));
    if (showCreationMode) ctx.effect(() => ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({
      name: 'conversation.input.permission',
    }, CreationMode)));
    for (const toolName of managedTools || [
      'aigc_models', 'aigc_generate_image', 'aigc_generate_video', 'aigc_get_task',
      't8_canvas_list', 't8_canvas_get_state', 't8_canvas_create_node',
      't8_canvas_connect_nodes', 't8_canvas_update_node', 't8_canvas_delete_node',
    ]) {
      ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview', key: toolName,
      }, ManagedToolView)));
    }
  });
}
