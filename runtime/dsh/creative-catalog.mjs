import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const CREATIVE_CATALOG = Object.freeze(JSON.parse(readFileSync(new URL('../creative-plugins/catalog.json', import.meta.url), 'utf8')));
export const CREATIVE_PLUGINS = Object.freeze(CREATIVE_CATALOG.plugins.map((plugin) => Object.freeze({
  ...plugin,
  tabId: plugin.tabId || `greenroom-plugin-${plugin.id}`,
  tabKind: plugin.tabKind || `greenroom-plugin-${plugin.id}`,
  basePath: plugin.basePath || `/plugins/${plugin.id}/`,
  sourceAvailable: ['moyin', 'arcreel', 'openmontage'].includes(plugin.id),
})));
export const publicMcpName = (name) => {
  const result = `mcp__greenroom__${name}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(result)) throw new Error(`Invalid managed MCP tool name: ${name}`);
  return result;
};

export function publishedPlugins() {
  return CREATIVE_PLUGINS.filter((plugin) => pluginEnabled(plugin));
}

export function pluginEnabled(plugin, catalog = CREATIVE_CATALOG) {
  if (plugin.status === 'awaiting-authorization') return false;
  return Boolean(plugin.builtin || (plugin.releaseBatch === 'aigc-skills' ? catalog.aigcSkillsReady : catalog.releaseReady));
}

export function displayPlugins() {
  return CREATIVE_PLUGINS.filter((plugin) => pluginEnabled(plugin)
    || plugin.status === 'awaiting-authorization' && CREATIVE_CATALOG.aigcSkillsReady);
}

// A native workspace may host the same prepared knowledge tree as the image.
export function creativeKnowledgeRoot(pluginId, manifest = {}) {
  const installed = manifest.knowledgeRoot || join('/opt/creative-skills', pluginId);
  return process.env.GREENROOM_CREATIVE_SKILLS_ROOT
    ? resolve(process.env.GREENROOM_CREATIVE_SKILLS_ROOT, relative('/opt/creative-skills', installed))
    : installed;
}
