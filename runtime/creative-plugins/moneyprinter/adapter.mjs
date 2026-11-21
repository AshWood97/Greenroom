import { readFileSync } from 'node:fs';
const publishedTools = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
const body = { type: 'object', description: 'MoneyPrinterTurbo 原生请求字段。视频支持托管生图 openai_image、托管生视频 wavespeed，以及上传的 local 素材。' };
const tools = [
  ['script', '根据主题生成视频文案', 'POST', '/api/v1/scripts', { body }],
  ['terms', '根据文案生成顺序关键词', 'POST', '/api/v1/terms', { body }],
  ['social_metadata', '生成视频标题、简介与话题', 'POST', '/api/v1/social-metadata', { body }],
  ['create_video', '后台生成短视频，返回持久任务编号；字幕、转场、画幅、配音参数沿用原生字段', 'POST', '/api/v1/videos', { body }],
  ['create_audio', '创建配音后台任务', 'POST', '/api/v1/audio', { body }],
  ['create_subtitle', '创建字幕后台任务', 'POST', '/api/v1/subtitle', { body }],
  ['tasks', '列出成员的生成任务', 'GET', '/api/v1/tasks', {}],
  ['task', '查询原任务、进度、真实失败原因和私有产物', 'GET', a => '/api/v1/tasks/' + encodeURIComponent(a.task_id), { task_id: { type: 'string', minLength: 1 } }],
  ['resume', '恢复已有任务；托管素材复用原平台任务编号', 'POST', '/api/greenroom/restore', {}],
  ['materials', '列出已上传的成员视频素材', 'GET', '/api/v1/video_materials', {}],
  ['music', '列出可用的背景音乐', 'GET', '/api/v1/musics', {}],
  ['export', '将已有任务成片、音频和字幕归档到成员资产库', null, null, { task_id: { type: 'string', minLength: 1 } }],
];

export async function createAdapter(ctx) {
  return {
    listTools: () => publishedTools,
    async callTool(name, args = {}, { signal } = {}) {
      const operation = tools.find(([key]) => name === `moneyprinter_${key}`);
      if (!operation) throw new Error(`未知 MoneyPrinterTurbo 工具：${name}`);
      if (name === 'moneyprinter_export') {
        const result = await ctx.request('/api/greenroom/export/' + encodeURIComponent(args.task_id), { method: 'POST', body: {}, signal });
        return { content: [{ type: 'text', text: JSON.stringify(result.data || result) }], ...(result.status >= 400 ? { isError: true } : {}) };
      }
      const [, , method, route] = operation;
      const result = await ctx.request(typeof route === 'function' ? route(args) : route, { method, body: method === 'GET' ? undefined : args.body || {}, signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result.status >= 400 ? { isError: true } : {}) };
    },
    getUiTarget: () => ctx.endpoint,
    restore: () => ctx.request('/api/greenroom/restore', { method: 'POST', body: {} }),
    close: async () => {},
  };
}
