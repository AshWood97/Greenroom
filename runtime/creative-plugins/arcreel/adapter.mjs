import { readFileSync } from 'node:fs';
const tools = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
export async function createAdapter(ctx) {
  return {
    listTools: () => tools,
    async callTool(name, args = {}, { signal } = {}) {
      if (!tools.some(tool => tool.name === name)) throw new Error(`未知 ArcReel 工具：${name}`);
      return ctx.request('/api/greenroom/call', { method: 'POST', body: { name: name.slice('arcreel_'.length), arguments: args }, signal });
    },
    getUiTarget: () => ctx.endpoint,
    restore: () => ctx.request('/api/greenroom/restore', { method: 'POST', body: {} }),
    close: async () => {},
  };
}
