import { readFileSync } from 'node:fs';
const pipelineTools = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));

export async function createAdapter(ctx) {
  return {
    listTools: () => [...pipelineTools, {
      name: 'vimax_list_projects', description: '列出当前成员的 ViMax 工程与已有创作阶段。',
      inputSchema: { type: 'object', properties: {} },
    }, {
      name: 'vimax_get_task', description: '查询原 ViMax 后台任务及私有产物；查询不会重新生成。',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    }, {
      name: 'vimax_get_artifacts', description: '读取 ViMax 工程的剧本、分镜、角色及媒体文件列表。',
      inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
    }, {
      name: 'vimax_read_planning_artifact', description: '只读当前成员原生剧本四类规划 JSON，或小说压缩正文、事件、相关片段、场景、全局角色和场景镜头规划。仅固定产物与类型化索引，不接受任意路径/媒体，不重启任务。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        session_id: { type: 'string', minLength: 1 },
        artifact: { type: 'string', enum: ['characters', 'storyboard', 'shot_description', 'camera_tree', 'novel_compressed', 'novel_event', 'novel_relevant_chunks', 'novel_scene', 'novel_event_characters', 'novel_characters', 'novel_storyboard', 'novel_shot_description', 'novel_camera_tree'] },
        shot_index: { type: 'integer', minimum: 0 }, event_index: { type: 'integer', minimum: 0 }, scene_index: { type: 'integer', minimum: 0 },
      }, required: ['session_id', 'artifact'],
      allOf: [
        ['shot_index', ['shot_description', 'novel_shot_description']],
        ['event_index', ['novel_event', 'novel_relevant_chunks', 'novel_scene', 'novel_event_characters', 'novel_characters', 'novel_storyboard', 'novel_shot_description', 'novel_camera_tree']],
        ['scene_index', ['novel_scene', 'novel_storyboard', 'novel_shot_description', 'novel_camera_tree']],
      ].map(([key, values]) => ({ if: { properties: { artifact: { enum: values } } }, then: { required: [key] }, else: { not: { required: [key] } } })) },
    }, {
      name: 'vimax_resume_task', description: '恢复已有 ViMax 任务，沿用已经受理的原生成任务编号与已有文件。',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    }],
    async callTool(name, args, { signal, callId } = {}) {
      const value = name === 'vimax_list_projects' ? await ctx.request('/api/sessions', { signal })
        : name === 'vimax_get_task' ? await ctx.request('/api/tasks/' + encodeURIComponent(args.taskId), { signal })
        : name === 'vimax_resume_task' ? await ctx.request('/api/tasks/' + encodeURIComponent(args.taskId), { method: 'POST', body: {}, signal })
        : name === 'vimax_get_artifacts' ? await ctx.request('/api/artifacts?session=' + encodeURIComponent(args.session_id), { signal })
        : name === 'vimax_read_planning_artifact' ? await ctx.request('/api/planning-artifact?' + new URLSearchParams({ session: args.session_id, artifact: args.artifact, ...Object.fromEntries(['shot_index', 'event_index', 'scene_index'].filter(key => args[key] !== undefined).map(key => [key, String(args[key])])) }), { signal })
        : await ctx.request('/api/tools/' + encodeURIComponent(name), {
          method: 'POST', body: { arguments: args, callId }, signal,
        });
      if (value.status === 'failed' && value.error) value.error = ctx.formatGenerationError(value.error);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: value.status === 'failed' };
    },
    getUiTarget: () => ctx.endpoint,
    restore: () => ctx.request('/api/health'),
    close: async () => {},
  };
}
