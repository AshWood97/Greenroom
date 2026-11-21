import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function patchSessionForkUI(nm) {
  const file = join(nm, '@deepseek-ai/dsh-client-ui-chat/lib/client.js');
  let source = readFileSync(file, 'utf8');
  const marker = '// greenroom-edit-fork-v1';
  if (source.includes(marker)) return;
  const replace = (before, after) => {
    if (!source.includes(before)) throw new Error('DSH edit-fork UI target changed: ' + before.slice(0, 65));
    source = source.replace(before, after);
  };
  const start = 'const UserMessageNodeView=(0,react.memo)(function UserMessageNodeView({node,renderFactorySlot,loadImage,renderSlotChain,t}){';
  const end = 'const ContextMessageNodeView=';
  if (!source.includes(start) || !source.includes(end)) throw new Error('DSH user message renderer changed');
  const a = source.indexOf(start), b = source.indexOf(end, a);
  source = source.slice(0,a) + `const UserMessageNodeView = (0, react.memo)(function UserMessageNodeView({ node, renderFactorySlot, loadImage, renderSlotChain, t, greenroomEdit }) {
      const data = node.data;
      const [editing, setEditing] = react.useState(false);
      const [text, setText] = react.useState('');
      const [phase, setPhase] = react.useState('idle');
      const [error, setError] = react.useState('');
      const [child, setChild] = react.useState(null);
      const requestId = react.useRef(null);
      const running = react.useRef(false);
      const locked = phase !== 'idle';
      const hasAttachments = data.content.some(p => p.type === 'image' || p.type === 'file');
      const submit = async () => {
        if (running.current || locked || (!text.trim() && !hasAttachments)) return;
        running.current = true;
        setPhase('sending'); setError('');
        requestId.current ||= crypto.randomUUID();
        try {
          const result = await greenroomEdit.submit(data.seq, text, requestId.current);
          setChild(result.childId || null);
          if (result.status === 'accepted') {
            setPhase('accepted'); setEditing(false); greenroomEdit.open(result.childId);
          } else { setPhase(result.status === 'rejected' ? 'idle' : 'uncertain'); setError(result.error || '结果未确认，请检查分支，勿重复发送。'); }
        } catch (_) { setPhase('uncertain'); setError('连接中断或请求未完成。请查看会话列表核对分支；本次不会自动重试。'); }
        finally { running.current = false; }
      };
      return react_jsx_runtime.jsxs(react.Fragment, { children: [
        react_jsx_runtime.jsx(UserStyleBubble, {
          node, renderSlotChain, content: data.content, interactive: true, renderFactorySlot, loadImage,
          batchStart: node.kind === 'steering' && node.data.batchStart === true,
          ...(data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
          ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
          actions: (plain) => react_jsx_runtime.jsxs(react.Fragment, { children: [
            react_jsx_runtime.jsx(MessageIconActions, { text: plain, time: data.time, clock: 'start', className: MessageItem_module_css_default.actions, t }),
            greenroomEdit && node.kind === 'user' ? react_jsx_runtime.jsx('button', { type: 'button', disabled: locked,
              onClick: () => { setText(data.content.filter(p => p.type === 'text').map(p => p.text).join('\\n')); setEditing(true); }, children: '编辑并分叉' }) : null
          ] })
        }),
        editing ? react_jsx_runtime.jsxs('div', { role: 'dialog', 'aria-modal': true, 'aria-label': '编辑并分叉重发',
          style: { position: 'fixed', inset: '15% 20%', padding: '20px', background: 'var(--background, #fff)', color: 'var(--foreground, #111)', border: '1px solid #888', borderRadius: '12px', zIndex: 10000, overflow: 'auto' }, children: [
            react_jsx_runtime.jsx('p', { children: '将从此消息之前创建新对话，并发送修改后的内容。原附件会重新绑定；业务工程不会复制，新对话仍可能操作同一个工程。原对话运行中或有排队消息时不可操作。' }),
            react_jsx_runtime.jsx('textarea', { 'aria-label': '修改消息', value: text, disabled: locked, onChange: e => setText(e.target.value), rows: 8, style: { width: '100%' } }),
            error ? react_jsx_runtime.jsx('p', { role: 'alert', children: error }) : null,
            react_jsx_runtime.jsx('button', { type: 'button', disabled: phase === 'sending', onClick: () => setEditing(false), children: '取消 / 关闭' }),
            react_jsx_runtime.jsx('button', { type: 'button', disabled: locked || (!text.trim() && !hasAttachments), onClick: submit, children: phase === 'sending' ? '正在创建并发送…' : '确认分叉并发送' }),
            child ? react_jsx_runtime.jsx('button', { type: 'button', onClick: () => greenroomEdit.open(child), children: '打开已创建分支' }) : null
          ] }) : null
      ] });
    });` + source.slice(b);
  replace('key:`user`,locale:NS,children:{"conversation.chat.user.before":{', `key: "user",
        locale: NS,
        inject: (sessionId) => ({ greenroomEdit: {
          open: (childId) => ctx.uiWorkspace.openSession(childId),
          submit: async (messageSeq, text, requestId) => {
            const response = await fetch('/api/greenroom/session/edit-fork', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, messageSeq, text, requestId }) });
            const result = await response.json();
            if (!response.ok) return { status: 'rejected', error: result.error };
            return result;
          }
        } }),
        children: { "conversation.chat.user.before": {`);
  writeFileSync(file, marker + '\n' + source);
}
