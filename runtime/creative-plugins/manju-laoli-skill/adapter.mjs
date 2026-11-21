import { join } from 'node:path';
import { createSuiteAdapter } from '../aigc-shared/adapter.mjs';

const id = 'manju-laoli-skill';
const prefix = 'manju_laoli';
const knowledgeRoot = '/opt/creative-skills/' + id;
const text = { type: 'string', minLength: 1 };
const choice = (values) => ({ type: 'string', enum: values });
const schema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties: { projectId: text, ...properties }, required: ['projectId', ...required] });
const documents = {
  source: '00_source/source.txt', source_manifest: '00_source/SOURCE_MANIFEST.json', pipeline_state: 'SCRIPT_PIPELINE_STATE.json', project_manifest: 'PROJECT_MANIFEST.md',
  state: 'project_state.json', story_bible: '02_STORY_BIBLE.md', character_evidence: 'CHARACTER_EVIDENCE_LEDGER.json', episode_plan: 'EPISODE_PLAN.json',
  script: '04_SCRIPT.md', episode_script: 'episodes/EP{episode}.md', continuity: 'CONTINUITY_LEDGER.json', dialogue_ledger: 'SOURCE_DIALOGUE_LEDGER.md',
  world: 'WORLD_ANCHOR.md', performance: 'CHARACTER_PERFORMANCE.md', assets: 'assets-prompts.md', storyboard: 'P3_STORYBOARD.md', clean_grid: 'P3CLEAN_GRID.md',
  previs: 'P45_PREVIS.md', editing_plan: 'EDITING_PLAN.json', feed: 'P4_FEED.md', full_delivery: 'DELIVERY.md', qc: 'QC_REPORT.md',
  project_json: 'project.json', bundle_assets: 'bundle/assets-prompts.md', bundle_board: 'bundle/P3CLEAN_GRID.md',
  board: 'board.html', subtitles: 'subtitles.srt', timeline: 'timeline.csv', board_data: 'board-data.json', beats: 'emotion_beats.json',
};
const path = (api, args, key) => join(api.projectPath(args.projectId), documents[key]);
async function locksFor(args, api) {
  const document = await api.readDocument({ projectId: args.projectId, document: 'state' });
  const state = JSON.parse(document.content || '{}');
  const locks = state.locks || {};
  const project = await api.loadProject(args.projectId);
  if (['track', 'source', 'model', 'aspect', 'delivery', 'seam', 'style_card', 'asset_mode', 'combat_tier'].some((key) => !locks[key] || locks[key] !== project.manjuLocks?.[key])) {
    throw new Error('先向用户逐项展示六道前置锁、画风候选卡及动作档位，并用set_locks保存明确选择；不得使用默认值跳锁。');
  }
  return locks;
}
const native = (file, description, inputSchema, args, outputDocuments) => ({ file, runtime: 'python3', description, inputSchema, args, ...(outputDocuments ? { outputDocuments } : {}) });
const scripts = {
  style_candidates: native('short-drama-director/scripts/style-lock-ladder.py', '按原递进画风引擎输出候选卡；base 仅在用户明确选择影像基底后传入，不自动冻结。', schema({ genre: text, top: { type: 'integer', minimum: 1, maximum: 4 }, base: choice(['真人', '2D', '3D', '水墨']) }, ['genre']), (a) => ['--genre', a.genre, '--top', String(a.top || 4), ...(a.base ? ['--base', a.base] : [])]),
  style_recommendations: native('short-drama-director/scripts/style-lock-recommend.py', '按原题材路由推荐画风候选；推荐不能代替用户选择。', schema({ genre: text, top: { type: 'integer', minimum: 1, maximum: 4 } }, ['genre']), (a) => ['--genre', a.genre, '--top', String(a.top || 4)]),
  read_stage_context: native('short-drama-director/scripts/slice_context.py', '按已锁参数读取对应阶段权威原文，不以摘要替代原文。', schema({ stage: choice(['P0', 'P1', 'P2', 'P3', 'P4', 'P5']), page: { type: 'integer', minimum: 1 }, lines: { type: 'integer', minimum: 1 }, previs: { type: 'boolean' } }, ['stage']), async (a, api) => {
    const l = await locksFor(a, api);
    return ['--stage', a.stage, '--track', l.track, '--source', l.source, '--model', l.model, '--mode', l.asset_mode, '--combat', l.combat_tier, '--page', String(a.page || 1), '--lines', String(a.lines || 40), ...(a.previs ? ['--previs'] : [])];
  }),
  compile_feed: native('short-drama-director/scripts/compile_feed.py', '从已锁project_state.json编译 Seedance 七段式投喂稿；H3 原生稿需按其规则手写并交 validate_feed。', schema(), async (a, api) => { await locksFor(a, api); return ['--state', path(api, a, 'state'), '--out', path(api, a, 'feed')]; }, ['feed']),
  build_board: native('short-drama-director/scripts/build_board_lite.py', '从本项目DELIVERY.md编译原离线分镜看板，可按需导出字幕/时间线。', schema({ subtitles: { type: 'boolean' }, timeline: { type: 'boolean' }, data: { type: 'boolean' } }), async (a, api) => {
    await locksFor(a, api);
    return [path(api, a, 'full_delivery'), '--out', path(api, a, 'board'), ...(a.subtitles ? ['--export-srt', path(api, a, 'subtitles')] : []), ...(a.timeline ? ['--export-csv', path(api, a, 'timeline')] : []), ...(a.data ? ['--export-json', path(api, a, 'board_data')] : [])];
  }, ['board', 'subtitles', 'timeline', 'board_data']),
  validate_feed: native('short-drama-director/scripts/validate_prompt.py', '运行原投喂稿规则并读取已锁模型、画风与状态台账，逐段返回原问题。', schema(), async (a, api) => {
    const l = await locksFor(a, api);
    return [path(api, a, 'feed'), '--model', l.model, '--track', l.track, '--style-source', l.style_card, '--aspect', l.aspect,
      '--combat', l.combat_tier === 'none' ? 'auto' : 'on', '--plugin', ({ R1: 'real', R2: 'combat', R3: 'xuanhuan' })[l.combat_tier] || 'auto',
      '--state', path(api, a, 'state'), '--by-segment', '--delivery', 'feed-only', '--json'];
  }),
  check_feed_gates: native('sd-feed-engine/scripts/gate_check.py', '运行 Seedance 投喂单元闸门；H3 稿使用 validate_feed 的 H1–H12。', schema({ assetCount: { type: 'integer', minimum: 0 }, tolerance: { type: 'number', minimum: 0 } }, ['assetCount']), async (a, api) => {
    const l = await locksFor(a, api);
    return [path(api, a, 'feed'), '--model', l.model, '--track', l.track, '--aspect', l.aspect, '--style-source', l.style_card,
      '--combat', l.combat_tier === 'none' ? 'auto' : 'on', '--plugin', ({ R1: 'real', R2: 'combat', R3: 'xuanhuan' })[l.combat_tier] || 'auto',
      '--state', path(api, a, 'state'), '--assets', String(a.assetCount), '--mode', l.asset_mode, '--tol', String(a.tolerance ?? 0.8)];
  }),
  compare_script_feed: native('sd-feed-engine/scripts/script_feed_diff.py', '用原台词对照脚本比较项目剧本与投喂稿，角色名必须来自本项目。', schema({ names: { type: 'array', minItems: 1, items: text } }, ['names']), async (a, api) => { await locksFor(a, api); return ['--script', path(api, a, 'script'), '--feed', path(api, a, 'feed'), '--names', a.names.join(',')]; }),
  check_asset_blocks: native('short-drama-director/scripts/check_asset_blocks.py', '运行原资产块规则，返回原错误和告警。', schema({ minBlocks: { type: 'integer', minimum: 1 } }), async (a, api) => { await locksFor(a, api); return [path(api, a, 'assets'), '--min-blocks', String(a.minBlocks || 3), '--json']; }),
  check_previs: native('sd-storyboard-engine/scripts/check_p45.py', '运行原P4.5预演故事板规则，保持P3与P4.5边界。', schema({ segments: { type: 'integer', minimum: 1 } }), async (a, api) => { const l = await locksFor(a, api); return [path(api, a, 'previs'), '--json', ...(a.segments ? ['--segments', String(a.segments)] : []), ...(l.asset_mode === 'M2' ? ['--m2'] : [])]; }),
  validate_segment_map: native('sd-qc-engine/scripts/validate_seedance_segment_map.py', '运行原Seedance分段映射规则。', schema(), async (a, api) => { await locksFor(a, api); return [path(api, a, 'editing_plan')]; }),
  audit_delivery: native('short-drama-director/scripts/audit_contract.py', '按原交付契约核对本项目DELIVERY.md，不审查或修改上游套件。', schema({ mode: choice(['full', 'board-lite']) }, ['mode']), async (a, api) => { const l = await locksFor(a, api); return [path(api, a, 'full_delivery'), '--mode', a.mode, '--director', l.style_card]; }),
  validate_project_bundle: native('short-drama-director/scripts/project_bundle.py', '运行原JSON项目结构规则，语义状态仍为needs_review。', schema(), async (a, api) => { await locksFor(a, api); return ['validate', path(api, a, 'project_json')]; }),
  export_project_bundle: native('short-drama-director/scripts/project_bundle.py', '按原JSON源导出P3同源包；原规则拒绝覆盖已有bundle目录。', schema(), async (a, api) => { await locksFor(a, api); return ['export', path(api, a, 'project_json'), '--output', join(api.projectPath(a.projectId), 'bundle')]; }, ['bundle_assets', 'bundle_board']),
  emotion_curve: native('short-drama-director/scripts/generate_emotion_curve.py', '从当前项目节拍数据生成中文情绪曲线PNG。', schema(), async (a, api) => { await locksFor(a, api); return ['--input', path(api, a, 'beats'), '--out', join(api.projectPath(a.projectId), 'emotion_beat_curve.png')]; }),
};
const lockSchema = schema({
  track: choice(['1', '2', '3', '4']), source: choice(['1', '2', '3', '4']), model: choice(['2.5', '2.0', 'h3']), aspect: choice(['16:9', '9:16', '21:9']),
  delivery: choice(['1', '2', '3']), seam: choice(['1', '2', '3', '4']), styleCard: text, assetMode: choice(['M0', 'M1', 'M2']), combatTier: choice(['none', 'R1', 'R2', 'R3']), confirmed: { type: 'boolean', const: true },
}, ['track', 'source', 'model', 'aspect', 'delivery', 'seam', 'styleCard', 'assetMode', 'combatTier', 'confirmed']);

