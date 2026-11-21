import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSuiteAdapter } from '../aigc-shared/adapter.mjs';

const projectId = { type: 'string', pattern: '^[A-Za-z0-9_-]+$' };
const episode = { type: 'integer', minimum: 1 };
const input = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const memories = {
  characters: ['角色档案.md', 'character_template.md'],
  world: ['世界观.md', 'worldbuilding_template.md'],
  blocking: ['场景布局.md', null],
  summary: ['剧情摘要.md', 'plot_summary.md'],
  foreshadow: ['伏笔表.md', 'foreshadow_template.md'],
  bible: ['故事圣经.md', 'story_bible_template.md'],
  relationships: ['角色关系图.md', 'character_graph_template.md'],
};

export const suiteConfig = {
  id: 'manjuforge', prefix: 'manjuforge', knowledgeRoot: '/opt/creative-skills/manjuforge',
  productionKinds: ['image', 'video', 'tts', 'music'], singleModality: true, requireReferenceBindings: true,
  documents: {
    source: '输入/原著.txt', outline: '剧情大纲.md', ...Object.fromEntries(Object.entries(memories).map(([key, [path]]) => [key, path])),
    episode: '第{episode}集_完整版.md', storyboard: '剧集/第{episode}集/分镜.md',
    'image-prompts': '剧集/第{episode}集/图片提示词.md', 'video-prompts': '剧集/第{episode}集/视频提示词.md',
    narration: '剧集/第{episode}集/配音文案.md', music: '剧集/第{episode}集/音乐提示词.md',
  },
  scripts: {
    quality_check: {
      description: '运行原生 quality_check.py 检查指定分集，并读本工程伏笔表、故事圣经和角色关系图；不调用模型。',
      file: 'scripts/quality_check.py', runtime: 'python3',
      inputSchema: input({ projectId, episode, villain: { type: 'string' }, format: { type: 'string', enum: ['vertical', 'landscape'] } }, ['projectId', 'episode']),
      args: async (args, api) => {
        const root = api.projectPath(args.projectId);
        const document = await api.readDocument({ projectId: args.projectId, document: 'episode', episode: args.episode });
        if (document.content === null) throw new Error('请先保存本集完整版文档');
        return [join(root, document.path), '--foreshadow', join(root, '伏笔表.md'), '--bible', join(root, '故事圣经.md'),
          '--graph', join(root, '角色关系图.md'), '--format', args.format || 'vertical', '--json', ...(args.villain ? ['--villain', args.villain] : [])];
      },
    },
    consistency_check: {
      description: '运行原生 consistency_check.py 检查本工程七个记忆文件与已有分集的一致性；不调用模型。',
      file: 'scripts/consistency_check.py', runtime: 'python3', inputSchema: input({ projectId }, ['projectId']),
      args: (args, api) => [api.projectPath(args.projectId), '--json'],
    },
  },
  async createProject(args, api) {
    for (const [document, [, template]] of Object.entries(memories)) {
      const content = template ? await readFile(join(api.knowledgeRoot, 'templates', template), 'utf8')
        : '# 场景布局\n\n每个场景记录功能、空间结构、核心道具、角色位置、出入口和光照状态。\n';
      await api.writeDocument({ projectId: api.project.projectId, document, content, accepted: false });
    }
  },
  async validateProduction(job, api) {
    const title = job.sourceEntry.replace(/^##\s+/, '').trim();
    const headings = [...api.document.content.matchAll(/^##\s+(.+?)\s*$/gm)];
    const index = headings.findIndex((heading) => heading[1].trim() === title);
    if (index < 0) throw new Error('sourceEntry 必须点名当前文档的二级标题条目');
    const section = api.document.content.slice(headings[index].index, index + 1 < headings.length ? headings[index + 1].index : undefined);
    if (!section.includes(job.prompt)) throw new Error('所选标题中找不到完整可复制的提示词，不会猜测或使用旧版提示词');
    if (/\bPLAN-[^\s|，,;；]+/.test(section)) throw new Error('PLAN- 仍是计划占位；先导入真实素材并改成 REF- 绑定后再准备生产');
    const slots = [...new Set(section.match(/\bREF-[A-Za-z0-9_-]+/g) || [])];
    const bindings = job.referenceBindings || [];
    if (slots.length !== bindings.length || slots.some((slot) => !bindings.some((binding) => binding.slot === slot))) {
      throw new Error('所选条目的每个 REF- 槽位都必须与真实素材逐一绑定');
    }
    for (const binding of bindings) {
      const asset = api.project.assets[binding.assetId];
      if (!asset || !/^image\//.test(asset.mimeType || '')) throw new Error('参考图绑定必须指向已导入工程的真实图片');
    }
    job.adapterProfile = { managed: true, model: job.model, kind: job.kind };
  },
};

export async function createAdapter(ctx) { return createSuiteAdapter(ctx, suiteConfig); }
