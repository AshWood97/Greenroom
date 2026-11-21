import { buildQuadContext } from '@/lib/ai/greenroom-quad-context';
import { angleImageOptions } from '@/lib/ai/greenroom-angle-switch';
import { exportProjectToFolder, exportDirectorToFolder } from '@/lib/script/export-service';
// This entry reuses the original React application's business services in the member worker.
import { useProjectStore } from '@/stores/project-store';
import { useScriptStore } from '@/stores/script-store';
import { useMediaStore } from '@/stores/media-store';
import { useDirectorStore } from '@/stores/director-store';
import { useAPIConfigStore, AI_FEATURES } from '@/stores/api-config-store';
import { switchProject } from '@/lib/project-switcher';
import { importFullScript, generateEpisodeShots, calibrateEpisodeShots, calibrateEpisodeTitles, generateEpisodeSynopses, getMissingTitleEpisodes, exportProjectMetadata } from '@/lib/script/full-script-service';
import { parseScript, generateShotList } from '@/lib/script/script-parser';
import { generateShotImage, generateShotVideo } from '@/lib/script/shot-generator';
import { calibrateCharacters, convertToScriptCharacters, sortByImportance, resolveSafeScriptCharacters } from '@/lib/script/character-calibrator';
import { useCharacterLibraryStore } from '@/stores/character-library-store';
import { syncToSeriesMeta } from '@/lib/script/series-meta-sync';

