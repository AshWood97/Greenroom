import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const EDIT_FORK_PATH = '/api/greenroom/session/edit-fork';
const fail = (message) => { throw new Error(message); };
export function assertEditableMessage(events, messageSeq) {
  if (!Number.isSafeInteger(messageSeq) || messageSeq < 1) fail('无法确定这条消息的分叉位置');
  const event = events[messageSeq];
  if (event?.seq !== messageSeq || event.type !== 'user/message' || event.surfaceOp !== 'append' || event.data?.source?.kind !== 'user') fail('只能编辑真实用户消息');
  if (!Array.isArray(event.data.content) || event.data.content.some(x => !['text','image','file'].includes(x.type))) fail('这条消息包含暂不支持重发的内容');
  return event;
}
export function assertIdleAgent(agent) {
  if (agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) fail('请先等待原对话完成并处理排队消息');
}

// Only original message references enter this function. The browser cannot supply
// a host path, an attachment handle from another session, or an upload receipt.
export async function restageEditedContent(ctx, childId, message, text, signal) {
  const content = [{ type: 'text', text }];
  for (const part of message.content) {
    signal.throwIfAborted();
    if (part.type === 'image') {
      const image = await ctx.attachments.readImage(part.attachment);
      content.push({ type: 'image', data: Buffer.from(image.data).toString('base64'), mediaType: image.ref.mediaType });
    } else if (part.type === 'file') {
      const uploaded = await ctx.fileUploads.uploadStream({ sessionId: childId, name: part.attachment.name,
        data: ctx.attachments.readFileStream(part.attachment, signal), signal });
      content.push({ type: 'file', receiptId: uploaded.receiptId });
    }
  }
  return content;
}

export function createSessionEditor(ctx, { root = join(process.env.DSH_HOME, 'greenroom-edit-forks') } = {}) {
  const sourceLocks = new Set();
  const operations = new Map();
  const admissions = new Map();
  const originalPrompt = ctx.sessionController.commands.prompt.bind(ctx.sessionController.commands);
  const promptGuard = async (request, source) => {
    const id = request.sessionId;
    if (sourceLocks.has(id)) fail('原对话正在分叉，请稍后再发送');
    admissions.set(id, (admissions.get(id) || 0) + 1);
    try { return await originalPrompt(request, source); }
    finally {
      const remaining = admissions.get(id) - 1;
      if (remaining) admissions.set(id, remaining);
      else admissions.delete(id);
    }
  };
  ctx.sessionController.commands.prompt = promptGuard;
  ctx.effect?.(() => () => { if (ctx.sessionController.commands.prompt === promptGuard) ctx.sessionController.commands.prompt = originalPrompt; });
  async function perform(request, signal) {
    const { sessionId, messageSeq, text, requestId } = request;
    if (typeof sessionId !== 'string' || sessionId.length > 200 || typeof text !== 'string' || text.length > 100000 || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId || '')) fail('编辑请求无效');
    const file = join(root, requestId + '.json');
    try {
      const previous = JSON.parse(await readFile(file, 'utf8'));
      if (previous.sessionId !== sessionId || previous.messageSeq !== messageSeq || previous.text !== text) fail('请求编号已用于不同的编辑');
      return { status: previous.status, childId: previous.childId, error: previous.status === 'accepted' ? undefined : '此请求已处理或结果待确认，请打开已有分支核对，不要重复重发' };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (sourceLocks.has(sessionId)) fail('原对话已有分叉操作正在进行');
    if (admissions.has(sessionId)) fail('原对话正在接收消息，请稍后再编辑');
    sourceLocks.add(sessionId);
    let record;
    const save = async () => { await writeFile(file + '.tmp', JSON.stringify(record), { mode: 0o600 }); await rename(file + '.tmp', file); };
    try {
      const resolved = await ctx.sessionController.agents.resolveAgent(sessionId);
      if (resolved.error) throw resolved.error;
      const source = resolved.agent;
      assertIdleAgent(source);
      const observed = await ctx.sessionQuery.observeSession(sessionId);
      let event;
      try { event = assertEditableMessage(observed.events, messageSeq); }
      finally { observed[Symbol.dispose](); }
      if (!text.trim() && !event.data.content.some(part => part.type === 'image' || part.type === 'file')) fail('消息不能是空白内容');
      const selection = { ...source.model.current() };
      signal.throwIfAborted();
      // A disk admission record exists before creating a session. A process/network
      // interruption cannot silently create a second child or admit a second prompt.
      await mkdir(root, { recursive: true });
      record = { sessionId, messageSeq, text, status: 'started' };
      await writeFile(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      assertIdleAgent(source);
      const child = await ctx.sessionController.fork({ sessionId, atSeq: messageSeq - 1 });
      record.childId = child.sessionId; record.status = 'created'; await save();
      const childAgent = ctx.agents.get(child.sessionId);
      if (!childAgent) fail('新对话尚未就绪，请打开分支核对');
      ctx.get('goals')?.disarm(childAgent);
      await ctx.sessionController.selectModel({ sessionId: child.sessionId, ...selection });
      const content = await restageEditedContent(ctx, child.sessionId, event.data, text, signal);
      signal.throwIfAborted();
      record.status = 'submitting'; await save();
      const result = await ctx.sessionController.prompt({ sessionId: child.sessionId, content, requestId, mode: 'followup' }, signal);
      if (!result.accepted) fail('新对话未确认接收消息');
      record.status = 'accepted'; await save();
      return { status: 'accepted', childId: child.sessionId };
    } catch (error) {
      if (record) return { status: record.status, childId: record.childId, error: '编辑分叉未完成；请检查已有分支，未自动重发。' };
      throw error;
    } finally { sourceLocks.delete(sessionId); }
  }
  return {
    edit(request, signal = new AbortController().signal) {
      const existing = operations.get(request.requestId);
      if (existing) {
        if (JSON.stringify(existing.request) !== JSON.stringify(request)) return Promise.reject(new Error('请求编号冲突'));
        return existing.promise;
      }
      const promise = perform(request, signal).finally(() => operations.delete(request.requestId));
      operations.set(request.requestId, { request, promise });
      return promise;
    },
  };
}

export function installSessionFork(ctx) {
  const editor = createSessionEditor(ctx);
  // Connection's exact /api routes authenticate the browser and explicitly
  // reject non-owner peers before invoking this callback (pinned rc.1).
  ctx.connection.fetch.register({ path: EDIT_FORK_PATH, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try {
      const body = await request.text();
      if (body.length > 110000) return Response.json({ error: '编辑消息过长' }, { status: 413 });
      return Response.json(await editor.edit(JSON.parse(body), request.signal), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
  }});
  return editor;
}
