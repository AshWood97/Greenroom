import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSuiteAdapter } from '../aigc-shared/adapter.mjs';
import { audioTools } from './audio-tools.mjs';
import { objectSchema as object, projectIdSchema as projectId, prepareRenderInput, textSchema as text, toolDefinition as tool } from './render-input.mjs';

const prefix = 'lemo_opuscar';
const documents = { treatment: 'TREATMENT.md', credits: 'CREDITS.md', film: 'film/index.html',
  voice: 'voice/lines.json', music: 'music/score.md', audio_score: 'music/score.json', edit: 'EDIT.md',
  posts: 'POSTS.md', review: 'REVIEW.md', style: 'style/STYLE.md', style_changes: 'style/CHANGES.md', style_demo: 'style/DEMO.md' };

export async function createAdapter(ctx) {
  const audio = audioTools();
  const stylesRoot = join(ctx.root, 'styles');
  const knowledgeRoot = ctx.knowledgeRoot || '/opt/creative-skills/lemo-opuscar/lemo-opuscar';
  const library = JSON.parse(await readFile(join(knowledgeRoot, 'references/styles.json'), 'utf8'));
  const slug = value => {
    if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) throw new Error('风格 slug 必须为 1–64 位小写英文、数字及连字符');
    return value;
  };
  const loadStyle = async value => JSON.parse(await readFile(join(stylesRoot, slug(value), 'style.json'), 'utf8'));
  await mkdir(stylesRoot, { recursive: true });
  return createSuiteAdapter(ctx, {
    id: 'lemo-opuscar', prefix, knowledgeRoot, documents,
    prepareRender: prepareRenderInput, scripts: audio.scripts,
    extraTools: [
      tool(prefix, 'list_styles', `列出全部 ${library.length} 个固定上游风格及当前成员已确认保存的自建风格。`, object({})),
      tool(prefix, 'read_style', '读取某个完整风格、来源、变更和示例资料；自建风格按成员隔离。', object({ slug: text }, ['slug'])),
      tool(prefix, 'save_style', '用户接受风格、变更及演示文档后保存自建风格；保留本工程已完成的演示 render，可跨会话复用。',
        object({ projectId, slug: text, en: text, cn: text, basedOn: text, line: text, jobId: projectId, renderJobId: projectId,
          confirmed: { type: 'boolean', const: true } }, ['projectId', 'slug', 'en', 'cn', 'basedOn', 'line', 'jobId', 'renderJobId', 'confirmed'])),
      tool(prefix, 'capabilities', '读取托管代码制片、固定音频、模型素材与当前不可用路线。', object({})),
    ],
    handlers: {
      ...audio.handlers,
      async list_styles() {
        const own = [];
        for (const entry of await readdir(stylesRoot, { withFileTypes: true })) if (entry.isDirectory() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) own.push(await loadStyle(entry.name));
        return { library: library.map(style => ({ ...style, resource: 'references/library/styles/' + style.slug + '/STYLE.md', still: 'assets/stills/' + style.slug + '.jpg', attribution: (style.by ? style.by.name + ' · ' + style.by.url + ' · ' : '') + 'LemoLab · CC BY 4.0 · https://github.com/lemomo-ai/lemo-opuscar' })), own };
      },
      async read_style(args, api) {
        const key = slug(args.slug), style = library.find(item => item.slug === key);
        if (style) return { ...style, style: await api.readKnowledge({ resource: 'references/library/styles/' + key + '/STYLE.md' }),
          demo: await api.readKnowledge({ resource: 'references/library/styles/' + key + '/DEMO.md' }), attribution: 'assets/ATTRIBUTION.md' };
        const saved = await loadStyle(key);
        return { ...saved, style: await readFile(join(stylesRoot, key, 'STYLE.md'), 'utf8'), changes: await readFile(join(stylesRoot, key, 'CHANGES.md'), 'utf8'), demo: await readFile(join(stylesRoot, key, 'DEMO.md'), 'utf8') };
      },
      async save_style(args, api) {
        const key = slug(args.slug);
        if (args.confirmed !== true || library.some(style => style.slug === key)) throw new Error('请确认保存自建风格，且不能覆盖上游风格');
        if (!library.some(style => style.slug === args.basedOn)) throw new Error('请选择有效的技术基础风格');
        const source = {};
        for (const document of ['style', 'style_changes', 'style_demo', 'film']) {
          source[document] = await api.readDocument({ projectId: args.projectId, document });
          if (!source[document].accepted || !source[document].content?.trim()) throw new Error('先接受风格、变更、演示及代码文档，再保存');
        }
        const production = await api.getProduction({ projectId: args.projectId, jobId: args.jobId });
        const render = production.jobs.find(job => job.jobId === args.renderJobId && job.kind === 'render');
        if (render?.status !== 'completed' || !render.outputs?.length) throw new Error('自建风格需有已完成并归档的演示成片');
        if (production.inputs[source.film.path]?.revision !== source.film.revision) throw new Error('演示成片与当前已接受的代码文档不一致');
        const path = join(stylesRoot, key);
        await mkdir(path); // A new name is required; never overwrite a kept style.
        const metadata = { slug: key, en: args.en, cn: args.cn, based_on: args.basedOn, line: args.line,
          library_version: '143f387ad774525dc9abc0ff05fb5f4bfbaa5f02', created: new Date().toISOString(),
          projectId: args.projectId, productionJobId: args.jobId, renderJobId: args.renderJobId, demo: render.outputs, sourceRevisions: Object.fromEntries(Object.entries(source).map(([name, doc]) => [name, doc.revision])) };
        for (const [name, document] of [['STYLE.md', 'style'], ['CHANGES.md', 'style_changes'], ['DEMO.md', 'style_demo'], ['index.html', 'film']]) await writeFile(join(path, name), source[document].content, 'utf8');
        await writeFile(join(path, 'style.json'), JSON.stringify(metadata, null, 2));
        return metadata;
      },
      capabilities: () => ({ codeFilm: true, isolatedRender: true, trustedAudio: ['synthesize', 'trim', 'mix', 'concat'],
        managedGeneration: ['image', 'video', 'tts', 'music'], unavailable: ['上游本地采样库和语音模型下载', '外部生成网站及个人 API Key', '产品网页录屏', '任意 shell、build.sh 或成员脚本执行'] }),
    },
  });
}
