import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const string = { type: 'string' }, object = { type: 'object' };
const id = { id: string };
const operations = { type: 'array', items: { type: 'object', properties: {
  type: { type: 'string', enum: ['create_canvas', 'create_node', 'patch_node', 'remove_node', 'create_connection', 'update_connection', 'remove_connection', 'set_field'] },
  id: string, node: object, connection: object, patch: object, before: object, expected: object,
  field: { type: 'string', enum: ['title', 'projectId', 'chatSessions', 'activeChatId', 'starterMode', 'appearance', 'backgroundMode', 'showImageInfo', 'previsScenes', 'timeline'] },
  value: {}, beforeValue: {},
}, required: ['type'] } };
const integer = { type: 'integer' };
const choice = (...values) => ({ type: 'string', enum: values });
const modelChoice = { type: 'object', properties: { logicalModelId: string, channelId: string, modelKey: string, label: string, priceLabel: string }, additionalProperties: false };
const skillRef = { type: 'object', properties: { skillId: string, skillName: string, path: string }, additionalProperties: false };
// Native DramaSettings: settings updates replace the settings object, not a partial merge.
const dramaSettings = { type: 'object', additionalProperties: false, properties: {
  aspectRatio: string, episodeSeconds: integer, stylePrompt: string, styleName: string, language: string,
  assets: { type: 'object', additionalProperties: false, properties: {
    mode: choice('portrait', 'turnaround', 'fourview', 'custom'), characterPrompt: string, scenePrompt: string, characterRatio: string,
    resolution: string, propResolution: string, sceneResolution: string, sourceSkillId: string, sourceSkillName: string, sourcePath: string,
  } },
  storyboard: { type: 'object', additionalProperties: false, properties: {
    segmentMode: choice('auto', 'fixed', 'range'), segmentSeconds: integer, segmentMinSeconds: integer, segmentMaxSeconds: integer,
    pacing: choice('rapid', 'fast', 'standard', 'relaxed', 'slow'), dialogue: choice('dense', 'standard', 'sparse'),
    transition: choice('auto', 'cut', 'fadeblack', 'fadewhite'), transitionMs: integer, performance: integer, cameraMotion: integer,
  } },
  promptSkill: skillRef, bibleSkill: skillRef, scriptSkill: skillRef,
  reviewMode: choice('sample', 'every', 'auto'), mediaMode: choice('manual', 'auto'), concurrency: integer,
  models: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['text', 'image', 'video', 'bibleText', 'scriptText', 'promptText', 'characterImage', 'propImage', 'sceneImage'].map(key => [key, modelChoice])) },
  textThinking: { type: 'object', description: '托管通路目前仅支持空值或auto，沿用管理员模型默认设置。尚无可信网关思考能力映射；显式档位（含off/deep/high）由服务端拒绝，不会静默降档。', additionalProperties: false, properties: Object.fromEntries(['bible', 'plan', 'script', 'prompt'].map(key => [key, choice('', 'auto')])) },
  referenceLimit: integer, episodeMode: choice('auto', 'chapter'), chaptersPerEpisode: integer,
  videoContinuity: choice('parallel', 'tail_frame'), videoResolution: string,
} };
const dramaForm = {
  name: string, chapters: { type: 'array', items: { type: 'object', properties: { title: string, text: string }, required: ['title', 'text'], additionalProperties: false } },
  sourceFormat: choice('novel', 'script', 'storyboard'), episodeMode: choice('auto', 'chapter'), settings: dramaSettings,
  selectedChapters: { type: 'array', items: { ...integer, minimum: 0 }, description: '加入制作的章节下标，从0开始；省略或空数组表示全部章节，未选章节仍保存为预留章节。' },
  draft: { type: 'object', properties: { sourceText: string, styleId: string }, required: ['sourceText'], additionalProperties: false },
};
const dramaFormRequired = ['name', 'chapters', 'sourceFormat', 'settings'];
// Both native creation and draft replacement accept start; DSH saves only.
const savedDramaForm = a => ({
  name: a.name, chapters: a.chapters, sourceFormat: a.sourceFormat,
  ...(a.episodeMode === undefined ? {} : { episodeMode: a.episodeMode }),
  ...(a.selectedChapters === undefined ? {} : { selectedChapters: a.selectedChapters }),
  ...(a.draft === undefined ? {} : { draft: a.draft }),
  settings: { ...a.settings, videoContinuity: a.settings?.videoContinuity || 'parallel' }, start: false,
});
const dramaPath = a => '/api/dramas/' + encodeURIComponent(a.id);
const lookFields = {
  lookName: { ...string, description: '造型名1–60字，不能与基础造型重名。' }, appearance: { ...string, description: '造型外观；原生服务最多保存1000字，超出会截断。' }, imagePrompt: { ...string, description: '最多12000字；空字符串可清空造型提示词。' },
  fromChapter: { ...integer, minimum: 0 }, toChapter: { ...integer, minimum: 0 },
};
const restyleSegments = { type: 'boolean', default: false, description: '仅明确授权使下游视频过期时设true；运行中的作品可能重新调度并产生费用。' };
const lookBody = a => Object.fromEntries(Object.keys(lookFields).filter(key => a[key] !== undefined).map(key => [key, a[key]]));
const actions = {
  open_ai_canvas_drama_cast: ['读取原作品角色、场景和造型原ID；parentId非空为造型，声音继承角色本体。只查询，不生成。', id, ['id'], a => [dramaPath(a) + '/cast']],
  open_ai_canvas_regenerate_drama_cast: ['明确请求指定角色或造型重新生图，会产生费用，只能在用户授权生成的有效DSH对话中执行。须显式给出restyleSegments；true还使下游视频过期。原生服务拒绝锁定设定，本工具不解锁。排队/运行中只查询原任务，不重新排队；角色本体重做还会重新排队其失败造型，并可能恢复暂停/已完成作品。受理未知或同一调用重放一律停止，查询原作品cast/jobs/job_detail/task，不用新调用绕过未知受理。', { id: string, castId: string, restyleSegments }, ['id', 'castId', 'restyleSegments'], a => [dramaPath(a) + '/cast/' + encodeURIComponent(a.castId) + '/regenerate', 'POST', { restyleSegments: a.restyleSegments }]],
  open_ai_canvas_get_drama_episode: ['读取原生分集详情和逐段实际请求预览。episodeId来自get_drama；音频参考是否发送须检查segments[].request.audioReferences的sent/note，不能因已绑定声音就假定已发送。只查询，不生成。', { id: string, episodeId: string }, ['id', 'episodeId'], a => [dramaPath(a) + '/episodes/' + encodeURIComponent(a.episodeId)]],
  open_ai_canvas_drama_cast_impact: ['读取原角色或造型影响的分集/剧情段数量；在替换参考图、删除造型或选择下游重制前查询，不生成。', { id: string, castId: string }, ['id', 'castId'], a => [dramaPath(a) + '/cast/' + encodeURIComponent(a.castId) + '/impact']],
  open_ai_canvas_set_drama_cast_image: ['采用当前成员已就绪的原生图片resourceId作为角色或造型参考图并锁定，不提交生图；不可用Asset ID或URL代替。取消该角色排队的生图，已运行结果只记版本、不覆盖采用图。重复采用同图返回unchanged，不新增版本。即使restyleSegments=false也会唤醒调度，已完成作品可能恢复、运行中作品可能继续后台生成；restyleSegments默认false，true须明确重制授权。taskId仅用于原画布图片来源，不匹配时原生服务忽略。', { id: string, castId: string, resourceId: string, source: choice('upload', 'canvas'), taskId: string, restyleSegments }, ['id', 'castId', 'resourceId'], a => [dramaPath(a) + '/cast/' + encodeURIComponent(a.castId) + '/image', 'PUT', { resourceId: a.resourceId, ...(a.source === undefined ? {} : { source: a.source }), ...(a.taskId === undefined ? {} : { taskId: a.taskId }), restyleSegments: a.restyleSegments === true }]],
  open_ai_canvas_list_voice_profiles: ['读取当前成员可用的原生声音库。用于短剧角色的返回声音条目必须有sampleResourceId，绑定时可只传该条目的voiceProfileId；仅音色名、无样本的内置声音不可用于视频参考。', {}, [], () => ['/api/voice-profiles']],
  open_ai_canvas_add_drama_look: ['为现有角色本体保存新造型草稿，不直接提交生图；每个角色最多6套造型（不含基础造型）。castId来自drama_cast；lookName和appearance必填。章节从1起，0表示不限；保存不保证幂等，受理未知先查询原角色，不重复新增。', { id: string, castId: string, ...lookFields }, ['id', 'castId', 'lookName', 'appearance'], a => [dramaPath(a) + '/cast/' + encodeURIComponent(a.castId) + '/looks', 'POST', lookBody(a)]],
  open_ai_canvas_update_drama_look: ['更新原造型设定，不直接提交生图，已有图片保留；即使restyleSegments=false也会唤醒调度，运行中作品可能继续后台生成。先读取原造型；更新章节范围时须同时传fromChapter/toChapter，未传的一端会重置为不限。restyleSegments默认false；true使受影响视频过期，须已有明确重制授权。', { id: string, lookId: string, ...lookFields, restyleSegments }, ['id', 'lookId'], a => [dramaPath(a) + '/looks/' + encodeURIComponent(a.lookId), 'PATCH', { ...lookBody(a), restyleSegments: a.restyleSegments === true }]],
  open_ai_canvas_remove_drama_look: ['删除指定原造型，镜头引用回退角色本体；不删除角色。须确认删除范围。不直接提交生成，但会唤醒调度，运行中作品可能继续后台生成。restyleSegments默认false；true还使受影响视频过期，须已有明确重制授权。', { id: string, lookId: string, restyleSegments }, ['id', 'lookId'], a => [dramaPath(a) + '/looks/' + encodeURIComponent(a.lookId) + '?restyleSegments=' + (a.restyleSegments === true), 'DELETE']],
  open_ai_canvas_set_drama_cast_voice: ['为角色本体绑定当前成员拥有的原生voiceProfileId或已就绪音频sampleResourceId，至少提供一个；两者同传时样本优先。不能传成员Asset ID或URL代替原生resource ID。样本会登记/复用声音库，voiceName可改样本声音名。不克隆声音、不直接提交音频生成；造型继承本体声音。即使restyleSegments=false也会唤醒调度，运行中作品可能继续后台生成。restyleSegments默认false，true须有明确重制授权；当前托管视频能力未核实参考音频，声音绑定不表示生成会发送样本。', { id: string, castId: string, voiceProfileId: string, sampleResourceId: string, voiceName: string, restyleSegments }, ['id', 'castId'], a => [dramaPath(a) + '/cast/' + encodeURIComponent(a.castId) + '/voice', 'PUT', { ...Object.fromEntries(['voiceProfileId', 'sampleResourceId', 'voiceName'].filter(key => a[key] !== undefined).map(key => [key, a[key]])), restyleSegments: a.restyleSegments === true }], { anyOf: [{ required: ['voiceProfileId'] }, { required: ['sampleResourceId'] }] }],
  open_ai_canvas_clear_drama_cast_voice: ['清除角色的声音绑定，恢复仅声线描述；不删除原声音库或样本资源。不直接提交生成，但会唤醒调度，运行中作品可能继续后台生成。restyleSegments默认false；true使受影响视频过期，须已有明确重制授权。', { id: string, castId: string, restyleSegments }, ['id', 'castId'], a => [dramaPath(a) + '/cast/' + encodeURIComponent(a.castId) + '/voice?restyleSegments=' + (a.restyleSegments === true), 'DELETE']],
  open_ai_canvas_drama_models: ['读取新短剧流水线可选星网模型与已知能力；未知能力不等于已支持，费用以星网实际回执为准。', {}, [], () => ['/api/dramas/models']],
  open_ai_canvas_list_dramas: ['分页查询新短剧流水线作品；不同于旧 projects/分集接口。', { page: { ...integer, minimum: 1 }, pageSize: { ...integer, minimum: 1, maximum: 100 }, q: string, status: string }, [], a => {
    const query = new URLSearchParams();
    for (const key of ['page', 'pageSize', 'q', 'status']) if (a[key] !== undefined) query.set(key, String(a[key]));
    return ['/api/dramas' + (query.size ? '?' + query : '')];
  }],
  open_ai_canvas_create_drama: ['保存新短剧流水线作品和章节，固定 start=false，不启动生成。先读取drama_models选择模型；textThinking的bible/plan/script/prompt目前仅支持空值或auto，显式思考档位尚未接通并由服务端拒绝。随后只有用户授权才能调用start。重复创建不保证幂等，请先查询已有作品。', dramaForm, dramaFormRequired, a => ['/api/dramas', 'POST', savedDramaForm(a)]],
  open_ai_canvas_get_drama_draft: ['读取尚未开工且保存了创建表单的原生草稿；form为原始正文与画风，selectedChapters为加入制作的章节下标。不启动生成。', id, ['id'], a => [dramaPath(a) + '/draft']],
  open_ai_canvas_save_drama_draft: ['整体替换尚未开工的原生草稿。先读取草稿与章节，完整传回表单和设置；固定start=false，不启动生成，不设置本地预算。已开工的作品由原生服务拒绝，不能用重建作品绕过。', { id: string, ...dramaForm }, ['id', ...dramaFormRequired], a => [dramaPath(a) + '/draft', 'PUT', savedDramaForm(a)]],
  open_ai_canvas_drama_chapters: ['读取原著章节目录、原章节ID、预留状态和分集归属；只查询，不加入制作或重新提交生成。', id, ['id'], a => [dramaPath(a) + '/chapters']],
  open_ai_canvas_get_drama_chapter: ['读取原生原著章节正文；chapterId来自drama_chapters，不是旧工程分集ID。', { id: string, chapterId: string }, ['id', 'chapterId'], a => [dramaPath(a) + '/chapters/' + encodeURIComponent(a.chapterId)]],
  open_ai_canvas_produce_drama_chapters: ['将预留原著章节加入制作并追加分集，可能推进后台生成和产生实际费用，仅在用户已授权生成时调用。先查询原章节状态；受理结果未知时只查询原作品/章节，不重复提交或重建。chaptersPerEpisode省略或0沿用作品设置。', { id: string, chapterIds: { type: 'array', items: string, minItems: 1, maxItems: 3000 }, chaptersPerEpisode: { ...integer, minimum: 0, maximum: 12 } }, ['id', 'chapterIds'], a => [dramaPath(a) + '/chapters/produce', 'POST', { chapterIds: a.chapterIds, ...(a.chaptersPerEpisode === undefined ? {} : { chaptersPerEpisode: a.chaptersPerEpisode }) }]],
  open_ai_canvas_get_drama: ['读取新短剧流水线原生作品摘要、设置、分集与进度；只查询，不重新提交生成。', id, ['id'], a => [dramaPath(a)]],
  open_ai_canvas_update_drama_settings: ['更新流水线完整原生settings：先get_drama读取当前设置，只修改所需字段后完整传回。运行中更改会影响后续生成，须遵循用户已授权制作范围。不设置本地预算。', { id: string, settings: dramaSettings }, ['id', 'settings'], a => [dramaPath(a) + '/settings', 'PATCH', { settings: a.settings }]],
  open_ai_canvas_start_drama: ['启动或继续短剧后台流水线，会调用星网模型生成并产生实际费用，仅在用户已授权生成时调用。已受理任务或费用回执pending只查原任务，不用start或重建作品代替查询。', id, ['id'], a => [dramaPath(a) + '/start', 'POST', {}]],
  open_ai_canvas_pause_drama: ['暂停短剧流水线后续调度；已受理的后台任务不保证取消，应继续查询原任务及费用回执。', id, ['id'], a => [dramaPath(a) + '/pause', 'POST', {}]],
  open_ai_canvas_drama_jobs: ['查询短剧流水线任务列表和状态，回执pending时继续查询，不重投。', { id: string, limit: { ...integer, minimum: 1 } }, ['id'], a => [dramaPath(a) + '/jobs' + (a.limit === undefined ? '' : '?limit=' + encodeURIComponent(a.limit))]],
  open_ai_canvas_drama_job_detail: ['读取短剧原任务详情、尝试记录和费用确认标志；只有costConfirmed=true的费用才已确认，缺失或false不是零费用。此工具不重投生成。', { id: string, jobId: string }, ['id', 'jobId'], a => [dramaPath(a) + '/jobs/' + encodeURIComponent(a.jobId)]],
  open_ai_canvas_list_canvases: ['列出原生影策画布，包含工程关联和版本。', {}, [], () => ['/api/canvas-projects']],
  open_ai_canvas_get_canvas: ['读取原生画布完整节点、连线、预演、剧本与时间线。', id, ['id'], a => ['/api/canvas-projects/' + encodeURIComponent(a.id)]],
  open_ai_canvas_create_canvas: ['创建原生影策画布，随后可用 operations 编辑节点和连线。', { id: string, title: string, projectId: string }, ['title'], a => {
    const canvasId = a.id || randomUUID();
    return ['/api/canvas-projects/' + encodeURIComponent(canvasId) + '/operations', 'PATCH', { mutationId: randomUUID(), baseRevision: 0, operations: [{ type: 'create_canvas', id: canvasId, patch: { title: a.title, ...(a.projectId ? { projectId: a.projectId } : {}) } }] }];
  }],
  open_ai_canvas_edit_canvas: ['调用原生画布操作协议。先读取 revision 和节点；patch_node.before、set_field.beforeValue用于冲突检测。修改受租约保护的节点前先获取编辑租约。', {
    id: string, mutationId: string, baseRevision: { type: 'integer' }, operations,
    editProofs: { type: 'array', items: { type: 'object', properties: { nodeId: string, sessionId: string, token: string }, required: ['nodeId', 'sessionId', 'token'] } },
  }, ['id', 'operations'], a => { const { id: canvasId, ...body } = a; return ['/api/canvas-projects/' + encodeURIComponent(canvasId) + '/operations', 'PATCH', { ...body, mutationId: body.mutationId || randomUUID() }]; }],
  open_ai_canvas_sync_status: ['读取画布当前版本、正在编辑的节点和 Agent 活动。', id, ['id'], a => ['/api/canvas-projects/' + encodeURIComponent(a.id) + '/sync-status']],
  open_ai_canvas_edit_lease: ['通过原生租约协议获取、续期或释放节点编辑权。sessionId应保持在同一次编辑会话内。', { id: string, nodeId: string, sessionId: string, token: string, action: { type: 'string', enum: ['acquire', 'renew', 'release'] } }, ['id', 'nodeId', 'sessionId', 'action'], a => { const { id: canvasId, ...body } = a; return ['/api/canvas-projects/' + encodeURIComponent(canvasId) + '/edit-lease', 'POST', body]; }],
  open_ai_canvas_list_projects: ['列出原生短剧工程及已有分集。', {}, [], () => ['/api/projects']],
  open_ai_canvas_create_project: ['创建原生影策短剧工程，使用管理员托管模型。', { name: string, type: string, aspectRatio: string, sourceType: string, description: string, stylePresetId: string, styleProfileJson: string, defaultImageModel: string, defaultVideoModel: string }, ['name'], a => ['/api/projects', 'POST', a]],
  open_ai_canvas_get_project: ['读取短剧工程原生详情。', id, ['id'], a => ['/api/projects/' + encodeURIComponent(a.id)]],
  open_ai_canvas_list_episodes: ['列出原生分集/章节。', { projectId: string }, ['projectId'], a => ['/api/projects/' + encodeURIComponent(a.projectId) + '/units']],
  open_ai_canvas_create_episode: ['创建原生分集或章节并保存源剧本。', { projectId: string, kind: string, title: string, sourceText: string, position: { type: 'integer' } }, ['projectId', 'title'], a => { const { projectId, ...body } = a; return ['/api/projects/' + encodeURIComponent(projectId) + '/units', 'POST', body]; }],
  open_ai_canvas_list_assets: ['读取原生资产库中的角色、场景、图片、音视频。', {}, [], () => ['/api/assets']],
  open_ai_canvas_get_resource: ['读取原生私有媒体资源元数据。资源文件通过插件内的 /api/resources/<id>/file 读取。', id, ['id'], a => ['/api/resources/' + encodeURIComponent(a.id)]],
  open_ai_canvas_list_models: ['读取管理员批准的文本、图片、视频和配音模型，不包含凭据。', {}, [], () => ['/api/model-catalog']],
  open_ai_canvas_generate: ['提交原生后台生成任务。input.mode为text/image/video/audio；input.config含model与创作参数，参考素材用referenceImages/referenceVideos/referenceAudios。metadata沿用原画布节点字段以便生成结果写回。返回任务后继续在后台执行。', {
    projectId: string, type: { type: 'string', enum: ['canvas_text', 'canvas_image', 'canvas_video', 'canvas_audio'] }, prompt: string, operation: string, model: string,
    input: { type: 'object', properties: { mode: { type: 'string', enum: ['text', 'image', 'video', 'audio'] }, prompt: string, config: object, referenceImages: { type: 'array', items: object }, referenceVideos: { type: 'array', items: object }, referenceAudios: { type: 'array', items: object }, mask: object, textHistory: { type: 'array', items: object }, metadata: object }, required: ['mode'] },
  }, ['type', 'prompt', 'input'], a => ['/api/tasks', 'POST', a]],
  open_ai_canvas_list_tasks: ['列出原生后台任务和实际失败原因。', { projectId: string }, [], a => ['/api/tasks' + (a.projectId ? '?projectId=' + encodeURIComponent(a.projectId) : '')]],
  open_ai_canvas_get_task: ['查询原生任务与私有媒体，不会重新提交生成。', id, ['id'], a => ['/api/tasks/' + encodeURIComponent(a.id)]],
  open_ai_canvas_task_logs: ['读取任务执行、查询失败与恢复记录。', id, ['id'], a => ['/api/tasks/' + encodeURIComponent(a.id) + '/logs']],
  open_ai_canvas_cancel_task: ['请求取消原生任务。已受理的上游任务按平台实际取消能力处理。', id, ['id'], a => ['/api/tasks/' + encodeURIComponent(a.id) + '/cancel', 'POST', {}]],
  open_ai_canvas_render_timeline: ['用影策原生本地 FFmpeg 渲染已有时间线，保留原编辑数据，返回后台任务。timeline使用get_canvas返回的原生timeline。', { projectId: string, timeline: object }, ['timeline'], a => ['/api/timeline/renders', 'POST', a]],
};

