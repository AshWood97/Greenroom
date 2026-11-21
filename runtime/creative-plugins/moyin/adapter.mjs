import { readFileSync } from 'node:fs';
const publishedTools = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
const string = { type: 'string', minLength: 1 };
const object = { type: 'object' };
const operations = [
  ['projects', '列出原生魔因项目', {}],
  ['create_project', '创建原生魔因项目', { name: string }],
  ['project', '读取项目的剧本、角色、场景、分镜和导演数据', { projectId: string }],
  ['import_script', '后台导入完整剧本，复用魔因原生结构分析与入库', { projectId: string, text: string, options: object }],
  ['parse_script', '后台解析剧本，复用魔因原生分析与结构', { projectId: string, text: string, options: object }],
  ['generate_episode_shots', '后台生成分集分镜并保存原生工程', { projectId: string, episodeIndex: { type: 'integer', minimum: 1 }, options: object }],
  ['calibrate_shots', '后台校准分集分镜', { projectId: string, episodeIndex: { type: 'integer', minimum: 1 }, options: object }],
  ['calibrate_titles', '后台校准分集标题', { projectId: string, options: object }],
  ['episode_synopses', '后台生成分集梗概', { projectId: string, options: object }],
  ['update_shot', '修改原生分镜的创作字段', { projectId: string, shotId: string, changes: object }],
  ['update_character', '修改原生剧本角色字段', { projectId: string, characterId: string, changes: object }],
  ['update_scene', '修改原生剧本场景字段', { projectId: string, sceneId: string, changes: object }],
  ['shot_image', '后台生成指定分镜图片并回填原分镜', { projectId: string, shotId: string, config: object }],
  ['shot_video', '后台生成指定分镜视频并回填原分镜', { projectId: string, shotId: string, config: object }],
  ['generate_image', '后台生成参考图或自由创作图片，持久保存成员私有产物', { projectId: string, prompt: string, options: object }],
  ['generate_video', '后台生成视频，持久保存成员私有产物', { projectId: string, prompt: string, options: object }],
  ['angle_switch', '托管参考图视角重绘，保留原生视角提示词；不是 RunningHub App，可能收费，效果与参考图能力由模型判定', {}],
  ['prepare_quad_grid', '读取原生四宫格完整上下文和角色参考，不提交模型或上传素材', {}],
  ['apply_quad_result', '将本项目既有切分结果应用导演首尾帧，不上传或生成', {}],
  ['split_quad_grid', '按原生2x2顺序切分既有四宫格图并保存到成员素材；不调用模型', {}],
  ['export_media', '复用原生目录导出，保存当前项目媒体和manifest到成员私有输出；不生成新媒体', {}],
  ['tasks', '列出业务任务、逐项错误及私有产物', {}],
  ['task', '读取既有任务状态和真实失败原因', { taskId: string }],
  ['resume', '恢复未完成的原业务任务和平台生成编号', {}],
];
const immediate = new Set(['projects', 'create_project', 'project', 'update_shot', 'update_character', 'update_scene', 'prepare_quad_grid']);
export async function createAdapter(ctx) {
  return {
    listTools: () => publishedTools,
    async callTool(name, args = {}, { signal, callId } = {}) {
      const id = name.replace(/^moyin_/, '');
      if (!operations.some(([key]) => key === id)) throw new Error(`未知魔因工具：${name}`);
      let result;
      if (id === 'tasks') result = await ctx.request('/api/greenroom/tasks', { signal });
      else if (id === 'task') result = await ctx.request('/api/greenroom/tasks/' + encodeURIComponent(args.taskId), { signal });
      else if (id === 'resume') result = await ctx.request('/api/greenroom/restore', { method: 'POST', body: {}, signal });
      else result = await ctx.request(immediate.has(id) ? '/api/greenroom/business' : '/api/greenroom/submit', {
        method: 'POST', body: { operation: id, arguments: args, ...(callId ? { submissionId: callId } : {}) }, signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result.isError ? { isError: true } : {}) };
    },
    getUiTarget: () => ctx.endpoint,
    restore: () => ctx.request('/api/greenroom/restore', { method: 'POST', body: {} }),
    close: async () => {},
  };
}
