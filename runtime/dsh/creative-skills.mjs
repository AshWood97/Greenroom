import * as filesystem from '@deepseek-ai/dsh-skill-filesystem';
import * as loader from '@deepseek-ai/dsh-tool-skill';
import { publishedPlugins, creativeKnowledgeRoot } from './creative-catalog.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'greenroom-creative-skills';
export const inject = ['skills', 'tools', 'agents'];
export function installCreativeSkillProvider(ctx) {
  const roots = publishedPlugins().filter((plugin) => plugin.group === 'ai-drama-skills')
    .flatMap((plugin) => {
      const manifest = JSON.parse(readFileSync(new URL('../creative-plugins/' + plugin.id + '/manifest.json', import.meta.url), 'utf8'));
      return manifest.skillRoots.map((root) => join(creativeKnowledgeRoot(plugin.id), root));
    }).filter((root) => existsSync(root));
  if (!roots.length) return false;
  ctx.plugin(filesystem, {
    providerName: 'greenroom-published',
    includeDefaultRoots: false,
    customSkillDirs: roots,
    watch: false,
  });
  return true;
}

export function apply(ctx) {
  if (process.env.GREENROOM_DSH_NATIVE === '1' || installCreativeSkillProvider(ctx)) {
    ctx.plugin(loader, { catalogDescriptionMaxLength: 200 });
  }
}