export async function createAdapter(ctx) {
  await mkdir(ctx.root, { recursive: true });
  const receiptPath = join(ctx.root, 'mcp-submissions.json');
  let receipts;
  try { receipts = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; receipts = {}; }
  let saving = Promise.resolve();
  const saveReceipts = () => {
    saving = saving.then(async () => { await writeFile(receiptPath + '.tmp', JSON.stringify(receipts)); await rename(receiptPath + '.tmp', receiptPath); });
    return saving;
  };
  return {
    listTools: () => Object.entries(actions).map(([name, [description, properties, required, , constraints]]) => ({ name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), ...constraints } })),
    async callTool(name, args, { signal, callId, sessionId, exec } = {}) {
      if (!actions[name]) throw new Error('未知影策业务工具');
      if (name === 'open_ai_canvas_regenerate_drama_cast') {
        if (!exec?.agent || !callId || !sessionId || exec.callId !== callId || exec.agent.session?.id !== sessionId) {
          throw new Error('此操作需要有效的 DSH 对话调用上下文；请在成员创作对话中执行，CLI 不能创建或伪造该上下文');
        }
        const key = JSON.stringify(['regenerate_drama_cast', sessionId, callId]);
        const replay = () => { if (receipts[key]) throw new Error('此重做调用已尝试受理，不能重放；请查询原作品角色、作业及任务ID确认结果，未知受理不可另建调用绕过'); };
        replay();
        const current = await ctx.request(dramaPath(args) + '/cast', { method: 'GET', signal });
        if (current.code !== 0) throw new Error(current.msg || '影策未返回具体业务原因');
        const cast = current.data?.cast?.find(item => item.id === args.castId);
        if (cast && ['queued', 'running'].includes(cast.imageStatus)) throw new Error('该设定已排队或运行，请查询原作业和任务ID，不重复提交重做');
        replay();
        // Native regenerate has no idempotency key. Persist before POST, including
        // unknown outcomes, so the same DSH invocation cannot enqueue it again.
        receipts[key] = { projectId: args.id, castId: args.castId };
        await saveReceipts();
      }
      let headers;
      if (name === 'open_ai_canvas_generate' && callId) {
        const key = JSON.stringify([sessionId || '', callId]);
        if (!receipts[key]) {
          receipts[key] = randomUUID();
          saveReceipts();
        }
        await saving;
        headers = { 'X-Greenroom-Task-ID': receipts[key] };
      }
      const [path, method = 'GET', body] = actions[name][3](args);
      const value = await ctx.request(path, { method, body, signal, headers });
      if (value.code !== 0) throw new Error(value.msg || '影策未返回具体业务原因');
      if (value.data?.status === 'failed' && value.data.error) value.data.error = ctx.formatGenerationError(value.data.error);
      return { content: [{ type: 'text', text: JSON.stringify(value.data) }], ...(value.data?.status === 'failed' ? { isError: true } : {}) };
    },
    getUiTarget: () => ctx.endpoint.replace(/\/$/, '') + '/plugins/open-ai-canvas',
    restore: () => ctx.request('/api/health/ready'),
    close: async () => {},
  };
}
