import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareKnowledge } from '../aigc-shared/prepare.mjs';

await prepareKnowledge({
  root: process.argv[2], productionKinds: [], id: 'awesome-short-drama-skills', prefix: 'short_drama_finder',
  skillFiles: ['skills/short-drama-skill-finder/SKILL.md'],
  async patch(root) {
    const keep = new Set(['skills', 'README.md', 'README.en.md', 'LICENSE']);
    for (const entry of await readdir(root)) if (!keep.has(entry)) await rm(join(root, entry), { recursive: true, force: true });
    for (const entry of await readdir(join(root, 'skills'))) if (entry !== 'short-drama-skill-finder') await rm(join(root, 'skills', entry), { recursive: true, force: true });
  },
  notes: `本插件只接入 short-drama-skill-finder。使用 mcp__greenroom__short_drama_finder_find 按原阶段/模型/Agent分类推荐3至5项；工具固定读取 https://shortdramaskills.com/data.json，失败读取镜像的固定README。推荐必须标注平台接入状态；尚未接入仅供参考。下文的install字段和安装指令仅为上游介绍，不在平台执行，不扩展Skill目录，不扫描或安装清单内仓库。`,
});
