import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSuiteAdapter } from '../aigc-shared/adapter.mjs';

const id = 'shuohao-skills';
const prefix = 'shuohao_skills';
const knowledgeRoot = '/opt/creative-skills/' + id;
const text = { type: 'string', minLength: 1 };
const enumString = (values) => ({ type: 'string', enum: values });
const schema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties: { projectId: text, ...properties }, required: ['projectId', ...required] });
const language = { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$' };
const documents = {
  source: 'source.txt', outline: 'outline.json', outline_assets: 'outline-assets.json', cast: 'cast.json', art: 'art.json', script: 'script.json', staging: 'staging.json', storyboard: 'storyboard.json',
  cast_roster: 'cast-work/roster-{episode}.json', cast_card: 'cast-work/card-{episode}.json', cast_merges: 'cast-work/merges.json', cast_merged: 'cast-work/merged.json', cast_summary: 'cast-work/summary.txt', cast_ui: 'cast-work/ui.json',
  outline_report: 'outline.html', cast_report: 'cast.html', art_report: 'art.html', script_report: 'script.html', staging_report: 'staging.html', storyboard_report: 'storyboard.html', report: 'report.html', blocking: 'blocking.txt',
  character_intakes: 'character-refs/intakes.json', character_assets: 'character-refs/assets.json', character_report: 'character-refs.html',
};
const file = (api, args, key) => join(api.projectPath(args.projectId), documents[key]);
const context = (api, args, keys) => keys.flatMap((key) => ['--' + key, file(api, args, key)]);
const withLang = (args) => args.language ? ['--lang', args.language] : [];
const range = (args) => args.episodes ? ['--eps', args.episodes] : [];
const nativeSchema = (operations, extras = {}) => schema({ operation: enumString(operations), language, ...extras }, ['operation']);
async function validateExportSegmentIds(args, api) {
  const document = await api.readDocument({ projectId: args.projectId, document: 'storyboard' });
  const board = JSON.parse(document.content);
  for (const episode of board?.episodes ?? []) {
    for (const [index, segment] of (episode?.segments ?? []).entries()) {
      const expected = `E${String(episode.ep).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`;
      if (typeof segment?.id !== 'string' || !/^E\d{2,}-\d{2,}$/.test(segment.id) || segment.id !== expected) {
        throw new Error(`分镜导出段号必须符合原生顺序 ${expected}，不能包含路径分隔符或 ..`);
      }
    }
  }
}
const scripts = {
  outline: { file: 'skills/novel-outline/scripts/novel-outline.mjs', runtime: 'node', hidden: true,
    inputSchema: nativeSchema(['chunk', 'validate', 'checkup', 'assets', 'render'], { stage: enumString(['skeleton', 'beats', 'full']), perVolume: { type: 'integer', minimum: 1 } }),
    async args(a, api) {
      if (a.operation === 'chunk') return ['chunk', file(api, a, 'source'), join(api.projectPath(a.projectId), 'outline-work'), '--per-volume', String(a.perVolume || 15)];
      return [a.operation, file(api, a, 'outline'), ...(a.operation === 'validate' ? ['--stage', a.stage || 'full'] : []), ...(a.operation === 'render' ? ['--html', ...withLang(a)] : [])];
    } },
  cast: { file: 'skills/novel-characters/scripts/novel-characters.mjs', runtime: 'node', hidden: true,
    inputSchema: nativeSchema(['seed', 'chunk', 'merge', 'assemble', 'validate', 'render'], { sourceName: text, applyMerges: { type: 'boolean' } }),
    async args(a, api) {
      const work = join(api.projectPath(a.projectId), 'cast-work');
      if (a.operation === 'seed') return ['seed', file(api, a, 'outline')];
      if (a.operation === 'chunk') return ['chunk', file(api, a, 'source'), work];
      if (a.operation === 'merge') return ['merge', work, ...(a.applyMerges ? ['--apply', file(api, a, 'cast_merges')] : [])];
      if (a.operation === 'assemble') {
        if (!a.sourceName) throw new Error('assemble需要原著名称sourceName');
        return ['assemble', work, '--source', a.sourceName, ...withLang(a)];
      }
      return [a.operation, file(api, a, 'cast'), ...(a.operation === 'validate' ? [file(api, a, 'source')] : ['--html', '--images', join(api.projectPath(a.projectId), 'images')]), ...withLang(a)];
    } },
  art: { file: 'skills/novel-art/scripts/novel-art.mjs', runtime: 'node', hidden: true, inputSchema: nativeSchema(['seed', 'validate', 'checkup', 'render']),
    args: (a, api) => a.operation === 'seed' ? ['seed', file(api, a, 'outline')] : [a.operation, file(api, a, 'art'), '--cast', file(api, a, 'cast'), ...(a.operation === 'render' ? ['--html', '--images', join(api.projectPath(a.projectId), 'images'), ...withLang(a)] : [])] },
  script: { file: 'skills/novel-script/scripts/novel-script.mjs', runtime: 'node', hidden: true,
    inputSchema: nativeSchema(['seed', 'validate', 'checkup', 'render'], { episodes: { type: 'string', pattern: '^\\d+(?:-\\d+)?$' } }),
    args: (a, api) => a.operation === 'seed' ? ['seed', file(api, a, 'outline'), ...range(a)] : [a.operation, file(api, a, 'script'), ...context(api, a, ['outline', 'art', 'cast']), ...(a.operation === 'render' ? ['--html', ...withLang(a)] : [])] },
  staging: { file: 'skills/novel-staging/scripts/novel-staging.mjs', runtime: 'node', hidden: true,
    inputSchema: nativeSchema(['seed', 'validate', 'checkup', 'blocking', 'render'], { episodes: { type: 'string', pattern: '^\\d+(?:-\\d+)?$' } }),
    args: (a, api) => a.operation === 'seed' ? ['seed', file(api, a, 'script'), ...context(api, a, ['art', 'outline']), ...range(a)] : [a.operation, file(api, a, 'staging'), ...(a.operation === 'validate' || a.operation === 'checkup' ? context(api, a, ['script', 'art']) : []), ...(a.operation === 'render' ? ['--html', '--images', join(api.projectPath(a.projectId), 'images')] : []), ...withLang(a)] },
  storyboard: { file: 'skills/novel-storyboard/scripts/novel-storyboard.mjs', runtime: 'node', hidden: true,
    inputSchema: nativeSchema(['seed', 'validate', 'checkup', 'render', 'export'], { episodes: { type: 'string', pattern: '^\\d+(?:-\\d+)?$' }, aspect: enumString(['16:9', '9:16']), protocol: enumString(['h3', 'seedance']) }),
    async args(a, api) {
      if (a.operation === 'seed') return ['seed', file(api, a, 'script'), ...range(a), '--aspect', a.aspect || '16:9'];
      const base = [a.operation, file(api, a, 'storyboard'), ...context(api, a, ['script', 'outline', 'cast', 'art'])];
      if (['validate', 'checkup'].includes(a.operation)) return [...base, '--no-log'];
      if (a.operation === 'export') {
        await validateExportSegmentIds(a, api);
        return [...base, '--protocol', a.protocol || 'h3', '--out', join(api.projectPath(a.projectId), 'export'), '--frames', join(api.projectPath(a.projectId), 'frames'), '--images', join(api.projectPath(a.projectId), 'images')];
      }
      return [...base, '--html', '--frames', join(api.projectPath(a.projectId), 'frames'), '--images', join(api.projectPath(a.projectId), 'images'), ...withLang(a)];
    } },
  build_report: { file: 'scripts/report.mjs', runtime: 'node', description: '运行上游固定报告组装器，合并当前项目原生报告。', outputDocuments: ['report'],
    inputSchema: schema({ language, sections: { type: 'array', minItems: 1, items: enumString(['outline', 'cast', 'art', 'script', 'storyboard']) } }, ['sections']),
    args: (a, api) => ['--out', file(api, a, 'report'), ...withLang(a), ...context(api, a, a.sections)] },
  intake_template: { file: 'skills/character-refs/scripts/character-refs.mjs', runtime: 'node', description: '读取原生角色输入模板；不会配置或调用本机模型。', inputSchema: schema(), args: () => ['intake-template'] },
  character_looks: { file: 'skills/character-refs/scripts/character-refs.mjs', runtime: 'node', description: '列出原生角色画风预设。', inputSchema: schema(), args: () => ['looks'] },
};
async function modules(api) {
  const root = join(api.knowledgeRoot, 'skills/character-refs/scripts');
  const [core, looks, cli] = await Promise.all(['core.mjs', 'looks.mjs', 'character-refs.mjs'].map((name) => import(pathToFileURL(join(root, name)).href)));
  return { core, looks, cli };
}
async function jsonDocument(api, projectId, document, fallback) {
  const saved = await api.readDocument({ projectId, document });
  return { saved, data: saved.content ? JSON.parse(saved.content) : fallback };
}
const saveJson = (api, projectId, document, data, accepted = false) => api.writeDocument({ projectId, document, content: JSON.stringify(data, null, 2) + '\n', accepted });
const characterId = { type: 'string', pattern: '^[A-Za-z0-9_-]+$' };
const currentView = (outfit, view) => outfit.views?.[view]?.versions.find((item) => item.v === outfit.views[view].current);
function staleView(asset, outfitId, view) {
  const outfit = asset.outfits[outfitId], current = currentView(outfit, view);
  if (!current) return [];
  const reasons = [];
  if (current.layersRevision !== asset.layersRevision) reasons.push('角色输入版本已改变');
  if (current.lookRevision !== outfit.lookRevision) reasons.push('整剧画风版本已改变');
  for (const reference of current.refs || []) {
    const latest = currentView(outfit, reference.view);
    if (!latest || latest.revision !== reference.revision) reasons.push(reference.view + ' 参考图版本已改变');
  }
  return reasons;
}
function anchorState(asset, outfitId) {
  const anchor = currentView(asset.outfits[outfitId], 'front-full');
  if (!anchor) return { ok: false, why: '还没有锚点（正面全身），先出第一档' };
  if (!anchor.confirmed) return { ok: false, why: '锚点还没确认，查看图像后明确确认当前版本' };
  const stale = staleView(asset, outfitId, 'front-full');
  return stale.length ? { ok: false, why: '锚点已过期：' + stale.join('；') } : { ok: true };
}
function managedReferences(asset, outfitId, prompt) {
  const refs = [], notes = [];
  for (const view of prompt.refs) {
    const current = currentView(asset.outfits[outfitId], view);
    if (!current || !current.assetId || staleView(asset, outfitId, view).length) {
      if (view === 'front-full') throw new Error('锚点不可用');
      notes.push(view + ' 缺失或已过期，这张只挂锚点');
    } else refs.push({ view, v: current.v, revision: current.revision, assetId: current.assetId, file: current.file });
  }
  return { refs, notes };
}

async function synchronizeCharacters(args, api) {
  await api.getProduction({ projectId: args.projectId });
  const project = await api.loadProject(args.projectId);
  const { data: store } = await jsonDocument(api, args.projectId, 'character_assets', { lookRevision: 1, characters: {} });
  let changed = false;
  for (const production of Object.values(project.productions)) for (const job of production.jobs) {
    if (!job.characterId || job.shuohaoRecorded || job.status !== 'completed') continue;
    const asset = store.characters[job.characterId];
    if (!asset) continue;
    const outfit = asset.outfits[job.outfitId];
    const output = job.outputs?.[0];
    if (!output?.assetId || !output.projectPath) continue;
    const slot = outfit.views[job.view] ||= { current: 0, versions: [] };
    const v = Math.max(0, ...slot.versions.map((version) => version.v)) + 1;
    const version = { v, revision: v, id: `${asset.name}/${job.outfitId}/${job.view}/v${v}`, file: output.projectPath,
      assetId: output.assetId, platformTaskId: job.platformTaskId, model: job.model, prompt: job.prompt,
      refs: job.characterRefs, layersRevision: job.layersRevision, lookRevision: job.lookRevision, createdAt: new Date().toISOString(),
      inspection: 'not_run', gates: [], ...(job.view === 'front-full' ? { confirmed: false } : {}) };
    slot.versions.push(version); slot.current = v; job.shuohaoRecorded = { v }; changed = true;
  }
  if (changed) {
    await api.saveProject(project);
    await saveJson(api, args.projectId, 'character_assets', store, true);
  }
  return { project: await api.loadProject(args.projectId), store };
}
async function requireCharacterJobs(args, api, production) {
  const { core } = await modules(api);
  const { data: store } = await jsonDocument(api, args.projectId, 'character_assets', { characters: {} });
  for (const job of production?.jobs || args.jobs) {
    const asset = store.characters[job.characterId];
    const outfit = asset?.outfits[job.outfitId];
    if (job.kind !== 'image' || !asset || !outfit || !asset.intakeConfirmed || job.sourceDocument !== 'character_assets' || !core.allViews(outfit)[job.view]) throw new Error('角色生成须由prepare_character_views编译已确认输入，不能绕过原输入/锚点确认。');
    if (job.layersRevision !== asset.layersRevision || job.lookRevision !== outfit.lookRevision) throw new Error('角色输入或画风已改变，请重新准备并确认当前图像任务');
    if (job.view !== core.ANCHOR) {
      const gate = anchorState(asset, job.outfitId);
      if (!gate.ok) throw new Error(gate.why);
      for (const ref of job.characterRefs) if (core.current(outfit, ref.view)?.revision !== ref.revision) throw new Error('角色参考版本已改变，请重新准备任务');
    }
  }
}
const pipelineTools = Object.entries(scripts).filter(([, spec]) => spec.hidden).map(([key, spec]) => ({ name: prefix + '_' + key,
  description: `执行原生novel-${key === 'cast' ? 'characters' : key}的固定动作；输入、上下游引用与输出均在当前项目，不能指定命令或脚本路径。`, inputSchema: spec.inputSchema }));

export async function createAdapter(ctx) {
  const handlers = {};
  for (const key of ['outline', 'cast', 'art', 'script', 'staging', 'storyboard']) handlers[key] = async (args, api) => {
    const output = await api.runScript(key, args);
    if (output.isError) return output;
    let document;
    if (args.operation === 'render') document = key + '_report';
    else if (args.operation === 'seed' || args.operation === 'assemble') document = key;
    else if (key === 'cast' && args.operation === 'merge') document = 'cast_merged';
    else if (key === 'outline' && args.operation === 'assets') document = 'outline_assets';
    else if (key === 'staging' && args.operation === 'blocking') document = 'blocking';
    if (document) return { ...output, document: await api.writeDocument({ projectId: args.projectId, document,
      content: output.result === undefined ? output.stdout : JSON.stringify(output.result, null, 2) + '\n' }) };
    return output;
  };
  Object.assign(handlers, {
    async write_document(args, api) {
      if (['character_intakes', 'character_assets'].includes(args.document)) throw new Error('角色输入与版本文档只由set_character_intake、确认及任务恢复操作保存，不能直接改写以绕过确认。');
      return api.writeDocument(args);
    },
    async read_source_chunk(args, api) {
      const name = args.kind === 'outline' ? 'outline-work/vol-' : 'cast-work/chunk-';
      return { kind: args.kind, index: args.index, content: await readFile(join(api.projectPath(args.projectId), name + String(args.index).padStart(2, '0') + '.txt'), 'utf8') };
    },
    async set_character_intake(args, api) {
      const { core } = await modules(api);
      const intake = JSON.parse(args.intakeJson);
      const problems = core.intakeProblems(intake);
      if (problems.length) throw new Error(problems.join('\n'));
      const { data: intakes } = await jsonDocument(api, args.projectId, 'character_intakes', {});
      const revision = (intakes[args.characterId]?.revision || 0) + 1;
      intakes[args.characterId] = { revision, confirmed: false, intake };
      await saveJson(api, args.projectId, 'character_intakes', intakes);
      return { characterId: args.characterId, revision, confirmationTable: core.confirmTable(intake),
        note: '向用户原样展示确认表，推断与默认标记必须保留。用户确认此revision后调用confirm_character_intake。' };
    },
    async confirm_character_intake(args, api) {
      const { core, looks } = await modules(api);
      const { data: intakes } = await jsonDocument(api, args.projectId, 'character_intakes', {});
      const entry = intakes[args.characterId];
      if (args.confirmed !== true || !entry || entry.revision !== args.revision) throw new Error('只能确认已展示的当前角色输入版本');
      const { data: store } = await jsonDocument(api, args.projectId, 'character_assets', { look: looks.lookSnapshot(looks.findLook('anime')), lookRevision: 1, characters: {} });
      const previous = store.characters[args.characterId];
      if (entry.confirmed && previous?.layersRevision === entry.revision) return { characterId: args.characterId, asset: previous };
      const asset = core.assetFromIntake(entry.intake, store.look);
      const oid = Object.keys(asset.outfits)[0];
      asset.layersRevision = entry.revision; asset.intakeConfirmed = true;
      asset.outfits[oid].lookRevision = store.lookRevision;
      if (previous?.outfits[oid]) asset.outfits[oid].views = previous.outfits[oid].views;
      store.characters[args.characterId] = asset; entry.confirmed = true;
      await saveJson(api, args.projectId, 'character_intakes', intakes, true);
      await saveJson(api, args.projectId, 'character_assets', store, true);
      return { characterId: args.characterId, asset, note: '输入已确认；先准备正面全身锚点，图像任务仍需单独展示并确认。' };
    },
    async set_character_style(args, api) {
      if (args.confirmed !== true) throw new Error('先确认当前整剧画风');
      const { looks } = await modules(api);
      const look = args.preset === 'custom' ? JSON.parse(args.customLookJson || '{}') : looks.lookSnapshot(looks.findLook(args.preset));
      const problems = looks.lookProblems(look);
      if (problems.length) throw new Error(problems.join('\n'));
      const { data: store } = await jsonDocument(api, args.projectId, 'character_assets', { lookRevision: 0, characters: {} });
      store.look = look; store.lookRevision += 1;
      for (const asset of Object.values(store.characters)) for (const outfit of Object.values(asset.outfits)) { outfit.look = structuredClone(look); outfit.lookRevision = store.lookRevision; }
      await saveJson(api, args.projectId, 'character_assets', store, true);
      return { look, revision: store.lookRevision, note: '整剧角色统一换画风，旧图保留并按lookRevision标为过期；须从锚点重新准备。' };
    },
    async prepare_character_views(args, api) {
      const { core } = await modules(api);
      const { store } = await synchronizeCharacters(args, api);
      const { data: intakes } = await jsonDocument(api, args.projectId, 'character_intakes', {});
      const asset = store.characters[args.characterId];
      if (!asset || !intakes[args.characterId]?.confirmed || asset.layersRevision !== intakes[args.characterId].revision) throw new Error('先展示并确认当前角色输入');
      const outfitId = Object.keys(asset.outfits)[0];
      const outfit = asset.outfits[outfitId];
      const all = core.allViews(outfit);
      let views = args.views?.length ? args.views : args.tier ? core.viewsOfTier(outfit, args.tier) : Object.keys(all).filter((view) => all[view].tier <= 2 && (!currentView(outfit, view) || staleView(asset, outfitId, view).length));
      if (!args.views?.length && views.includes(core.ANCHOR)) views = [core.ANCHOR];
      if (!views.length) return { status: 'ready', message: '所选档位当前没有待生成视图。', asset };
      if (views.some((view) => !all[view])) throw new Error('视图不属于该角色的原生视图/细节槽位');
      if (views.includes(core.ANCHOR) && views.length > 1) throw new Error('锚点须单独出图并确认后，才能准备派生视图');
      if (views.some((view) => all[view].tier > 2) && !args.reason) throw new Error('升档需记录本次用途reason');
      const jobs = views.map((view) => {
        if (view !== core.ANCHOR) { const gate = anchorState(asset, outfitId); if (!gate.ok) throw new Error(gate.why); }
        const prompt = core.buildPrompt(asset, outfitId, view);
        const { refs, notes } = managedReferences(asset, outfitId, prompt);
        return { label: `${asset.name} / ${all[view].label}`, kind: 'image', model: args.model, sourceDocument: 'character_assets', sourceEntry: args.characterId,
          prompt: prompt.text + '\nNegative: ' + prompt.negative, referenceAssetIds: refs.map((ref) => ref.assetId),
          parameters: { aspect_ratio: prompt.ratio, n: 1, ...(args.seed === undefined ? {} : { seed: args.seed }) },
          characterId: args.characterId, outfitId, view, characterRefs: refs.map(({ view, v, revision, assetId }) => ({ view, v, revision, assetId })),
          layersRevision: asset.layersRevision, lookRevision: outfit.lookRevision, notes, ...(args.reason ? { reason: args.reason } : {}) };
      });
      return api.prepareProduction({ projectId: args.projectId, jobs });
    },
    async confirm_character_anchor(args, api) {
      const { core } = await modules(api);
      const { store } = await synchronizeCharacters(args, api);
      const asset = store.characters[args.characterId];
      if (!asset || args.confirmed !== true) throw new Error('先查看当前锚点后明确确认');
      const oid = Object.keys(asset.outfits)[0];
      const anchor = core.current(asset.outfits[oid], core.ANCHOR);
      if (!anchor || anchor.v !== args.version || staleView(asset, oid, core.ANCHOR).length) throw new Error('只能确认当前未过期的锚点版本');
      anchor.confirmed = true; anchor.confirmedAt = new Date().toISOString();
      await saveJson(api, args.projectId, 'character_assets', store, true);
      return { characterId: args.characterId, anchor, note: '锚点已确认，可以准备大头照、侧面与背面。' };
    },
    async get_character(args, api) {
      const { core } = await modules(api);
      const { store, project } = await synchronizeCharacters(args, api);
      const asset = store.characters[args.characterId];
      if (!asset) throw new Error('当前工程没有此角色');
      const oid = Object.keys(asset.outfits)[0];
      const { data: intakes } = await jsonDocument(api, args.projectId, 'character_intakes', {});
      return { characterId: args.characterId, intake: intakes[args.characterId], asset, views: Object.keys(core.allViews(asset.outfits[oid])).map((view) => ({ view, current: currentView(asset.outfits[oid], view), stale: staleView(asset, oid, view) })),
        productions: Object.values(project.productions).filter((production) => production.jobs.some((job) => job.characterId === args.characterId)) };
    },
    async get_production(args, api) {
      const { project } = await synchronizeCharacters(args, api);
      return args.jobId ? project.productions[args.jobId] : { projectId: args.projectId, currentJobId: project.currentProductionId, productions: Object.values(project.productions) };
    },
    async render_character_report(args, api) {
      const { cli } = await modules(api);
      const { store } = await synchronizeCharacters(args, api);
      const items = Object.values(store.characters).map((asset) => ({ asset, assetDir: api.projectPath(args.projectId) }));
      if (!items.length) throw new Error('当前工程没有已确认的角色');
      return api.writeDocument({ projectId: args.projectId, document: 'character_report', content: cli.renderHtml(items, api.projectPath(args.projectId), { lang: args.language || null }) });
    },
  });
  const extraTools = [
    ...pipelineTools,
    { name: prefix + '_read_source_chunk', description: '读取固定小说切块，kind区分大纲卷与角色扫描块，index从0起；不接受路径。', inputSchema: schema({ kind: enumString(['outline', 'cast']), index: { type: 'integer', minimum: 0, maximum: 999 } }, ['kind', 'index']) },
    { name: prefix + '_set_character_intake', description: '按原生结构保存角色输入，返回需原样展示给用户的确认表。', inputSchema: schema({ characterId, intakeJson: text }, ['characterId', 'intakeJson']) },
    { name: prefix + '_confirm_character_intake', description: '仅保存用户已看过确认表后明确接受的当前角色输入revision。', inputSchema: schema({ characterId, revision: { type: 'integer', minimum: 1 }, confirmed: { type: 'boolean', const: true } }, ['characterId', 'revision', 'confirmed']) },
    { name: prefix + '_set_character_style', description: '统一整剧角色画风；更改后旧图保留并按revision过期。', inputSchema: schema({ preset: enumString(['anime', 'realistic', 'custom']), customLookJson: text, confirmed: { type: 'boolean', const: true } }, ['preset', 'confirmed']) },
    { name: prefix + '_prepare_character_views', description: '由原生角色层与锚点编译准确图像任务；不提交。首次只准备锚点，确认锚点后才可准备派生图，默认第二档。', inputSchema: schema({ characterId, tier: { type: 'integer', enum: [1, 2, 3, 4] }, views: { type: 'array', minItems: 1, items: text }, reason: text, model: text, seed: { type: 'integer' } }, ['characterId']) },
    { name: prefix + '_confirm_character_anchor', description: '用户查看图像后确认当前未过期锚点版本；不自动放行。', inputSchema: schema({ characterId, version: { type: 'integer', minimum: 1 }, confirmed: { type: 'boolean', const: true } }, ['characterId', 'version', 'confirmed']) },
    { name: prefix + '_get_character', description: '沿原任务绑定恢复角色图，展示当前/过期版本、锚点确认及本次逐项失败。', inputSchema: schema({ characterId }, ['characterId']) },
    { name: prefix + '_render_character_report', description: '用上游原报告渲染器生成当前项目角色设定图报告。', inputSchema: schema({ language }) },
  ];
  return createSuiteAdapter(ctx, { id, prefix, knowledgeRoot, documents, scripts, extraTools, handlers, productionKinds: ['image'],
    knowledgeFiles: ['README.md', 'README.zh.md', 'README.en.md'],
    createProject: async (_args, api) => { await mkdir(join(api.projectPath(api.project.projectId), 'cast-work'), { recursive: true }); },
    beforePrepareProduction: (args, api) => requireCharacterJobs(args, api),
    beforeExecuteProduction: (args, api) => requireCharacterJobs(args, api, api.production),
  });
}
