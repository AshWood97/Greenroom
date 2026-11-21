// Serialized into the pinned native ui-skill module. No filesystem or arbitrary URL access.
export function installSkillDocumentView(ctx, React, jsx) {
  const selected = new Map();
  const listeners = new Set();
  const tabId = 'greenroom-skill-document';
  const notify = () => { for (const listener of listeners) listener(); };
  function ReadOnlyMarkdown({ content }) {
    // Render basic Markdown structure, treating links, images and raw HTML as inert text.
    let fenced = false;
    return jsx('div', { children: content.split('\n').map((line, index) => {
      if (/^```/.test(line)) { fenced = !fenced; return jsx('div', { children: line }, index); }
      const heading = !fenced && /^(#{1,3})\s+(.+)$/.exec(line);
      return jsx(heading ? 'h' + heading[1].length : 'div', {
        style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...(fenced ? { fontFamily: 'monospace' } : {}) },
        children: heading ? heading[2] : line || '\u00a0',
      }, index);
    }) });
  }
  function SkillDocument({ sessionId }) {
    const name = React.useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => selected.get(sessionId) || '');
    const [state, setState] = React.useState({});
    React.useEffect(() => {
      const abort = new AbortController();
      setState({ name, loading: true });
      if (name) fetch('/api/greenroom/skills/document?' + new URLSearchParams({ sessionId, name }), {
        credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
      }).then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error || '说明加载失败'); return result; })
        .then((document) => { if (!abort.signal.aborted) setState({ name, document }); }, (error) => { if (!abort.signal.aborted) setState({ name, error: error.message }); });
      return () => abort.abort();
    }, [sessionId, name]);
    return jsx('section', { 'aria-label': '技能说明', 'data-greenroom-skill-document': name,
      style: { padding: 16, height: '100%', boxSizing: 'border-box', overflow: 'auto' }, children: [
        jsx('h2', { children: name || '技能说明' }, 'title'),
        state.name === name && state.error ? jsx('p', { role: 'alert', children: state.error }, 'error') : null,
        state.name === name && state.document ? jsx('div', { children: [
          jsx('p', { children: state.document.description }, 'description'),
          jsx(ReadOnlyMarkdown, { content: state.document.content }, 'content'),
        ] }, 'document') : jsx('p', { role: 'status', children: name ? '正在读取…' : '在技能菜单或对话中选择“查看说明”' }, 'loading'),
      ],
    });
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: tabId, kind: tabId, title: () => '技能说明', keepMounted: false }));
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tabId, inject: (sessionId) => ({ sessionId }) }, SkillDocument)));
  ctx.effect(() => () => { selected.clear(); listeners.clear(); });
  return (sessionId, name) => {
    if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return false;
    if (!sessionId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !ctx.sessions.scope(sessionId)) return false;
    selected.set(sessionId, name); notify();
    ctx.sidebarRight.openTab(tabId);
    return true;
  };
}
