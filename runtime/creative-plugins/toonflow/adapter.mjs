import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
const publishedTools = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
const text = { type: 'string', minLength: 1 };
const object = { type: 'object' };
const point = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] };
const operations = [
  ['projects', '列出成员的 Toonflow 工作区', {}],
  ['create_project', '创建成员私有工作区及原生画布', { name: text }],
  ['canvases', '列出工作区内原生 Toonflow 画布', { project: text }],
  ['get_canvas', '读取原生画布的节点、连线和任务状态', { project: text, canvas: text }],
  ['create_canvas', '新建原生 Toonflow 画布', { project: text, canvas: text }],
  ['add_node', '新增原生节点，支持 textNode/imageGenerationNode/videoGenerationNode/audioGenerationNode/imageNode/videoNode/director3dNode 等已安装节点', { project: text, canvas: text, type: text, label: text, position: point }],
  ['update_node', '修改节点创作数据，如 prompt/promptModel/model/ratio/size/textSnapshot；不写凭据', { project: text, canvas: text, node_id: text, data: object }],
  ['move_node', '移动原生画布节点', { project: text, canvas: text, node_id: text, position: point }],
  ['delete_node', '删除节点及其连线', { project: text, canvas: text, node_id: text }],
  ['connect', '连接节点的原生输入输出端口', { project: text, canvas: text, source: text, target: text, sourceHandle: text, targetHandle: text }],
  ['delete_edge', '删除画布连线', { project: text, canvas: text, edge_id: text }],
  ['generate_node', '后台执行图片、视频或音频生成节点，立即返回任务编号；关闭页面后继续并回填原画布', { project: text, canvas: text, node_id: text }],
  ['image_variant', '用官方打光、多角度或全景提示词创建原生图片生成草稿，不自动生成或渲染', { project: text, canvas: text, node_id: text, kind: text, model_id: text, ratio: text, size: text, options: object }],
  ['analyze_scenes', '按官方抽样图片合同逐镜头分析并归纳；保留原任务和人工标注，不把抽样理解当完整视频理解', { project: text, canvas: text, node_id: text, model_id: text, focus: { type: 'string' } }],
  ['local_media', '执行原生分镜抽帧、视频处理或图片宫格切分；保留原媒体并添加素材节点，不调用模型', { project: text, canvas: text, node_id: text, kind: text, options: object }],
  ['director', '读取原导演台场景、选择已有方案或向已有绑定场景添加原生人偶；不生成或渲染方案', { project: text, canvas: text, node_id: text, action: text, plan_id: text, anchors: { type: 'array' }, anchor_ids: { type: 'array' }, anchor_id: text }],
  ['task', '读取已受理任务和最后查询原因', { task_id: text }],
  ['resume', '继续查询已受理的平台任务，恢复结果回填', {}],
  ['models', '读取管理员授权的创作模型', {}],
  ['generate_text_node', '按原生文本节点的提示词和有序引用生成；仅绑定的原文稿，保留人工编辑和原任务', { project: text, canvas: text, node_id: text }],
  ['generate_text', '调用原生文本模型生成并保存项目内 .txt/.md 文档；不启动 Agent 或媒体任务', { project: text, path: text, prompt: text, model_id: text, references: { type: 'array' } }],
  ['read_document', '读取项目内的剧本或提示词文件', { project: text, path: text }],
  ['write_document', '保存项目内的剧本或提示词文件', { project: text, path: text, content: { type: 'string' } }],
  ['archive_media', '将成员工作区产物归档到私有资产库', { project: text, path: text }],
];
export async function createAdapter(ctx) {
  return {
    listTools: () => publishedTools,
    async callTool(name, args = {}, { signal, callId } = {}) {
      const operation = operations.find(([id]) => `toonflow_${id}` === name);
      if (!operation) throw new Error(`未知 Toonflow 工具：${name}`);
      if (name === 'toonflow_archive_media') {
        const file = await ctx.request('/api/greenroom/operation', { method: 'POST', body: { operation: 'media_path', arguments: args }, signal });
        if (file.asset) return { content: [{ type: 'text', text: JSON.stringify(file.asset) }] };
        const format = {
          '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'],
          '.webp': ['image', 'image/webp'], '.gif': ['image', 'image/gif'],
          '.mp4': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'],
          '.mp3': ['audio', 'audio/mpeg'], '.mpeg': ['audio', 'audio/mpeg'], '.wav': ['audio', 'audio/wav'],
          '.flac': ['audio', 'audio/flac'], '.opus': ['audio', 'audio/ogg'], '.ogg': ['audio', 'audio/ogg'], '.m4a': ['audio', 'audio/mp4'],
          '.txt': ['document', 'application/octet-stream'], '.md': ['document', 'application/octet-stream'],
          '.json': ['document', 'application/octet-stream'], '.srt': ['document', 'application/octet-stream'], '.vtt': ['document', 'application/octet-stream'],
        }[extname(file.path).toLowerCase()];
        if (!format) throw new Error('不支持归档的 Toonflow 产物格式');
        return { content: [{ type: 'text', text: JSON.stringify(await ctx.archiveFile(file.path,
          { filename: basename(file.path), assetType: format[0], mimeType: format[1], signal })) }] };
      }
      if (['toonflow_generate_text','toonflow_generate_text_node','toonflow_generate_node','toonflow_local_media','toonflow_analyze_scenes','toonflow_image_variant'].includes(name) && !callId) throw new Error('生成操作缺少真实 DSH callId');
      const result = await ctx.request('/api/greenroom/operation', { method: 'POST', body: { operation: operation[0], arguments: args, ...(['toonflow_generate_text','toonflow_generate_text_node','toonflow_generate_node','toonflow_local_media','toonflow_analyze_scenes','toonflow_image_variant','toonflow_director'].includes(name) ? { callId } : {}) }, signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result?.isError ? { isError: true } : {}) };
    },
    getUiTarget: () => ctx.endpoint,
    restore: () => ctx.request('/api/greenroom/operation', { method: 'POST', body: { operation: 'resume', arguments: {} } }),
    close: async () => {},
  };
}
