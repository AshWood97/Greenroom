import { readFile } from 'node:fs/promises';
import { createSuiteAdapter } from '../aigc-shared/adapter.mjs';

const id = 'awesome-short-drama-skills';
const prefix = 'short_drama_finder';
const knowledgeRoot = '/opt/creative-skills/' + id;
const strings = (values) => ({ type: 'array', items: { type: 'string', ...(values ? { enum: values } : {}) } });
const stages = ['market', 'adaptation', 'character', 'structure', 'drafting', 'revision', 'storyboard', 'prompt', 'production'];
const models = ['seedance', 'kling', 'minimax', 'wan', 'veo', 'sora', 'comfyui'];
const textOf = (value, lang) => typeof value === 'string' ? value : value?.[lang] || value?.zh || value?.en || '';

async function readCatalog(ctx, signal, root) {
  try {
    const data = await ctx.readSkillCatalog(signal);
    if (!Array.isArray(data.items)) throw new Error('短剧清单格式已变化');
    return { ...data, source: 'https://shortdramaskills.com/data.json' };
  } catch (error) {
    if (signal?.aborted) throw error;
    const readme = await readFile(root + '/README.md', 'utf8');
    const items = [];
    for (const match of readme.matchAll(/^- [^\n]*?\*\*\[([^\]]+)\]\((https:\/\/github\.com\/([^\s)]+))\)\*\*([^\n]*)/gm)) {
      const line = match[4].replace(/<br>/g, ' ').replace(/<[^>]*>/g, '').replace(/^[^：]*：/, '');
      const group = readme.slice(0, match.index).match(/<a id="group-([a-z]+)"><\/a>/g)?.at(-1)?.match(/group-([a-z]+)/)?.[1];
      const stageLabels = { market: '选题', adaptation: '改编', character: '人物', structure: '集纲', drafting: '剧本', revision: '审稿', storyboard: '分镜', prompt: '提示词', production: '出片' };
      if (!items.some((item) => item.repo === match[3])) items.push({ repo: match[3], github: match[2], desc: line, format: 'skill', type: group,
        featured: match[0].includes('🌟'), archived: match[0].includes('已归档'), pushed_at: match[4].match(/更新于 ([\d-]+)/)?.[1],
        license: match[4].match(/· ([A-Za-z0-9.+-]+)<\/sub>/)?.[1],
        stages: Object.entries(stageLabels).filter(([, label]) => match[4].split('<sub>阶段：')[1]?.split('</sub>')[0]?.includes(label)).map(([key]) => key),
        models: models.filter((model) => match[4].toLowerCase().includes(model)),
      });
    }
    return { items, source: '固定上游 README.md', updated: readme.match(/元数据更新于 ([\d-]+)/)?.[1] || null, fallback: true };
  }
}

async function integrations() {
  const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url), 'utf8'));
  const entries = await Promise.all(catalog.plugins.filter((plugin) => !plugin.builtin).map(async (plugin) => {
    if (plugin.status === 'awaiting-authorization') return [plugin.upstream?.replace(/^https:\/\/github\.com\//, '').split('/').slice(0, 2).join('/').toLowerCase(), { pluginId: plugin.id, title: plugin.title, status: '授权未明确，平台不可执行' }];
    const manifest = JSON.parse(await readFile(new URL('../' + plugin.id + '/manifest.json', import.meta.url), 'utf8'));
    const ready = plugin.releaseBatch === 'aigc-skills' ? catalog.aigcSkillsReady : catalog.releaseReady;
    return [manifest.upstream?.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').toLowerCase(), { pluginId: plugin.id, title: plugin.title, status: ready ? '已接入平台，选择该插件后使用' : '已接入，待平台整批开放' }];
  }));
  return new Map(entries);
}

export async function createAdapter(ctx) {
  return createSuiteAdapter(ctx, {
    id, prefix, knowledgeRoot, productionKinds: [],
    documents: { recommendations: 'recommendations.md' }, knowledgeFiles: ['README.md', 'README.en.md'],
    extraTools: [{
      name: prefix + '_find', description: '按创作阶段、模型、Agent及关键词推荐短剧Skill，显示平台接入状态；只推荐，不安装或扩大知识目录。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        query: { type: 'string', description: '用户创作目标或关键词。' }, stages: strings(stages), models: strings(models),
        agent: { type: 'string' }, language: { type: 'string', enum: ['zh', 'en'] },
        type: { type: 'string', enum: ['pipeline', 'writing', 'visual', 'source', 'craft', 'companion', 'platform'] },
        licenses: strings(), limit: { type: 'integer', minimum: 1, maximum: 5 },
      } },
    }],
    handlers: {
      async find(args, api) {
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5)) throw new Error('limit 参数必须是 1 至 5 的整数');
        const data = await readCatalog(ctx, api.signal, api.knowledgeRoot);
        const connected = await integrations();
        const lang = args.language || 'zh';
        const query = (args.query || '').toLowerCase();
        const keywords = query.match(/改编|小说|角色|人物|集纲|大纲|钩子|剧本|审稿|分镜|提示词|出片|配音|剪辑|seedance|kling|minimax|wan|veo|sora|comfyui/g) || [];
        const terms = keywords.length ? [...new Set(keywords)] : query.split(/[\s，、,。；;]+/).filter(Boolean);
        const selected = data.items.filter((item) => !item.archived && (args.type === 'platform' || item.type !== 'platform'))
          .filter((item) => !args.type || item.type === args.type)
          .filter((item) => !args.stages?.length || args.stages.some((stage) => item.stages?.includes(stage)))
          .filter((item) => !args.models?.length || args.models.some((model) => item.models?.includes(model)))
          .filter((item) => !args.licenses?.length || args.licenses.includes(item.license))
          .map((item) => {
            const description = [textOf(item.desc, lang), textOf(item.overview, lang), textOf(item.note, lang)].filter(Boolean).join(' ');
            const haystack = (item.repo + ' ' + description + ' ' + (item.stages || []).join(' ') + ' ' + (item.models || []).join(' ')).toLowerCase();
            const matches = terms.filter((term) => haystack.includes(term)).length;
            return { item, description, score: matches * 100 + (item.featured ? 20 : 0) + (item.agents?.includes(args.agent) ? 10 : 0) + (item.format === 'skill' ? 2 : 0), matches };
          }).filter((entry) => !terms.length || entry.matches)
          .sort((a, b) => b.score - a.score || String(b.item.pushed_at || '').localeCompare(String(a.item.pushed_at || '')) || (b.item.stars || 0) - (a.item.stars || 0))
          .slice(0, args.limit || 5)
          .map(({ item, description }) => ({
            repo: item.repo, github: item.github, description, type: item.type || null, stages: item.stages || [], models: item.models || [],
            agents: item.agents || [], license: item.license || null, updated: item.pushed_at || null, page: textOf(item.page, lang),
            platformIntegration: connected.get(String(item.repo).toLowerCase()) || { status: '尚未接入平台，仅供参考' },
          }));
        return { source: data.source, updated: data.updated, fallback: !!data.fallback, recommendations: selected,
          note: data.fallback ? '已回退固定README；阶段、模型及许可信息以原文为准。不会安装推荐项目。' : '推荐清单仅供选择；接入状态由平台插件清单确定，不运行安装命令。' };
      },
    },
  });
}
