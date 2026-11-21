import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { CREATIVE_PLUGINS, publicMcpName, publishedPlugins } from './creative-catalog.mjs';

// Invocation tokens retain the real DSH execution only for that SDK call.
export function createCreativeInvocations() {
  const invocations = new Map();
  return {
    resolve(token, extra) {
      const exec = token ? invocations.get(token) : undefined;
      if (token && !exec) throw new Error('创作会话已失效');
      return {
        signal: exec?.signal || extra.signal,
        callId: exec?.callId || String(extra.requestId),
        sessionId: exec?.agent?.session.id,
        exec: exec || { signal: extra.signal, callId: String(extra.requestId) },
      };
    },
    async call(client, name, args, exec) {
      const token = randomUUID();
      invocations.set(token, exec);
      try {
        return await client.callTool({ name, arguments: args, _meta: { greenroomInvocation: token } }, {
          // Native Huobao agents may perform twenty model steps. Keep their
          // DSH cancellation lifetime instead of the SDK's one-minute deadline.
          signal: exec.signal, timeout: 2_147_483_647,
        });
      } finally { invocations.delete(token); }
    },
  };
}

// Successful call/result pairs are authoritative; a failed selection or a later
// uncompleted call must not replace the last accepted selection (including []).
export function restoredPluginSelection(session, publishedIds) {
  const calls = new Map();
  let selected = [];
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq);
    const d = event.data;
    const key = (callId) => `${d.turn}:${d.step}:${callId}`;
    if (event.type === 'tool/call' && d.name === 'greenroom_select_plugins') calls.set(key(d.callId), { event, args: d.arguments });
    if (event.type !== 'tool/result' || d.message?.isError !== false) continue;
    const call = calls.get(key(d.message.toolCallId));
    if (!call || !event.sourceEventSeqs?.includes(call.event.seq)) continue;
    try {
      const args = JSON.parse(call.args);
      const result = JSON.parse(d.message.content.filter(x => x.type === 'text').map(x => x.text).join(''));
      if (result.success !== true || !Array.isArray(args.plugins) || !args.plugins.every(x => typeof x === 'string')) continue;
      if (!Array.isArray(result.plugins) || JSON.stringify(result.plugins.map(x => x.id)) !== JSON.stringify(args.plugins)) continue;
      selected = [...new Set(args.plugins.filter(x => publishedIds.has(x)))];
    } catch {}
  }
  return selected;
}

// DSH projects the same live MCP schemas into each agent's selected plugins.
export function registerCreativeConversations(ctx, { client, definitions, baseTools, registry, invocations, publishedIds }) {
  const native = process.env.GREENROOM_DSH_NATIVE === '1';
  const restrictions = new Map();
  const managedNames = new Set(baseTools);
  for (const definition of definitions) {
    const name = publicMcpName(definition.name);
    managedNames.add(name);
    ctx.tools.register(createMcpToolDefinition(ctx, {
      name, rawName: definition.name, description: definition.description, inputSchema: definition.inputSchema,
      call: (args, exec) => invocations.call(client, definition.name, args, exec),
    }));
  }
  const restrict = (agent, selected = []) => {
    restrictions.get(agent)?.();
    restrictions.delete(agent);
    const globalNames = new Set(ctx.tools.schemas(agent).map((tool) => tool.name));
    const names = [...baseTools, 'greenroom_select_plugins', ...selected.flatMap((id) => registry.toolNames(id) || [])]
      .filter((name) => globalNames.has(name) && (managedNames.has(name) || name === 'greenroom_select_plugins'));
    const allowed = new Set(names);
    // Native tools remain governed by the Agent preset; only unselected
    // Greenroom plugin tools are filtered in standalone.
    if (native) {
      const denied = [...globalNames].filter(name => managedNames.has(name) && !allowed.has(name));
      if (denied.length) restrictions.set(agent, agent.ctx.tools.restrict({ deny: denied }));
    } else {
      restrictions.set(agent, agent.ctx.tools.restrict({ allow: [...allowed] }));
    }
  };
  ctx.tools.register(defineTool({
    name: 'greenroom_select_plugins',
    description: '为当前对话启用创作插件的真实 MCP 工具。先选择所需插件，再直接调用该插件工具；可以同时选择多个。可选：'
      + publishedPlugins().map((plugin) => plugin.id + '（' + plugin.title + '）').join('、') + '。',
    parameters: { plugins: { type: 'array', items: { type: 'string', enum: [...publishedIds] }, required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) {
      restrict(exec.agent, args.plugins);
      return { success: true, plugins: args.plugins.map((id) => ({ id, title: CREATIVE_PLUGINS.find((plugin) => plugin.id === id).title, tools: registry.toolNames(id) })) };
    },
  }));
  managedNames.add('greenroom_select_plugins');
  ctx.on('agent/created', ({ agent }) => { restrict(agent, restoredPluginSelection(agent.session, publishedIds)); }, { global: true });
  ctx.on('agent/disposed', ({ agent }) => { restrictions.get(agent)?.(); restrictions.delete(agent); }, { global: true });
  return {
    managedNames,
    close() { for (const dispose of restrictions.values()) dispose(); },
  };
}
