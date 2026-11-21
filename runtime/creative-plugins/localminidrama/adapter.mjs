import { readFileSync } from 'node:fs';
const publishedTools = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
const string = { type: 'string', minLength: 1 };
const id = { type: 'integer', minimum: 1 };
const body = { type: 'object', description: 'LocalMiniDrama 原业务字段，保留剧本、角色、场景及分镜内容。' };
const operations = [
  ['projects', '列出成员的短剧项目', 'GET', () => '/dramas', {}],
  ['create_project', '创建短剧项目', 'POST', () => '/dramas', { body }],
  ['get_project', '读取短剧及分集、角色、场景', 'GET', a => `/dramas/${a.id}`, { id }],
  ['update_project', '更新短剧标题、简介和创作设置', 'PUT', a => `/dramas/${a.id}`, { id, body }],
  ['save_outline', '保存项目大纲', 'PUT', a => `/dramas/${a.id}/outline`, { id, body }],
  ['save_characters', '保存项目角色', 'PUT', a => `/dramas/${a.id}/characters`, { id, body }],
  ['save_episodes', '保存项目分集剧本', 'PUT', a => `/dramas/${a.id}/episodes`, { id, body }],
  ['generate_characters', '从剧本生成角色并持久入库，返回任务编号', 'POST', () => '/generation/characters', { body }],
  ['generate_story', '生成分集剧本；body 必须包含 drama_id', 'POST', () => '/generation/story', { body }],
  ['generate_storyboards', '为指定分集生成分镜并入库', 'POST', a => `/episodes/${a.id}/storyboards`, { id, body }],
  ['storyboards', '读取指定分集的分镜', 'GET', a => `/episodes/${a.id}/storyboards`, { id }],
  ['create_storyboard', '新增分镜', 'POST', () => '/storyboards', { body }],
  ['update_storyboard', '更新分镜内容与提示词', 'PUT', a => `/storyboards/${a.id}`, { id, body }],
  ['generate_character_image', '后台生成角色参考图', 'POST', a => `/characters/${a.id}/generate-image`, { id, body }],
  ['generate_scene_image', '后台生成场景图', 'POST', () => '/scenes/generate-image', { body }],
  ['generate_image', '后台生成分镜或自由创作图片，返回持久业务编号', 'POST', () => '/images', { body }],
  ['image', '读取原图片任务及当前失败原因', 'GET', a => `/images/${a.id}`, { id }],
  ['generate_video', '后台生成分镜视频，返回持久业务编号', 'POST', () => '/videos', { body }],
  ['video', '读取原视频任务及当前失败原因', 'GET', a => `/videos/${a.id}`, { id }],
  ['resume_video', '继续查询已有视频任务，不重新提交', 'POST', a => `/videos/${a.id}/resume-poll`, { id }],
  ['task', '读取后台业务任务状态', 'GET', a => `/tasks/${encodeURIComponent(a.task_id)}`, { task_id: string }],
  ['merge_videos', '创建分集合片任务', 'POST', () => '/video-merges', { body }],
  ['merge', '查询分集合片任务', 'GET', a => `/video-merges/${a.id}`, { id }],
  ['assets', '列出成员私有素材', 'GET', () => '/assets', {}],
];

export async function createAdapter(ctx) {
  return {
    listTools: () => publishedTools,
    async callTool(name, args = {}, { signal } = {}) {
      const operation = operations.find(([key]) => name === `localminidrama_${key}`);
      if (!operation) throw new Error(`未知 LocalMiniDrama 工具：${name}`);
      if (name === 'localminidrama_generate_story' && !args.body?.drama_id) throw new Error('生成剧本需要 body.drama_id');
      const [, , method, path] = operation;
      const result = await ctx.request('/api/v1' + path(args), { method, body: method === 'GET' ? undefined : args.body || {}, signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result?.success === false ? { isError: true } : {}) };
    },
    getUiTarget: () => ctx.endpoint,
    restore: () => ctx.request('/api/greenroom/restore', { method: 'POST', body: {} }),
    close: async () => {},
  };
}