export async function hydrate(projectId?: string) {
  await useProjectStore.persist.rehydrate();
  if (projectId && useProjectStore.getState().activeProjectId !== projectId) await switchProject(projectId);
  await Promise.all([useScriptStore.persist.rehydrate(), useDirectorStore.persist.rehydrate(), useMediaStore.persist.rehydrate(), useCharacterLibraryStore.persist.rehydrate()]);
  if (projectId) { useScriptStore.getState().setActiveProjectId(projectId); useScriptStore.getState().ensureProject(projectId); }
}
export function configure(config: any) {
  const providers = [{ id: 'greenroom', name: 'Greenroom 托管', platform: 'memefast', baseUrl: 'http://127.0.0.1:18803/managed/v1', apiKey: 'greenroom-managed',
    model: Object.values(config.models).flat(), enabled: true }];
  const imageFeatures = new Set(['character_generation', 'scene_generation', 'freedom_image']);
  const videoFeatures = new Set(['video_generation', 'freedom_video']);
  const featureBindings = Object.fromEntries(AI_FEATURES.map(item => [item.key, (config.models[imageFeatures.has(item.key) ? 'image' : videoFeatures.has(item.key) ? 'video' : 'llm'] || []).map((id: string) => 'memefast:' + id)]));
  useAPIConfigStore.setState({ providers, featureBindings } as any);
}
export async function execute(operation: string, args: any) {
  if (['angle_switch', 'split_quad_grid', 'export_media', 'prepare_quad_grid', 'apply_quad_result'].includes(operation)) {
    await useProjectStore.persist.rehydrate();
    if (typeof args.projectId !== 'string' || !useProjectStore.getState().projects.some(item => item.id === args.projectId)) throw new Error('请指定当前成员已有项目');
  }
  if (operation === 'shot_image' || operation === 'shot_video') {
    const snapshot = (globalThis as any).greenroomShotSnapshot();
    let output: string;
    if (!snapshot || (globalThis as any).greenroomHasShotMedia()) output = (await (globalThis as any).greenroomRecoverShot()).url;
    else {
      const choices = (globalThis as any).greenroomCatalog;
      const kind = snapshot.kind;
      const values = args.config || {};
      const config = { ...choices.parameters[kind], aspectRatio: choices.parameters[kind]?.aspect_ratio, imageResolution: choices.parameters.image?.size, videoResolution: choices.parameters.video?.resolution, ...values, apiKey: 'greenroom-managed', provider: 'memefast', baseUrl: 'http://127.0.0.1:18803/managed/v1', model: values.model || choices.models[kind]?.[0] };
      output = kind === 'image' ? await generateShotImage(snapshot.shot, config) : await generateShotVideo(snapshot.shot, args.imageUrl || snapshot.shot.imageUrl, config);
    }
    const selection = (globalThis as any).greenroomApplyShotResult(output);
    return { url: output, shotId: snapshot?.shotId || args.shotId || args.shot?.id, selection };
  }
  await hydrate(args.projectId);
  const choices = (globalThis as any).greenroomCatalog;
  const managedOptions = (kind: string, values: any = {}) => ({ ...choices.parameters[kind], aspectRatio: choices.parameters[kind]?.aspect_ratio, imageResolution: choices.parameters.image?.size, videoResolution: choices.parameters.video?.resolution, ...values, apiKey: 'greenroom-managed', provider: 'memefast', baseUrl: 'http://127.0.0.1:18803/managed/v1', model: values.model || choices.models[kind]?.[0] });
  const options = managedOptions('llm', args.options);
  const projectId = args.projectId || useProjectStore.getState().activeProjectId!;
  const store = useScriptStore.getState();
  if (operation === 'projects') return useProjectStore.getState().projects;
  if (operation === 'create_project') return useProjectStore.getState().createProject(args.name);
  if (operation === 'project') return { project: useProjectStore.getState().projects.find(item => item.id === projectId), script: store.projects[projectId], director: useDirectorStore.getState().projects[projectId] };
  if (operation === 'import_script') {
    store.setCalibrationState(projectId, { importStatus: 'importing' });
    try {
      const result = await importFullScript(args.text, projectId, options);
      if (!result.success) throw new Error(result.error || '剧本导入未完成');
      if (!args.completeWorkflow) { store.setCalibrationState(projectId, { importStatus: 'ready' }); return result; }
      // The renderer's original import sequence belongs to this submitted job, including its later LLM steps.
      const errors: string[] = [];
      const hasAI = choices.models.llm?.length > 0;
      if (hasAI && getMissingTitleEpisodes(projectId).length) {
        store.setCalibrationState(projectId, { titleCalibrationStatus: 'calibrating' });
        try { const titles = await calibrateEpisodeTitles(projectId, options); store.setCalibrationState(projectId, { titleCalibrationStatus: titles.success ? 'completed' : 'error' }); if (!titles.success) errors.push(titles.error || '标题校准未完成'); }
        catch (failure) { store.setCalibrationState(projectId, { titleCalibrationStatus: 'error' }); errors.push((failure as Error).message); }
      }
      if (hasAI && result.episodes.length) {
        store.setCalibrationState(projectId, { synopsisStatus: 'generating' });
        try { const synopses = await generateEpisodeSynopses(projectId, options); store.setCalibrationState(projectId, { synopsisStatus: synopses.success ? 'completed' : 'error' }); if (!synopses.success) errors.push(synopses.error || '大纲生成未完成'); }
        catch (failure) { store.setCalibrationState(projectId, { synopsisStatus: 'error' }); errors.push((failure as Error).message); }
      }
      let viewpoint: { viewpointAnalyzed: boolean; viewpointSkippedReason?: string } | undefined;
      if (result.episodes.length) {
        store.setCalibrationState(projectId, { viewpointAnalysisStatus: 'analyzing' });
        try { viewpoint = await generateEpisodeShots(1, projectId, options); store.setCalibrationState(projectId, { viewpointAnalysisStatus: viewpoint.viewpointAnalyzed ? 'completed' : 'error' }); }
        catch (failure) { store.setCalibrationState(projectId, { viewpointAnalysisStatus: 'error' }); errors.push((failure as Error).message); }
      }
      if (hasAI && result.scriptData?.characters.length && result.projectBackground) {
        if (!viewpoint?.viewpointAnalyzed) errors.push('AI 视角分析未执行，角色校准尚未完成：' + (viewpoint?.viewpointSkippedReason || errors.at(-1) || '服务商未返回具体失败原因'));
        else {
          store.setCalibrationState(projectId, { characterCalibrationStatus: 'calibrating' });
          try {
            const calibrated = await calibrateCharacters(result.scriptData.characters, result.projectBackground, result.episodes, { promptLanguage: options.promptLanguage });
            const current = useScriptStore.getState().projects[projectId];
            const existing = current?.scriptData?.characters || result.scriptData.characters;
            const resolved = resolveSafeScriptCharacters(convertToScriptCharacters(sortByImportance(calibrated.characters), existing, options.promptLanguage), { existingCharacters: existing, seriesMetaCharacters: current?.seriesMeta?.characters, rawCharacters: result.scriptData.characters });
            if (current?.scriptData) store.setScriptData(projectId, { ...current.scriptData, characters: resolved.characters });
            store.setCalibrationState(projectId, { characterCalibrationStatus: 'completed' });
          } catch (failure) { store.setCalibrationState(projectId, { characterCalibrationStatus: 'error' }); errors.push((failure as Error).message); }
        }
      }
      if (errors.length) throw new Error(errors.join('\n'));
      store.setCalibrationState(projectId, { importStatus: 'ready' });
      return { ...result, scriptData: useScriptStore.getState().projects[projectId]?.scriptData || result.scriptData };
    } catch (failure) { store.setCalibrationState(projectId, { importStatus: 'error' }); throw failure; }
  }
  if (operation === 'parse_script') {
    store.setRawScript(projectId, args.text);
    store.setParseStatus(projectId, 'parsing');
    try {
      const parsed = await parseScript(args.text, options);
      if (!parsed.episodes?.length) parsed.episodes = [{ id: 'default', index: 1, title: parsed.title || '第1集', sceneIds: parsed.scenes.map(scene => scene.id) }];
      store.setScriptData(projectId, parsed);
      if (args.generateShots) {
        store.setShotStatus(projectId, 'generating');
        store.setShots(projectId, []);
        const characterDescriptions = Object.fromEntries(parsed.characters.flatMap(character => {
          const item = useCharacterLibraryStore.getState().characters.find(candidate => candidate.name === character.name || candidate.name.includes(character.name));
          return item ? [[character.id, item.visualTraits || item.description || '']] : [];
        }));
        let completed: any[] = [];
        const shots = await generateShotList(parsed, { ...options, characterDescriptions }, undefined, generated => {
          completed.push(...generated.map((shot, index) => ({ ...shot, id: `shot-${completed.length + index + 1}`, index: completed.length + index + 1 })));
          store.setShots(projectId, [...completed]);
        });
        store.setShots(projectId, shots);
        store.setShotStatus(projectId, 'ready');
      }
      store.setParseStatus(projectId, 'ready');
      return parsed;
    } catch (failure) {
      store.setParseStatus(projectId, 'error', (failure as Error).message);
      if (args.generateShots) store.setShotStatus(projectId, 'error', (failure as Error).message);
      throw failure;
    }
  }
  if (operation === 'generate_episode_shots') {
    store.setCalibrationState(projectId, { viewpointAnalysisStatus: 'analyzing' });
    try {
      const result = await generateEpisodeShots(args.episodeIndex, projectId, options);
      store.setCalibrationState(projectId, { viewpointAnalysisStatus: result.viewpointAnalyzed ? 'completed' : 'error' });
      return result;
    } catch (failure) { store.setCalibrationState(projectId, { viewpointAnalysisStatus: 'error' }); throw failure; }
  }
  if (operation === 'calibrate_shots') {
    store.setCalibrationState(projectId, { viewpointAnalysisStatus: 'analyzing' });
    try {
      const result = await calibrateEpisodeShots(args.episodeIndex, projectId, options, undefined, args.sceneId);
      if (!result.success) throw new Error(result.error || '分镜校准未完成');
      const meta = useScriptStore.getState().projects[projectId]?.seriesMeta;
      if (meta && !args.sceneId) {
        store.updateSeriesMeta(projectId, syncToSeriesMeta(meta, 'shot', {}));
        store.setMetadataMarkdown(projectId, exportProjectMetadata(projectId));
      }
      store.setCalibrationState(projectId, { viewpointAnalysisStatus: 'completed' });
      return result;
    } catch (failure) { store.setCalibrationState(projectId, { viewpointAnalysisStatus: 'error' }); throw failure; }
  }
  if (operation === 'calibrate_titles' || operation === 'episode_synopses') {
    const key = operation === 'calibrate_titles' ? 'titleCalibrationStatus' : 'synopsisStatus';
    store.setCalibrationState(projectId, { [key]: operation === 'calibrate_titles' ? 'calibrating' : 'generating' });
    try {
      const result = operation === 'calibrate_titles' ? await calibrateEpisodeTitles(projectId, options) : await generateEpisodeSynopses(projectId, options);
      if (!result.success) throw new Error(result.error || '剧本校准未完成');
      store.setCalibrationState(projectId, { [key]: 'completed' });
      return result;
    } catch (failure) { store.setCalibrationState(projectId, { [key]: 'error' }); throw failure; }
  }
  if (operation === 'update_shot') { store.updateShot(projectId, args.shotId, args.changes); return store.projects[projectId]; }
  if (operation === 'update_character') { store.updateCharacter(projectId, args.characterId, args.changes); return store.projects[projectId]; }
  if (operation === 'update_scene') { store.updateScene(projectId, args.sceneId, args.changes); return store.projects[projectId]; }

  if (operation === 'prepare_quad_grid' || operation === 'apply_quad_result') {
    const director = useDirectorStore.getState();
    const project = director.projects[projectId];
    const scene = project?.splitScenes.find(item => item.id === args.sceneId);
    if (!scene || !['start', 'end'].includes(args.frameType)) throw new Error('请选择当前项目已有导演分镜和首帧/尾帧');
    if (operation === 'prepare_quad_grid') {
      const model = args.model || choices.models.image?.[0];
      if (!choices.models.image?.includes(model)) throw new Error('该生成模型未获得管理员授权');
      return buildQuadContext({ scene, storyboardConfig: project.storyboardConfig, characters: useCharacterLibraryStore.getState().characters, frameType: args.frameType, variationType: args.variationType, useCharacterRef: args.useCharacterRef, model, modelReferenceLimit: (globalThis as any).greenroomImageReferenceLimit(model) });
    }
    const result = await (globalThis as any).greenroomQuadResult(args.splitTaskId, projectId);
    if (!Number.isInteger(args.imageIndex) || args.imageIndex < 0 || args.imageIndex > 3) throw new Error('四宫格序号必须是0至3');
    const image = result.images[args.imageIndex];
    director.setActiveProjectId(projectId);
    // Use the native local-image frame contract; do not call image-host-upload.
    if (args.frameType === 'start') director.updateSplitSceneImage(scene.id, image.localPath, image.width, image.height);
    else director.updateSplitSceneEndFrame(scene.id, image.localPath, 'upload');
    return { sceneId: scene.id, frameType: args.frameType, imageIndex: args.imageIndex, splitTaskId: args.splitTaskId, localPath: image.localPath, url: image.url };
  }
  if (operation === 'split_quad_grid') {
    const result = await (globalThis as any).greenroomSplitQuad(args.referenceImage);
    const mediaStore = useMediaStore.getState();
    for (const item of result.images) if (!mediaStore.mediaFiles.some(file => file.url === item.url)) mediaStore.addMediaFromUrl({ url: item.url, name: '四宫格-' + (item.index + 1), type: 'image', source: 'upload', projectId });
    return result;
  }
  if (operation === 'export_media') {
    if (!['script', 'director'].includes(args.source)) throw new Error('未知导出来源');
    const project = store.projects[projectId];
    if (!project) throw new Error('项目不存在');
    const name = useProjectStore.getState().projects.find(item => item.id === projectId)?.name || 'moyin';
    const common = { projectName: name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_'), includeImages: args.includeImages !== false, includeVideos: args.includeVideos !== false };
    if (args.source === 'director') {
      const director = useDirectorStore.getState().projects[projectId];
      if (!director?.splitScenes?.length) throw new Error('导演分镜为空');
      return (globalThis as any).greenroomExportFolder(() => exportDirectorToFolder({ ...common, scenes: director.splitScenes, includeEndFrames: args.includeEndFrames !== false }));
    }
    if (!project.scriptData) throw new Error('项目尚无可导出的剧本');
    return (globalThis as any).greenroomExportFolder(() => exportProjectToFolder({ ...common, scriptData: project.scriptData!, shots: project.shots, targetDuration: String(project.targetDuration || ''), format: 'folder' }));
  }
  if (operation === 'angle_switch' || operation === 'generate_image' || operation === 'generate_video') {
    const kind = operation === 'generate_video' ? 'video' : 'image';
    const input = operation === 'angle_switch' ? angleImageOptions(args) : { ...args.options, prompt: args.prompt };
    const result = await (globalThis as any).greenroomGenerate(kind, { ...input, projectId });
    const mediaStore = useMediaStore.getState();
    const mediaId = mediaStore.mediaFiles.find(item => item.url === result.url)?.id || mediaStore.addMediaFromUrl({ url: result.url, name: input.prompt.slice(0, 30), type: kind, source: kind === 'image' ? 'ai-image' : 'ai-video', projectId });
    return { ...result, mediaId };
  }
  throw new Error('未知魔因业务操作');
}
