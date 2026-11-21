import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { formatGenerationError } from '../shared/generation-error.ts';
import { CREATIVE_PLUGINS, publicMcpName } from './creative-catalog.mjs';
import { jsonResult } from './creative-proxy.mjs';
import { createReferencedSchemaValidator } from './creative-schema.mjs';

// One registry owns the live business schemas and dispatch for MCP and HTTP UI.
export function createCreativeTools() {
  const tools = new Map();
  const pluginTools = new Map(CREATIVE_PLUGINS.map((plugin) => [plugin.id, []]));
  const register = (pluginId, definition, execute) => {
    const name = definition.name;
    publicMcpName(name);
    if (tools.has(name)) throw new Error('Duplicate managed MCP tool: ' + name);
    const validateReferenced = createReferencedSchemaValidator(definition.inputSchema);
    const requiresInvocation = ['t8_canvas_bind_asset', 't8_canvas_run', 't8_canvas_run_node', 'open_ai_canvas_generate'].includes(name);
    tools.set(name, { definition: { ...definition, _meta: { ...definition._meta,
      greenroom: { pluginId, requiresInvocation, attachmentRequiresInvocation: Boolean(definition.inputSchema.properties?.attachmentId) } } }, execute, validateReferenced });
    pluginTools.get(pluginId).push(publicMcpName(name));
  };
  const definitions = () => [...tools.values()].map((tool) => tool.definition);
  const call = async (name, args, extra = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error('业务工具不存在');
    const nativeValidation = tool.validateReferenced?.(args);
    const violations = nativeValidation
      ? (nativeValidation.valid ? [] : [nativeValidation.errorMessage])
      : validateJsonSchemaValue(tool.definition.inputSchema, args, '');
    if (violations.length) throw new Error('业务参数无效：' + violations.join('; '));
    try {
      if ((tool.definition._meta.greenroom.requiresInvocation || args.attachmentId) && !extra.exec?.agent) {
        throw new Error('此操作需要有效的 DSH 对话调用上下文；请在成员创作对话中执行，CLI 不能创建或伪造该上下文');
      }
      const result = await tool.execute(args, extra);
      return Array.isArray(result?.content) ? result : jsonResult(result);
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: formatGenerationError(error.message) }] };
    }
  };
  return {
    register,
    call,
    toolNames: (pluginId) => pluginTools.get(pluginId),
    publishedNames: (publishedIds) => new Set([...pluginTools].filter(([id]) => publishedIds.has(id)).flatMap(([, names]) => names)),
    visibleDefinitions: (publishedNames) => definitions().filter((definition) => publishedNames.has(publicMcpName(definition.name))),
    pluginDefinitions: (pluginId) => definitions().filter((definition) => pluginTools.get(pluginId).includes(publicMcpName(definition.name))),
    catalog: (publishedIds) => CREATIVE_PLUGINS.map((plugin) => ({ id: plugin.id, title: plugin.title,
      status: plugin.status || (publishedIds.has(plugin.id) ? 'enabled' : 'disabled'),
      executable: publishedIds.has(plugin.id),
      tools: publishedIds.has(plugin.id) ? pluginTools.get(plugin.id) : [],
      ...(plugin.reason ? { reason: plugin.reason } : {}),
    })),
  };
}