export async function createAdapter(ctx) {
  return createSuiteAdapter(ctx, {
    id, prefix, knowledgeRoot, documents, scripts, productionKinds: [], knowledgeFiles: ['README.md', 'short-drama-director/README.md'],
    extraTools: [
      { name: prefix + '_set_locks', description: '仅在用户逐项明确选择前置锁、画风卡和动作档位后保存；不得推断或使用样例默认值。', inputSchema: lockSchema },
      { name: prefix + '_register_source', description: '按来源ID、范围与处理状态登记本项目材料，不计算来源摘要。', inputSchema: schema({
        sourceId: text, identifier: text, chapters: text, range: text,
        readStatus: choice(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE']), extractionStatus: choice(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE']), mergeStatus: choice(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE']),
      }, ['sourceId', 'identifier', 'chapters', 'range', 'readStatus', 'extractionStatus', 'mergeStatus']) },
    ],
    handlers: {
      async set_locks(args, api) {
        if (args.confirmed !== true) throw new Error('必须保存用户明确选择的锁');
        const old = await api.readDocument({ projectId: args.projectId, document: 'state' });
        const state = JSON.parse(old.content || '{}');
        state.schema_version ||= '7.4.23';
        state.locks = { track: args.track, source: args.source, model: args.model, aspect: args.aspect, delivery: args.delivery, seam: args.seam, style_card: args.styleCard, asset_mode: args.assetMode, combat_tier: args.combatTier };
        const saved = await api.writeDocument({ projectId: args.projectId, document: 'state', content: JSON.stringify(state, null, 2), accepted: true });
        const project = await api.loadProject(args.projectId);
        project.manjuLocks = { ...state.locks };
        await api.saveProject(project);
        return saved;
      },
      async register_source(args, api) {
        const old = await api.readDocument({ projectId: args.projectId, document: 'source_manifest' });
        const manifest = JSON.parse(old.content || '{"sources":[],"unresolved_ranges":[]}');
        const entry = { source_id: args.sourceId, identifier: args.identifier, chapters: args.chapters, range: args.range, read_status: args.readStatus, extraction_status: args.extractionStatus, merge_status: args.mergeStatus };
        const previous = manifest.sources.findIndex((source) => source.source_id === args.sourceId);
        if (previous < 0) manifest.sources.push(entry); else manifest.sources[previous] = entry;
        const document = await api.writeDocument({ projectId: args.projectId, document: 'source_manifest', content: JSON.stringify(manifest, null, 2) });
        return { ...document, note: '来源覆盖仍需依原文完成P1提取、P2合并和范围消歧；状态登记不代表已读取。' };
      },
      async emotion_curve(args, api) {
        const output = await api.runScript('emotion_curve', args);
        if (output.isError) return output;
        const asset = await ctx.archiveFile(join(api.projectPath(args.projectId), 'emotion_beat_curve.png'), { assetType: 'image', mimeType: 'image/png', signal: api.signal });
        return { ...output, artifact: asset };
      },
    },
  });
}
