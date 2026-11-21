// Fixed native Rust renderer contract, not a model or arbitrary-code renderer.
export function frameExportPlan(project, frames, composition, audio, useStillImages = false, useOriginalAudio = false, useFrameDurations = false) {
  if (!project?.id || !frames.length) throw new Error('原工程没有可导出的分镜');
  if (composition?.projectId && composition.projectId !== project.id) throw new Error('合成配置不属于当前工程');
  if (composition?.transitions?.some(t => t.effect !== 'none') || (composition?.masterSettings?.defaultTransition?.effect && composition.masterSettings.defaultTransition.effect !== 'none') || composition?.masterSettings?.globalEffects?.length) throw new Error('原生图帧导出尚不支持当前转场/全局效果，请保留配置并使用支持这些效果的导出路径');
  if (audio?.voiceTracks?.length || audio?.soundEffects?.length) throw new Error('原生图帧导出尚不支持独立对白/音效时间轴；支持分镜自身的 audioUrl');
  const bgm = audio?.backgroundMusic;
  if (!bgm && frames.some(f => f.audioUrl) && !useOriginalAudio && [audio?.masterVolume,audio?.voiceVolume].some(n => n != null && n !== 100)) throw new Error('无背景音乐时原生导出不能应用对白/主音量；请明确选择使用分镜原音量或保留当前设置等待支持的混音路径');
  if (bgm && (bgm.startTime || bgm.fadeIn || bgm.fadeOut || !bgm.loop)) throw new Error('原生背景音乐只支持从零开始循环；尚不支持偏移、淡入淡出或非循环');
  const ids = new Set(), motions = [];
  const media = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(label + '缺少实际素材');
    if (/^(blob:|data:)/.test(value)) throw new Error(label + '尚未保存为持久素材');
    return value;
  };
  const scenes = frames.map(frame => {
    if (!frame.id || ids.has(frame.id)) throw new Error('分镜缺少唯一原始编号'); ids.add(frame.id);
    if (frame.videoUrl && !useStillImages) throw new Error('分镜 ' + frame.id + ' 已选择视频；图帧导出不能代替视频或丢弃其声音');
    const config = composition?.frames?.find(f => f.frameId === frame.id);
    if (config?.keyframes?.length || (config?.zoom != null && config.zoom !== 1) || config?.pan?.x || config?.pan?.y || config?.rotation || (config?.opacity != null && config.opacity !== 1) || Object.entries(config?.filters || {}).some(([k,v]) => v !== (k === 'blur' ? 0 : 100))) throw new Error('分镜 ' + frame.id + ' 的关键帧/变换/滤镜尚不能由原生导出还原');
    const duration = useFrameDurations ? frame.duration : (composition?.masterSettings?.frameDuration ?? frame.duration);
    if (!Number.isFinite(duration) || duration <= 0.5) throw new Error('分镜 ' + frame.id + ' 时长必须大于 0.5 秒');
    const motion = config?.cameraMotion;
    const supported = {'static':'static','zoom-in':'zoom_in','zoom-out':'zoom_out','pan-left':'pan_left','pan-right':'pan_right','shake':'shake'};
    if (motion && (!supported[motion.type] || (motion.duration != null && motion.duration !== duration) || (motion.easing && motion.easing !== 'linear') || motion.startPoint || motion.endPoint)) throw new Error('分镜 ' + frame.id + ' 运镜类型/时长/缓动尚不能由原生导出还原');
    if (motion?.type === 'shake' && motion.intensity != null && motion.intensity !== 1) throw new Error('分镜 ' + frame.id + ' 的震屏仅支持固定原生强度 1，不能应用当前强度');
    if (motion) motions.push(motion.intensity ?? 1);
    return {id:frame.id,image_path:media(frame.imageUrl,'分镜 '+frame.id),audio_path:frame.audioUrl ? media(frame.audioUrl,'配音 '+frame.id) : undefined,duration,camera_motion:motion ? supported[motion.type] : 'static',dialogue:frame.dialogue || ''};
  });
  if (composition?.frames?.some(f => !ids.has(f.frameId))) throw new Error('合成配置引用了当前工程不存在的分镜');
  if (motions.some(n => !Number.isFinite(n) || n < 0 || n !== motions[0])) throw new Error('原生导出仅支持各镜头使用相同运镜强度');
  if (bgm && [bgm.volume,audio.musicVolume,audio.masterVolume,audio.voiceVolume].some(n => !Number.isFinite(n) || n < 0 || n > 100)) throw new Error('背景音乐或音量配置无效');
  const aspect = project.exportPreset || '16:9';
  if (!['16:9','9:16','1:1'].includes(aspect)) throw new Error('画幅配置无效');
  return {projectId:project.id,params:{project_id:project.id,scenes,resolution:'720p',aspect_ratio:aspect,camera_motion_mode:'static',motion_intensity:motions[0] ?? 1,subtitle_enabled:true,
    ...(bgm ? {bgm_path:media(bgm.fileUrl || bgm.filePath,'背景音乐'),bgm_volume:(bgm.volume / 100) * (audio.musicVolume / 100) * (audio.masterVolume / 100),voice_volume:(audio.voiceVolume / 100) * (audio.masterVolume / 100)} : {})}};
}

export async function submitFrameExport({plan, save, active, runJob, remember, submissionId}) {
  await save();
  if (!active()) throw new Error('工程已切换，未提交导出');
  await remember({submissionId,projectId:plan.projectId});
  if (!active()) {
    await remember({submissionId,projectId:plan.projectId,status:'not-submitted'});
    throw new Error('工程已切换，未提交导出');
  }
  try {
    return await runJob('render',plan,undefined,submissionId,job => remember({submissionId,projectId:plan.projectId,taskId:job.id}),active);
  } catch (error) {
    if (error?.notSubmitted) await remember({submissionId,projectId:plan.projectId,status:'not-submitted'});
    throw error;
  }
}

export function restoredFrameExportResult(receipt, projectId) {
  const result = receipt?.result;
  if (receipt?.projectId !== projectId || typeof receipt?.taskId !== 'string' || !receipt.taskId || result?.taskId !== receipt.taskId || !/^\/creative-managed\/media\/[A-Za-z0-9_-]+$/.test(result?.url || '') || !Number.isFinite(result?.bytes) || result.bytes <= 0 || !Number.isFinite(result?.duration) || result.duration <= 0) return null;
  return result;
}

export function frameExportResult(task, projectId) {
  if (task.projectId !== projectId || task.kind !== 'render' || task.status !== 'succeeded') throw new Error('原导出任务尚未成功');
  const output = task.outputs?.[0];
  if (!output?.assetId || !output.url?.startsWith('/creative-managed/media/') || !output.mimeType?.startsWith('video/') || task.result?.output_path !== output.url || !(task.result.file_size > 0)) throw new Error('原导出尚无可下载的真实视频资产');
  const result = restoredFrameExportResult({projectId:task.projectId,taskId:task.id,result:{url:output.url,bytes:task.result.file_size,duration:task.result.duration,taskId:task.id}},projectId);
  if (!result) throw new Error('原导出视频的任务编号、字节或时长无效');
  return result;
}
