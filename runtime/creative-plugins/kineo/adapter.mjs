import { readFileSync } from 'node:fs';
const tools = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
export async function createAdapter(ctx) {
  return {
    listTools: () => tools,
    async callTool(name, args = {}, { signal, callId } = {}) {
      if (!tools.some(tool => tool.name === name)) throw new Error('未知 Kineo 工具');
      const result = await ctx.request('/api/business', { method: 'POST', signal,
        body: { operation: name.slice('kineo_'.length), arguments: args, submissionId: callId } });
      if (result.error) throw new Error(ctx.formatGenerationError(result.error));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
    getUiTarget: () => ctx.endpoint,
    restore: () => ctx.request('/api/restore', { method: 'POST', body: {} }),
    close: async () => {},
  };
}
