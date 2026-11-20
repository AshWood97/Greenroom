import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const string = description => ({ type:'string', description, minLength:1 });
const projectId = string('从 projects 获得的本机项目 ID');
const tool = (name, description, properties, required) => ({
  name, description,
  inputSchema:{ type:'object', properties, required, additionalProperties:false },
});
const tools = [
  tool('projects', '列出本机 Greenroom 项目。', {}, []),
  tool('history', '读取 Greenroom 项目已有的创作任务、原任务编号及结果。', { projectId }, ['projectId']),
  tool('media', '根据用户明确要求单次生成图片或配音，产物保存到指定 Greenroom 项目。', {
    projectId, kind:{ type:'string', enum:['image','audio'] }, model:string('已配置供应商的模型 ID'),
    prompt:string('画面提示词或朗读文本'), size:string('图片尺寸'), quality:string('图片画质'), voice:string('配音音色'),
  }, ['projectId','kind','model','prompt']),
  tool('task_status', '查询同一原任务的状态。接受但未完成的任务使用原供应商继续查询。', {
    taskId:string('Greenroom 任务编号'),
  }, ['taskId']),
  tool('plugins', '列出公开插件目录及本机接入状态。', {}, []),
];

export async function handleMcp(req, res, body, service) {
  const server = new Server({ name:'greenroom', version:'0.1.0' }, { capabilities:{ tools:{} } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator:undefined, enableJsonResponse:true });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params:{ name, arguments:args = {} } }) => {
    try {
      let result;
      if (name === 'projects') result = service.projects();
      else if (name === 'history') result = service.tasks(args.projectId);
      else if (name === 'plugins') result = service.plugins();
      else if (name === 'task_status') result = await service.pollTask(args.taskId);
      else if (name === 'media' && ['image','audio'].includes(args.kind)) {
        const { kind, model, prompt, projectId, ...options } = args;
        result = await service.createTask(projectId, { kind, model, prompt, options }, 'dsh');
      } else throw new Error('未知工具或参数无效。');
      return { content:[{ type:'text', text:JSON.stringify(result) }], structuredContent:{ result } };
    } catch (error) {
      return { isError:true, content:[{ type:'text', text:error.status ? error.message : 'Greenroom 无法执行此工具。' }] };
    }
  });
  res.once('close', () => { void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
