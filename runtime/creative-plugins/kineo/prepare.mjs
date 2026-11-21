import { readFileSync, writeFileSync, cpSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const integration=dirname(fileURLToPath(import.meta.url));
const root=process.argv[2];
if(!root) throw new Error('Provide the pinned Kineo source directory');
const read=path=>readFileSync(join(root,path),'utf8');
const write=(path,value)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value);};
function patch(path,needle,value){const text=read(path);if(!text.includes(needle)) throw new Error('Kineo upstream changed: '+path+' '+needle.slice(0,50));write(path,text.replace(needle,value));}
// The pinned CSS imports tailwindcss directly; strict pnpm needs a direct
// dependency, using the exact version already present in the upstream lock.
const packageJson=JSON.parse(read('package.json'));
packageJson.devDependencies.tailwindcss='4.3.0';
write('package.json',JSON.stringify(packageJson,null,2)+'\n');
patch('pnpm-lock.yaml',"    devDependencies:\n      '@commitlint/config-conventional':", "    devDependencies:\n      tailwindcss:\n        specifier: 4.3.0\n        version: 4.3.0\n      '@commitlint/config-conventional':");

mkdirSync(join(root,'greenroom'),{recursive:true});
for(const file of ['server.mjs','media-retention.mjs','native']) cpSync(join(integration,file),join(root,'greenroom',file),{recursive:true});
cpSync(existsSync(join(integration,'generation-error.ts')) ? join(integration,'generation-error.ts') : join(integration,'../../shared/generation-error.ts'),join(root,'greenroom/generation-error.ts'));
cpSync(existsSync(join(integration,'media-storage.mjs')) ? join(integration,'media-storage.mjs') : join(integration,'../../shared/media-storage.mjs'),join(root,'greenroom/media-storage.mjs'));
cpSync(join(integration,'browser.ts'),join(root,'src/greenroom-browser.ts'));
const native='greenroom/native/src';
for(const path of ['models/video_metadata.rs','services/ffmpeg','services/video','utils/ffmpeg_utils.rs','utils/idgen.rs']) {
  mkdirSync(dirname(join(root,native,path)),{recursive:true});cpSync(join(root,'src-tauri/src',path),join(root,native,path),{recursive:true});
}
// A server has software FFmpeg available even when its binary lists unavailable
// hardware encoders; preserve all actual upstream composition filters.
const render=native+'/services/video/manga_renderer.rs';
patch(render,'if stdout.contains("h264_videotoolbox")','if false && stdout.contains("h264_videotoolbox")');
patch(render,'if stdout.contains("h264_nvenc")','if false && stdout.contains("h264_nvenc")');

// The original services stay intact; their persistence calls now reach the
// hydrated member HTTP store instead of browser-local project databases.
function visit(path){for(const item of readdirSync(join(root,path),{withFileTypes:true})){
  const name=join(path,item.name);if(item.isDirectory()){if(!['__tests__','__mocks__'].includes(item.name))visit(name);continue;}
  if(!/\.tsx?$/.test(item.name)||name==='src/greenroom-browser.ts')continue;
  let text=read(name);
  if(/\blocalStorage\b/.test(text)){text=text.replace(/\blocalStorage\b/g,'managedStorage');text="import { managedStorage } from '@/greenroom-browser';\n"+text;write(name,text);}
}}
visit('src');
// Compound Tooltip callers already supply Trigger/Content and their Provider.
// Preserve the Radix Root context and its open-state props instead of a Fragment.
patch('src/components/ui/tooltip.tsx',
 '// If title is provided, use wrapper pattern; otherwise passthrough children',
 '// If title is provided, use wrapper pattern; otherwise use the compound Root');
patch('src/components/ui/tooltip.tsx',
 '  // Passthrough - just render children (parent will handle tooltip structure)\n  return <>{children}</>;',
 '  return <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>;');
// Stable actions keep the original URL-step effect from dispatching on every render.
patch('src/core/hooks/useProject.ts','const setters = createProjectSetters(dispatch);','const setters = useMemo(() => createProjectSetters(dispatch), [dispatch]);');
for (const [path,from,to] of [
 ['src/features/rendering/components/RenderCenter/index.tsx',"model: 'seedream-5.0'","model: managedCatalog.image?.[0]?.id || ''"],
 ['src/core/services/storyboard-service.ts',"options.model ?? 'seedream-5.0'","options.model ?? (managedCatalog.image?.[0]?.id || '')"],
 ['src/core/pipeline/step-script.ts',"config?.model ?? 'glm-5'","config?.model ?? (managedCatalog.llm?.[0]?.id || '')"],
 ['src/core/pipeline/step-render.ts',"model: 'seedream-5.0'","model: managedCatalog.image?.[0]?.id || ''"],
 ['src/core/services/domain/manga-pipeline-types.ts',"'seedream-5.0'","managedCatalog.image?.[0]?.id || ''"],
 ['src/core/services/domain/manga-pipeline-types.ts',"'seedance-2.0'","managedCatalog.video?.[0]?.id || ''"],
 ['src/core/services/ai/text/novel-analyze-config.ts',"config.model ?? 'qwen-3.5'","config.model ?? (managedCatalog.llm?.[0]?.id || '')"],
]) {
 let text=read(path);if(!text.includes(from))throw new Error('Kineo model default changed: '+path);
 text=text.replace(from,to);if(!text.includes("import { managedCatalog } from '@/greenroom-browser'"))text="import { managedCatalog } from '@/greenroom-browser';\n"+text;write(path,text);
}
write('src/greenroom-entry.ts',"import { initializeManaged } from './greenroom-browser';\nawait initializeManaged();\nawait import('./main');\n");
const html=read('index.html');
if(html.split('/src/main.tsx').length!==3)throw new Error('Kineo preload/module entries changed');
write('index.html',html.replaceAll('/src/main.tsx','/src/greenroom-entry.ts'));
patch('src/app/index.tsx',']);',"], { basename: '/plugins/kineo' });");
let vite=read('vite.config.ts');
vite=vite.replace('export default defineConfig({',"export default defineConfig({\n  base: '/plugins/kineo/',");
vite=vite.replace("'@': path.resolve(__dirname, './src'),", "'@': path.resolve(__dirname, './src'),\n      ...Object.fromEntries(['@tauri-apps/api/core', '@tauri-apps/api/tauri', '@tauri-apps/api/event', '@tauri-apps/api/path', '@tauri-apps/api/window', '@tauri-apps/api/dialog', '@tauri-apps/api/fs', '@tauri-apps/api/notification', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs', '@tauri-apps/plugin-store', '@tauri-apps/plugin-notification', '@tauri-apps/api'].map(id => [id, path.resolve(__dirname, './src/greenroom-browser.ts')])),");
write('vite.config.ts',vite);

write('src/core/config/model-catalog.ts',`import { managedCatalog } from '@/greenroom-browser';
import type { AIModel } from '@/core/types';
export const AI_MODELS = Object.entries(managedCatalog).filter(([kind])=>['llm','image','video'].includes(kind)).flatMap(([kind,rows])=>rows.map(row=>({id:row.id,name:row.label,provider:'greenroom',category:[kind==='llm'?'text':kind],description:'管理员托管模型',features:[],contextWindow:0,tokenLimit:0,isAvailable:true,apiConfigured:true}))) as unknown as AIModel[];
`);
write('src/core/config/model-providers.ts',`import { managedCatalog } from '@/greenroom-browser';
export interface ModelProviderInfo { icon?:string; name:string; description:string; website:string; apiUrl:string; id:string }
export const MODEL_PROVIDERS:Record<string,ModelProviderInfo>={greenroom:{id:'greenroom',name:'管理员统一托管',description:'模型与服务凭据由管理员配置',website:'',apiUrl:''}};
export interface VerificationResult { success:boolean; message:string }
export async function verifyModelApiKey(_provider:string,_apiKey:string):Promise<VerificationResult>{throw new Error('API 配置仅由 Greenroom 管理员管理');}
export function hasAnyConfiguredModelProvider(){return Boolean(managedCatalog.llm?.length);}
`);
patch('src/core/hooks/useModel.ts',"useState<string>('glm-5')","useState<string>(AI_MODELS.find(model=>model.category.includes('text'))?.id || '')");
patch('src/core/hooks/useModel.ts',"      'openai',","      'greenroom' as ModelProvider,\n      'openai',");
const recommendations='src/core/config/model-utils.ts';
let recommendationText=read(recommendations);
recommendationText=recommendationText.replace('export const MODEL_RECOMMENDATIONS: Record<string, string[]> = {', 'const ORIGINAL_RECOMMENDATIONS: Record<string, string[]> = {');
recommendationText=recommendationText.replace('// 获取模型配置',"export const MODEL_RECOMMENDATIONS:Record<string,string[]>=Object.fromEntries(Object.keys(ORIGINAL_RECOMMENDATIONS).map(task=>[task,AI_MODELS.filter(model=>model.category.includes(task==='imageGeneration'?'image':task==='videoGeneration'?'video':'text')).map(model=>model.id)]));\n// 获取模型配置");
write(recommendations,recommendationText);
const llm=read('src/core/constants/llm-models.ts');
write('src/core/constants/llm-models.ts',llm.slice(0,llm.indexOf('export const LLM_MODELS'))+`\nimport {managedCatalog} from '@/greenroom-browser';
export const LLM_MODELS:LLMModels=Object.fromEntries((managedCatalog.llm||[]).map(row=>[row.id,{provider:'greenroom',name:row.label,modelId:row.id,version:'managed',category:'text',maxTokens:0,contextWindow:0,supportsStreaming:false,supportsFunctionCalling:row.capabilities?.supports_tools===true,pricing:{input:0,output:0},capabilities:[],recommended:true}]));
export const DEFAULT_LLM_MODEL:LLMModelConfig|undefined=Object.values(LLM_MODELS)[0];
export const MODEL_RECOMMENDATIONS={script:Object.values(LLM_MODELS),analysis:Object.values(LLM_MODELS),translation:Object.values(LLM_MODELS),creative:Object.values(LLM_MODELS),dialogue:Object.values(LLM_MODELS),reasoning:Object.values(LLM_MODELS)};
`);
const ai='src/core/services/ai/text/ai-service.ts';
let aiText=read(ai);aiText="import { managedText } from '@/greenroom-browser';\n"+aiText;
aiText=aiText.replace('    const model = this.getModelById(options.model);','    return (await managedText(prompt, options)).content;\n    const model = this.getModelById(options.model);');
aiText=aiText.replace('    if (this.useMock) {\n      return mockStrategy.call(',"    return managedText(prompt, {model:settings.model || model.id,temperature:settings.temperature,max_tokens:settings.maxTokens});\n    if (this.useMock) {\n      return mockStrategy.call(");
aiText=aiText.replace('MODEL_RECOMMENDATIONS[task] || [DEFAULT_LLM_MODEL]', 'MODEL_RECOMMENDATIONS[task] || (DEFAULT_LLM_MODEL ? [DEFAULT_LLM_MODEL] : [])');
write(ai,aiText);
const stream='src/core/services/ai/text/ai-stream.ts';
patch(stream,'  const strategy = providerRegistry.get(model.provider);',"  const fullText = await fallbackGenerate(); yield fullText; return;\n  const strategy = providerRegistry.get(model.provider);");
const dispatcher='src/core/services/ai/text/ai-call-dispatcher.ts';
let dispatch=read(dispatcher);dispatch="import { managedText } from '@/greenroom-browser';\n"+dispatch;
dispatch=dispatch.replace("  if (!settings?.apiKey", "  return managedText('', {...config,messages:config.messages});\n  if (!settings?.apiKey");write(dispatcher,dispatch);
const imageService=`import {managedImage,managedVideo,request} from '@/greenroom-browser';
export type * from './image-generation/types';
export const isNetworkError=()=>false;
export const generateImage=managedImage,generateVideo=managedVideo;
export async function getVideoStatus(id:string){const task=await request('/tasks/'+encodeURIComponent(id));return {url:task.outputs?.[0]?.url||'',taskId:id,model:task.body?.model,status:task.status==='succeeded'?'completed':task.status==='failed'?'failed':'processing',duration:0,width:0,height:0};}
export const generateWithSeedream=generateImage,generateWithKling=generateImage,generateWithVidu=generateImage,generateVideoWithKling=generateVideo,generateVideoWithVidu=generateVideo,generateVideoWithSeedance=generateVideo;
export const imageGenerationService={generateImage,generateVideo,getVideoStatus,seedream:generateImage,kling:{image:generateImage,video:generateVideo},vidu:{image:generateImage,video:generateVideo},seedance:generateVideo};
export default imageGenerationService;
`;
write('src/core/services/ai/image/image-generation-service.ts',imageService);
const adapter='src/core/services/ai/image/image-generation/adapter.ts';
const adapterText=read(adapter);
write(adapter,"import {managedImage,managedVideo} from '@/greenroom-browser';\n"+adapterText.slice(0,adapterText.indexOf('// ========== Unified Dispatcher'))+`\nexport const generateImage=managedImage;
export const generateVideo=(options:any={})=>managedVideo(options.prompt||'',options);
export const getVideoStatus=async(id:string)=>{const {getVideoStatus}=await import('../image-generation-service');return getVideoStatus(id);};
export const imageGenerationService={generateImage,generateVideo,getVideoStatus,registry:imageGenRegistry};export default imageGenerationService;
`);
for(const [file,functions] of Object.entries({seedream:['generateWithSeedream'],kling:['generateWithKling','generateVideoWithKling'],vidu:['generateWithVidu','generateVideoWithVidu'],seedance:['generateVideoWithSeedance']})){
 write('src/core/services/ai/image/image-generation/providers/'+file+'.ts',"import {managedImage,managedVideo} from '@/greenroom-browser';\n"+functions.map(name=>`export const ${name}=${name.includes('Video')?'managedVideo':'managedImage'};`).join('\n'));
}
write('src/core/services/audio/tts-service.ts',`import {runJob} from '@/greenroom-browser';
export const DEFAULT_TTS_CONFIG:any={provider:'greenroom',voice:'alloy',speed:1,pitch:1,volume:100,format:'audio-24khz-48kbitrate-mono-mp3'};
export const TTS_VOICES:any={greenroom:['alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse','marin','cedar'].map(id=>({id,name:id,provider:'greenroom',language:'多语言',gender:'neutral'}))};
class TTSService {
getVoices(provider:string){return TTS_VOICES[provider]||[];}getAllVoices(){return TTS_VOICES.greenroom;}getVoiceById(id:string){return this.getAllVoices().find((voice:any)=>voice.id===id);}
async synthesize(request:any){if(request.config.provider!=='greenroom')throw new Error('原 TTS Provider 未接入，现仅支持管理员托管语音');if(request.config.pitch!=null && request.config.pitch!==1)throw new Error('当前托管语音不支持调整音调，请设为 1.0');let task:any;try{task=await runJob('tts',{projectId:request.projectId,text:request.text,voice:request.config.voice,speed:request.config.speed,response_format:'mp3'},request.signal);}catch(error:any){throw new Error((error?.message||'语音任务失败')+(error?.taskId?'；原任务编号 '+error.taskId+'，请先查询原任务，勿重复提交':'')+(/Neural$/.test(request.config.voice||'')?'；当前为旧 Edge 音色，如模型不支持可在角色设置中重新选择':''));}try{const response=await fetch(task.outputs[0].url);if(!response.ok)throw new Error('HTTP '+response.status);const audio=await response.arrayBuffer();const context=new AudioContext();try{const decoded=await context.decodeAudioData(audio.slice(0));return {audio,duration:decoded.duration,size:audio.byteLength,format:'mp3',url:task.outputs[0].url};}finally{await context.close();}}catch(error:any){throw new Error('语音产物读取失败：'+(error?.message||'服务商未返回具体失败原因')+'；原任务编号 '+task.id+'，请先查询原任务，勿重复提交');}}
async *streamSynthesize(request:any){const value=await this.synthesize(request);yield {audio:value.audio,isFinal:true};}
cancelRequest(){}async saveAudio(audio:ArrayBuffer,filename:string){const anchor=document.createElement('a');anchor.href=URL.createObjectURL(new Blob([audio],{type:'audio/mpeg'}));anchor.download=filename;anchor.click();URL.revokeObjectURL(anchor.href);}}
export const ttsService=new TTSService();export default ttsService;
`);
write('src/core/services/audio/tts-types.ts',"export {DEFAULT_TTS_CONFIG} from './tts-service';\n");
const sceneAudio='src/core/services/domain/manga-pipeline-stage-audio.ts';
patch(sceneAudio,'    await ttsService.synthesize({','    const generatedAudio = await ttsService.synthesize({');
patch(sceneAudio,'    pipelineScenes[i].audioUrl = TTS_AUDIO_URL_PREFIX + i;','    pipelineScenes[i].audioUrl = (generatedAudio as any).url;');
patch('src/core/services/audio/audio-pipeline-service.ts',"        const blob = new Blob([response.audio], { type: 'audio/mp3' });\n",'');
patch('src/core/services/audio/audio-pipeline-service.ts','const fileUrl = URL.createObjectURL(blob);','const fileUrl = (response as any).url;');
patch('src/core/services/audio/audio-pipeline-service.ts','const voices = TTS_VOICES.edge;','const voices = TTS_VOICES.greenroom;');
patch('src/core/services/audio/audio-pipeline-service.ts','ttsService.synthesize({ text: line.text, config })','ttsService.synthesize({ text: line.text, config, projectId: options.projectId })');
patch('src/core/services/audio/audio-pipeline-service.ts','      } catch {\n        failedLines.push(line);','      } catch (error) {\n        failedLines.push({ ...line, error: error instanceof Error ? error.message : \'服务商未返回具体失败原因\' });');
patch('src/core/services/audio/audio-pipeline-service.ts','  index: number;\n}', '  index: number;\n  error?: string;\n}');
patch('src/pages/project-edit/context/useProjectEditActions.ts','`已生成 ${result.voiceTracks.length} 条配音，${result.failedLines.length} 条失败`','`已生成 ${result.voiceTracks.length} 条配音；失败：${result.failedLines.map(line => `${line.speaker}：${line.error}`).join(\'；\')}`');
write('src/core/services/data-bus/AssetPersistenceBridge.ts',`import {uploadFile,convertFileSrc,managedStorage} from '@/greenroom-browser';
export interface PersistedAssetMeta{id:string;projectId:string;fileName:string;mimeType:string;sizeBytes:number;uri:string;localDiskPath?:string;createdAt:string;}
class AssetPersistenceBridge {
isTauriEnv(){return true;}
async persistAsset(projectId:string,assetId:string,data:string|Blob|Uint8Array,options:any={}):Promise<PersistedAssetMeta>{
 const mimeType=options.mimeType||'application/octet-stream';
 let blob:Blob;
 if(typeof data==='string'){const response=await fetch(data.startsWith('/files/')?convertFileSrc(data):data);if(!response.ok)throw new Error('生成素材读取失败 (HTTP '+response.status+')');blob=await response.blob();}
 else blob=data instanceof Blob?data:new Blob([data as BlobPart],{type:mimeType});
 const fileName=options.fileName||assetId+'.bin';const path=await uploadFile(blob,fileName);
 const meta={id:assetId,projectId,fileName,mimeType,sizeBytes:blob.size,uri:convertFileSrc(path),localDiskPath:path,createdAt:new Date().toISOString()};
 managedStorage.setItem('kineo-asset:'+projectId+':'+assetId,JSON.stringify(meta));return meta;}
async resolveAssetUri(projectId:string,assetId:string,fallbackUri=''){const value=managedStorage.getItem('kineo-asset:'+projectId+':'+assetId);return value?JSON.parse(value).uri:fallbackUri;}
}
export const assetPersistenceBridge=new AssetPersistenceBridge();export default assetPersistenceBridge;
`);
const unified='src/core/services/ai/image/UnifiedImageGenerator.ts';
let unifiedText=read(unified);const unifiedStart=unifiedText.indexOf('    const assetId =');const unifiedEnd=unifiedText.indexOf('\n  /**',unifiedStart);
if(unifiedStart<0||unifiedEnd<0)throw new Error('Kineo scene image entry changed');
unifiedText=unifiedText.slice(0,unifiedStart)+`    const assetId = \`img_\${sceneId}_\${Date.now()}\`;
    const result = await generateImage(prompt, {style:'anime',quality:'standard',projectId,frameId:sceneId});
    if (!result?.url && !result?.base64) throw new Error('服务商未返回图像产物');
    const meta = await assetPersistenceBridge.persistAsset(projectId,assetId,result.base64 || result.url,{fileName:\`frame_\${sceneId}.png\`,mimeType:'image/png'});
    return {localDiskPath:meta.localDiskPath || meta.uri,uri:meta.uri};
  }
`+unifiedText.slice(unifiedEnd);write(unified,unifiedText);
const queueRunner='src/core/services/project/render-queue-runner.ts';
let queueText=read(queueRunner);if(!queueText.includes('      model: job.model,'))throw new Error('Kineo queue submission entry changed');
queueText=queueText.replace('      model: job.model,',"      model: job.model,projectId:job.projectId,frameId:job.frameId,submissionId:'kineo:render:'+job.id,");
const fallbackStart=queueText.indexOf('    // 回退为占位图');const fallbackEnd=queueText.indexOf('\n  }\n}',fallbackStart);
if(fallbackStart<0||fallbackEnd<0)throw new Error('Kineo render failure branch changed');
queueText=queueText.slice(0,fallbackStart)+`    deps.patchJob(job.id,{status:'failed',progress:0,error:error instanceof Error?error.message:'服务商未返回具体失败原因',finishedAt:nowIso()});`+queueText.slice(fallbackEnd);write(queueRunner,queueText);
patch('src/core/services/project/render-queue-service.ts',
 "      if (job.id !== jobId) return job;\n      return {\n        ...job,",
 "      if (job.id !== jobId) return job;\n      return {\n        ...job,\n        id: generateJobId(0),");
// Explicitly reject every original stub instead of silently calling another provider.
const stub='src/core/services/audio/tts-providers/stubs.ts';
const stubText=read(stub);const stubNames=[...stubText.matchAll(/export (?:(?:async )?function|const) (\w+)/g)].map(match=>match[1]);
write(stub,stubNames.map(name=>`export async function ${name}(..._args:any[]):Promise<any>{throw new Error('此原生 TTS 占位能力尚未接入');}`).join('\n'));
const autoVoice='src/core/services/audio/AutoVoiceSynthesizer.ts';
// New characters must use the same managed defaults as the voice picker.
// Existing character data is retained; unsupported historical choices can be
// explicitly replaced by the member rather than silently changing their voice.
patch('src/core/script/types/novel.ts', "provider: 'edge' | 'azure'", "provider: 'greenroom' | 'edge' | 'azure'");
for(const source of ['src/core/services/agent/HierarchicalScriptParser.ts','src/core/services/agent/CharacterDesignerAgent.ts','src/core/services/agent/SoundEngineerAgent.ts']) {
  const text=read(source);
  if(!text.includes("'zh-CN-YunxiNeural'") || !text.includes("'zh-CN-XiaoxiaoNeural'"))throw new Error('Kineo character voice defaults changed: '+source);
  write(source,text.replaceAll("'zh-CN-YunxiNeural'","'alloy'").replaceAll("'zh-CN-XiaoxiaoNeural'","'nova'").replaceAll("provider: 'edge'","provider: 'greenroom'").replace('pitch: idx === 0 ? 0 : 5','pitch: 1').replace('pitch: isProtagonist ? 0 : 4','pitch: 1'));
}
patch('src/core/services/agent/CharacterDesignerAgent.ts', '        voice: {\n          provider:', `        ...(ac.voiceId ? { voiceId: ac.voiceId } : {}),
        ...(ac.voicePitch != null ? { voicePitch: ac.voicePitch } : {}),
        ...(ac.voiceSpeed != null ? { voiceSpeed: ac.voiceSpeed } : {}),
        voice: ac.voice || {
          provider:`);
let voiceText=read(autoVoice);
voiceText=voiceText.replaceAll("'zh-CN-YunjianNeural'","'onyx'").replaceAll("'zh-CN-XiaoxiaoNeural'","'nova'").replaceAll("'zh-CN-YunxiNeural'","'alloy'").replaceAll("provider: 'edge'","provider: 'greenroom' as any");
const catalogStart=voiceText.indexOf('export const MANGA_VOICE_CATALOG: MangaVoiceProfile[] = [');
const catalogEnd=voiceText.indexOf('\n];',catalogStart);
if(catalogStart<0||catalogEnd<0)throw new Error('Kineo voice catalog changed');
voiceText=voiceText.slice(0,catalogStart)+`export const MANGA_VOICE_CATALOG: MangaVoiceProfile[] = ['alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse','marin','cedar'].map(id => ({id,name:id,gender:'neutral',style:'托管音色，实际可用性由所选模型决定',previewSample:'这就是我的漫剧配音，听起来怎么样？'}));`+voiceText.slice(catalogEnd+3);
voiceText=voiceText.replace("gender: 'male' | 'female';", "gender: 'male' | 'female' | 'neutral';");
voiceText=voiceText.replace("genderOrVoiceId && genderOrVoiceId.includes('Neural')", "genderOrVoiceId && !['male','female','unknown'].includes(genderOrVoiceId)");
voiceText=voiceText.replace('const pitch = customTuning?.pitch ?? (isActionCue ? 1.05 : 1.0);','const pitch = customTuning?.pitch ?? 1.0;');
const retryStart=voiceText.indexOf('      let lastErr: unknown;');
const retryEnd=voiceText.indexOf('      const audioBuffer = new Uint8Array(response.audio);',retryStart);
if(retryStart<0||retryEnd<0)throw new Error('Kineo voice submission entry changed');
voiceText=voiceText.slice(0,retryStart)+`      const response = await ttsService.synthesize({text:trimmed,projectId,config:{provider:'greenroom',voice,speed,pitch,volume:1.0,format:'audio-24khz-48kbitrate-mono-mp3'}});\n\n`+voiceText.slice(retryEnd);
voiceText=voiceText.replace("      const estimatedDuration = Math.max(2.0, trimmed.length * 0.28);\n",'');
voiceText=voiceText.replace('      return this.generateSilentAudio(projectId, sceneId, estimatedDuration);','      throw err;');
voiceText=voiceText.replace("      const silentRes = await this.generateSilentAudio('temp_audition', `audition_${Date.now()}`, 1.5);\n      return { audioUri: silentRes.audioUri, duration: 1.5 };",'      throw err;');
voiceText=voiceText.replace('在线 TTS 合成异常，回退生成保底音频','托管语音合成失败');
voiceText=voiceText.replace('      // Fallback: 构造简短的提示音\n','');
voiceText=voiceText.replace('const cacheKey = this.getCacheKey(trimmed, voice, speed, pitch);',"const cacheKey = projectId + ':' + sceneId + ':' + this.getCacheKey(trimmed, voice, speed, pitch);");
write(autoVoice,voiceText);
const characterDesigner='src/features/character-consistency/components/CharacterDesigner.tsx';
let characterText=read(characterDesigner).replaceAll("'zh-CN-XiaoxiaoNeural'","'nova'").replaceAll("'zh-CN-YunxiNeural'","'alloy'");
characterText=characterText.replace('角色专属 Edge-TTS 神经网络音色库','管理员托管音色');
characterText=characterText.replace("provider: 'edge',", "provider: 'greenroom',");
characterText=characterText.replace("{gender === 'female' ? '推荐女性音色' : '推荐男性音色'}",'实际可用性由模型决定');
characterText=characterText.replace("const isGenderMatch = (gender === 'female' && vc.gender === 'female') || (gender !== 'female' && vc.gender === 'male');",'const isGenderMatch = false;');
characterText=characterText.replace('发音音调 (Pitch)','音调（暂不支持，请设为 1.0）');
characterText=characterText.replace('{/* 音色卡片网格选择 */}',`{!MANGA_VOICE_CATALOG.some(voice => voice.id === voiceId) && <p role="status">当前角色保留历史音色 {voiceId}；如托管模型不支持，请在下方重新选择并保存。</p>}
                    {/* 音色卡片网格选择 */}`);
write(characterDesigner,characterText);
// The public package's inspirational example was simulated text. Route that
// specific operation to an actual managed model and retain its native parser.
const engine='packages/ai-engine/src/index.tsx';
let engineText=read(engine);engineText="import {invoke} from '@/greenroom-browser';\n"+engineText;
const generateStart=engineText.indexOf('export async function generateScriptFromIdea(');
if(generateStart<0)throw new Error('Kineo script generator entry changed');
engineText=engineText.slice(0,generateStart)+`export async function generateScriptFromIdea(idea:string,episodes=1,stylePreset:ArtStylePreset='modern_anime'):Promise<ScriptParseResult>{return invoke('generate_script_from_idea',{idea,episodes,stylePreset});}\n`;
write(engine,engineText);
const settings='src/pages/settings/SettingsPage.tsx';
let settingsText=read(settings);const start=settingsText.indexOf('      {/* 第一区:');const end=settingsText.indexOf('      {/* 第二区:');
if(start<0||end<0)throw new Error('Kineo settings sections changed');
settingsText=settingsText.slice(0,start)+`      <div className="studio-card p-6">模型、API 和工作目录由 Greenroom 管理员统一管理。创作工程保存在成员自己的服务端空间。</div>\n`+settingsText.slice(end);
settingsText=settingsText.replace('配置文字大模型、AI 图像生成模型、AI 视频运镜模型与 TTS 语音 API 密钥','查看成员工程与创作偏好');
settingsText=settingsText.replace('value={workingDir}','value="成员私有工程空间" disabled');write(settings,settingsText);

write('src/features/model-selector/components/ModelConfigGuardModal.tsx',`export const ModelConfigGuardModal=({isOpen,onClose}:any)=>isOpen?<div role="dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"><div className="studio-card p-6"><p>暂无已启用的托管文本模型，请联系 Greenroom 管理员配置。</p><button onClick={onClose}>关闭</button></div></div>:null;export default ModelConfigGuardModal;`);

// Browsing/manual editing/native FFmpeg export do not require a text model.
// The actual AI actions and server-side managed capability checks stay intact.
const stepNavigation='src/pages/project-edit/components/StepNavigation.tsx';
patch(stepNavigation,"import ModelConfigGuardModal from '@/features/model-selector/components/ModelConfigGuardModal';\n",'');
patch(stepNavigation,"import { toast } from '@/components/ui/toast';\n",'');
patch(stepNavigation,"import { hasAnyConfiguredModelProvider } from '@/core/config/model-providers';\n",'');
patch(stepNavigation,'  const [isModelGuardOpen, setIsModelGuardOpen] = useState(false);\n','');
const navigationGate=`    // 门禁校验：进入 AI 步骤前检查 API Key 配置
    if (index >= 1 && !hasAnyConfiguredModelProvider()) {
      toast.error('⚠️ 未检测到有效 AI 模型 API Key！无法使用 AI 增强服务。');
      setIsModelGuardOpen(true);
      return;
    }

`;
patch(stepNavigation,navigationGate,'');
patch(stepNavigation,`      <ModelConfigGuardModal
        isOpen={isModelGuardOpen}
        onClose={() => setIsModelGuardOpen(false)}
      />`,'');

// Studio hands the original script/scenes/frames to createProject; keep those
// ProjectData fields while retaining the native defaults and generated identity.
patch('src/stores/slices/projectSlice.ts',
 '      const project: ProjectData = {\n        id: partial.id || uuidv4(),',
 '      const project: ProjectData = {\n        ...partial,\n        id: partial.id || uuidv4(),');

// The pinned Studio mock must not substitute demo images for managed work.
const studioEditor='src/features/storyboard/components/StoryboardEditor.tsx';
let studio=read(studioEditor);
studio=studio.replace("import React, { useState, useEffect } from 'react';", "import React, { useState, useEffect, useRef } from 'react';\nimport { managedImage } from '@/greenroom-browser';\nimport {editorFrameId,rememberEditorView} from '@/greenroom-editor-project';\nimport { formatGenerationError } from '../../../../greenroom/generation-error';");
const demoStart=studio.indexOf('const DEFAULT_DEMO_FRAMES: StoryboardFrame[] = [');
const demoEnd=studio.indexOf('\nexport const StoryboardEditor:',demoStart);
if(demoStart<0||demoEnd<0)throw new Error('Kineo Studio demo anchor changed');
studio=studio.slice(0,demoStart)+studio.slice(demoEnd);
studio=studio.replace('  initialFrames,\n  focusFrameId,','  projectId,\n  initialFrames,\n  focusFrameId,');
studio=studio.replace('onChange?: (frames: StoryboardFrame[]) => void;', 'onChange?: (frames: StoryboardFrame[]) => void | Promise<void>;');
studio=studio.replace('    return DEFAULT_DEMO_FRAMES;', '    return [];');
studio=studio.replace("return frames[0]?.id || 'frame-1';", "return frames[0]?.id || '';");
studio=studio.replace('    if (focusFrameId && frames.some((f) => f.id === focusFrameId)) return focusFrameId;',
 "    const remembered = editorFrameId(projectId);\n    if (remembered && frames.some(f => f.id === remembered)) return remembered;\n    if (focusFrameId && frames.some((f) => f.id === focusFrameId)) return focusFrameId;");
studio=studio.replace(' || DEFAULT_DEMO_FRAMES[0]', '');
studio=studio.replace('    if (initialFrames && initialFrames.length > 0) {', '    if (initialFrames) {');
studio=studio.replace('setSelectedFrameId(initialFrames[0].id);', "setSelectedFrameId(initialFrames[0]?.id || '');");
const hydrateStart=studio.indexOf('  useEffect(() => {');
const hydrateEnd=studio.indexOf('\n  const updateSelectedFrame',hydrateStart);
if(hydrateStart<0||hydrateEnd<0)throw new Error('Kineo Studio hydration anchor changed');
studio=studio.slice(0,hydrateStart)+`  useEffect(() => {
    if (initialFrames) {
      setFrames(initialFrames);
      const requested = editorFrameId(projectId) || focusFrameId;
      setSelectedFrameId(current => initialFrames.some(frame => frame.id === current) ? current : initialFrames.find(frame => frame.id === requested)?.id || initialFrames[0]?.id || '');
    }
  }, [initialFrames, projectId, focusFrameId]);
  useEffect(() => {
    if (selectedFrame || selectedFrameId) rememberEditorView(projectId, {frameId: selectedFrame?.id || null});
  }, [projectId, selectedFrame?.id, selectedFrameId]);
`+studio.slice(hydrateEnd);

studio=studio.replace('  const updateSelectedFrame = (updates: Partial<StoryboardFrame>) => {', '  const updateSelectedFrame = async (updates: Partial<StoryboardFrame>) => {\n    if (!selectedFrame || generationRunning.current) return;');
studio=studio.replace('    onChange?.(updated);', '    try { await onChange?.(updated); } catch (error) { const reason = formatGenerationError(error); setGenerationError(reason); toast.error(reason); }');
const generationStart=studio.indexOf('  const handleGenerateFrameImage = () => {');
const generationEnd=studio.indexOf('\n  const handleSaveDesign',generationStart);
if(generationStart<0||generationEnd<0)throw new Error('Kineo Studio generation anchor changed');
studio=studio.slice(0,generationStart)+`  const generationRunning = useRef(false);
  const latestFrames = useRef(frames);
  latestFrames.current = frames;
  const [generationError, setGenerationError] = useState('');
  const handleGenerateFrameImage = async () => {
    if (generationRunning.current) return;
    if (!projectId || !selectedFrame || !selectedFrame.sceneDescription.trim()) {
      setGenerationError('请先保存当前工程和分镜提示词');
      return;
    }
    const frameId = selectedFrame.id;
    generationRunning.current = true;
    setIsGenerating(true);
    setGenerationError('');
    try {
      await onChange?.(latestFrames.current);
      const result = await managedImage(selectedFrame.sceneDescription, { projectId, frameId });
      const updated = latestFrames.current.map(frame => frame.id === frameId ? { ...frame, imageUrl: result.url } : frame);
      setFrames(updated);
      await onChange?.(updated);
      toast.success('分镜图片已生成并保存');
    } catch (error) {
      const reason = formatGenerationError(error);
      setGenerationError(reason);
      toast.error(reason);
    } finally {
      generationRunning.current = false;
      setIsGenerating(false);
    }
  };
`+studio.slice(generationEnd);
const saveStart=studio.indexOf('  const handleSaveDesign = () => {');
const saveEnd=studio.indexOf('\n  return (',saveStart);
if(saveStart<0||saveEnd<0)throw new Error('Kineo Studio save anchor changed');
studio=studio.slice(0,saveStart)+`  const handleSaveDesign = async () => {
    try {
      await onChange?.(latestFrames.current);
      toast.success('分镜设计已保存');
    } catch (error) {
      const reason = formatGenerationError(error);
      setGenerationError(reason);
      toast.error(reason);
    }
  };
`+studio.slice(saveEnd);
studio=studio.replace('  return (\n    <div className="space-y-4">', '  if (!selectedFrame) return <div role="status">暂无分镜，请先导入或创建真实分镜。</div>;\n  return (\n    <div className="space-y-4">\n      {generationError && <div role="alert">{generationError}</div>}');
studio=studio.replaceAll(" || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&q=80'",' || undefined');
studio=studio.replace('              value={selectedFrame.sceneDescription}', '              disabled={isGenerating}\n              value={selectedFrame.sceneDescription}');
studio=studio.replace('                onClick={handleGenerateFrameImage}', '                disabled={isGenerating}\n                onClick={handleGenerateFrameImage}');
studio=studio.replace('当前编辑: {selectedFrame.title} (3840x2160 Ultra-HD 4K)', '当前编辑: {selectedFrame.title}（实际尺寸以产物为准）');
studio=studio.replace('onClick={handleSaveDesign}', 'disabled={isGenerating} onClick={handleSaveDesign}');
write(studioEditor,studio);
// Connect the existing editor to the same member project and persisted store.
cpSync(join(integration,'editor-project.ts'),join(root,'src/greenroom-editor-project.ts'));
for(const file of ['src/features/agent/components/MultiAgentStudio.tsx','src/core/services/data-bus/ProjectBlackboardStoreBridge.ts']) {
  write(file,"import {editorFrames} from '@/greenroom-editor-project';\n"+read(file));
}
patch('src/features/agent/components/MultiAgentStudio.tsx','      storyboardFrames: data.scenes,',
 "      storyboardFrames: editorFrames(data.scenes, store.projects.find(p => p.id === data.projectId)?.storyboardFrames || []),");
patch('src/core/services/data-bus/ProjectBlackboardStoreBridge.ts','      storyboardFrames: data.scenes as any,',
 "      storyboardFrames: editorFrames(data.scenes, store.getState().projects.find(p => p.id === projectId)?.storyboardFrames || []),");
const loader='src/pages/project-edit/hooks/useProjectLoader.ts';
patch(loader,'export interface ProjectLoadResult {','export interface ProjectLoadResult {\n  projectId: string;');
patch(loader,
 "          storeState.projects.find((p) => String(p.id) === String(projectId)) ||\n          storeState.currentProject;",
 "          storeState.projects.find((p) => String(p.id) === String(projectId));");
write(loader,read(loader).replaceAll('          setData({','          setData({\n            projectId,'));
const provider='src/pages/project-edit/context/ProjectEditContext.tsx';
patch(provider,'useContext, useEffect, useMemo','useContext, useEffect, useLayoutEffect, useRef, useCallback, useMemo');
patch(provider,"import { useProject } from '@/core/hooks/useProject';",
 "import {useProjectStore} from '@/stores';\nimport {flushProjectStorage} from '@/stores/project/project-store';\nimport {editorFrames,rememberEditorView} from '@/greenroom-editor-project';\nimport type {StoryboardFrame} from '@/core/storyboard/types/storyboard';");
patch(provider,'  children: React.ReactNode;','  projectId: string;\n  children: React.ReactNode;');
patch(provider,'    content?: string;','    projectId: string;\n    storyboardFrames?: unknown[];\n    storyboardComments?: any[];\n    storyboardVersions?: any[];\n    content?: string;');
patch(provider,'export function ProjectEditProvider({\n  children,','export function ProjectEditProvider({\n  projectId,\n  children,');
patch(provider,'  const { project, setSaving, setCurrentStep, updateProject } = useProject();',`  const project = useProjectStore(s => s.projects.find(p => p.id === projectId)) || null;
  const [, setSaving] = useState(false);
  const [currentStep, setCurrentStepState] = useState(initialData?.initialStep ?? 1);
  const setCurrentStep = useCallback((step: number) => {
    if (!Number.isInteger(step) || step < 0 || step > 3) return;
    setCurrentStepState(step);
    rememberEditorView(projectId, {step});
  }, [projectId]);
  const updateProject = useCallback((updates: Record<string, unknown>) => {
    const store = useProjectStore.getState();
    const existing = store.projects.find(p => p.id === projectId);
    if (!existing) throw new Error('原工程不存在，不能保存到其它工程');
    store.updateProject(projectId, updates);
    if (store.currentProject?.id === projectId) store.setCurrentProject({...existing,...updates});
  }, [projectId]);`);
patch(provider,'  // ─── State',`  const editorOwner = useRef<{projectId: string} | null>(null);
  const hydratedProject = useRef<string | null>(null);
  useLayoutEffect(() => {
    const owner = {projectId}; editorOwner.current = owner;
    return () => { if (editorOwner.current === owner) editorOwner.current = null; };
  }, [projectId]);
  useLayoutEffect(() => {
    if (!initialData || initialData.projectId !== projectId) return;
    const state = useStoryboard.getState();
    const frames = editorFrames(initialData.storyboardFrames || []);
    const selectedId = hydratedProject.current === projectId ? state.selectedFrame?.id : undefined;
    hydratedProject.current = projectId;
    state.setFrames(frames);
    state.selectFrame(frames.find(frame => frame.id === selectedId) || null);
    state.setComments(initialData.storyboardComments || []);
    state.setVersions(initialData.storyboardVersions || []);
    state.setCompareLeft(undefined); state.setCompareRight(undefined); state.setVersionDiff(null);
  }, [projectId, initialData]);
  const saveFrames = useCallback(async (frames: StoryboardFrame[]) => {
    const owner = editorOwner.current;
    if (!owner || owner.projectId !== projectId) throw new Error('工程已切换，未执行后续操作');
    updateProject({storyboardFrames: frames});
    await flushProjectStorage();
    if (editorOwner.current !== owner) throw new Error('原工程已保存，但页面已切换，未执行后续操作');
    const state = useStoryboard.getState();
    const selectedId = state.selectedFrame?.id;
    state.setFrames(frames);
    state.selectFrame(frames.find(frame => frame.id === selectedId) || null);
  }, [projectId, updateProject]);

  // ─── State`);
patch(provider,'      actions,\n    }),','      actions: {...actions, saveFrames},\n      navigation: {currentStep, setCurrentStep},\n    }),');
patch(provider,'      actions,\n    ]','      actions, saveFrames, currentStep, setCurrentStep,\n    ]');
const types='src/pages/project-edit/context/project-edit-state.ts';
write(types,"import type {StoryboardFrame} from '@/core/storyboard/types/storyboard';\n"+read(types));
patch(types,'export interface ProjectEditActions {','export interface ProjectEditActions {\n  saveFrames: (frames: StoryboardFrame[]) => Promise<void>;');
patch(types,'export interface ProjectEditContextValue {','export interface ProjectEditContextValue {\n  navigation: {currentStep: number; setCurrentStep: (value: number) => void};');
const actions='src/pages/project-edit/context/useProjectEditActions.ts';
write(actions,"import {flushProjectStorage,useProjectStore} from '@/stores/project/project-store';\n"+read(actions));
patch(actions,'): ProjectEditActions {',"): Omit<ProjectEditActions, 'saveFrames'> {");
patch(actions,'      const projectData = {\n        id:', '      const projectData = {\n        ...project,\n        id:');
patch(actions,'storyboardFrames: storyboard.frames.length > 0 ? storyboard.frames : undefined','storyboardFrames: storyboard.frames');
patch(actions,'storyboardComments: storyboard.comments.length > 0 ? storyboard.comments : undefined','storyboardComments: storyboard.comments');
patch(actions,'storyboardVersions: storyboard.versions.length > 0 ? storyboard.versions : undefined','storyboardVersions: storyboard.versions');
patch(actions,'        script: scriptTextRef.current || undefined,',"        script: scriptTextRef.current || (project as any)?.script || undefined,");
patch(actions,"      toast.success('项目保存成功');\n      updateProject(projectData as Parameters<typeof updateProject>[0]);",
 "      updateProject(projectData as Parameters<typeof updateProject>[0]);\n      await flushProjectStorage();\n      toast.success('项目保存成功');");
patch('src/pages/project-edit/context/selectors.ts','    onFramesChange: storyboard.setFrames,','    onFramesChange: actions.saveFrames,');
const page='src/pages/project-edit/ProjectEditPage.tsx';
patch(page,"import { useProject } from '@/core/hooks/useProject';", "import {useProjectEdit} from './context/ProjectEditContext';");
patch(page,'  const { currentStep, setCurrentStep } = useProject();','  const {navigation: {currentStep, setCurrentStep}, actions} = useProjectEdit();');
patch(page,'      const parsed = parseInt(stepParam, 10);\n      if (!isNaN(parsed) && parsed >= 0 && parsed <= 3) {',
 '      const parsed = Number(stepParam);\n      if (/^[0-3]$/.test(stepParam)) {');
patch(page,"onClick={() => toast.success('分镜工程与设置已自动同步存库！')}","onClick={() => void actions.saveProject()}");
patch(page,'  return (\n    <ProjectEditProvider projectMetadata={projectMetadata} initialData={loaderData}>',
 '  if (!projectId || !loaderData || loaderData.projectId !== projectId) return <p role="status">正在加载原工程…</p>;\n  return (\n    <ProjectEditProvider key={projectId} projectId={projectId} projectMetadata={projectMetadata} initialData={loaderData}>');
for(const name of ['StepScript','StepRender','StepCharacter','StepStoryboard','StepImport','StepAudio','StepExport','StepAnalysis','StepComposition']) {
 const file='src/pages/project-edit/components/'+name+'.tsx';
 patch(file,"import { useProject } from '@/core/hooks/useProject';", "import {useProjectEdit as useManagedProjectEdit} from '../context/ProjectEditContext';");
 patch(file,'  const { setCurrentStep } = useProject();','  const {navigation: {setCurrentStep}} = useManagedProjectEdit();');
}
patch('src/pages/project-edit/components/StepStoryboard.tsx',
 "import React, { Suspense, lazy } from 'react';",
 "import React, { Suspense, lazy } from 'react';\nimport {useParams} from 'react-router-dom';");
patch('src/pages/project-edit/components/StepStoryboard.tsx','            initialFrames={storyboardFrames}', '            projectId={projectId}\n            initialFrames={storyboardFrames}');

patch('src/pages/project-edit/components/StepStoryboard.tsx','function StepStoryboard() {','function StepStoryboard() {\n  const {projectId} = useParams();');
patch('src/pages/project-edit/components/StepStoryboard.tsx',"key={`${storyboardFrames.length}-${storyboardFrames[0]?.id || 'none'}`}", 'key={projectId}');
const projectStore='src/stores/project/project-store.ts';
patch(projectStore,"import { managedStorage } from '@/greenroom-browser';", "import {managedStorage,flushManagedStorage} from '@/greenroom-browser';");
patch(projectStore,'export const useProjectStore = create<ProjectState>()(',`const projectStorage = createDebouncedStorage(managedStorage, 1500);
export async function flushProjectStorage() {
  projectStorage.getItem('kineo-project-storage-v2');
  await flushManagedStorage();
}
export const useProjectStore = create<ProjectState>()(`);
patch(projectStore,'storage: createJSONStorage(() => createDebouncedStorage(managedStorage, 1500)),','storage: createJSONStorage(() => projectStorage),');
patch(loader,'          const project = JSON.parse(projectText) as ProjectEditData;', "          const project = JSON.parse(projectText) as ProjectEditData;\n          if (project.id !== projectId) throw new Error('原工程不存在');");
for (const variable of ['parsedStep','nextStep']) {
 patch(loader,`          if (frameId) {
            initialStep = 1;
          } else if (stepValue) {
            const ${variable} = Number(stepValue);
            if (Number.isInteger(${variable}) && ${variable} >= 0 && ${variable} <= 3) {
              initialStep = ${variable};
            }
          }`, `          if (stepValue !== null && /^[0-3]$/.test(stepValue)) initialStep = Number(stepValue);`);
}
const missingStart=read(loader).indexOf('            const search = new URLSearchParams(location.search);',read(loader).indexOf('        .catch(() => {'));
const missingEnd=read(loader).indexOf('            setError(null);',missingStart);
if(missingStart<0||missingEnd<0)throw new Error('Kineo missing-project fallback changed');
write(loader,read(loader).slice(0,missingStart)+"            setData(null);\n            setError('原工程无法读取，请返回后重试');"+read(loader).slice(missingEnd+'            setError(null);'.length));
patch(page,'export const ProjectEditPage = () => {\n  const { projectId } = useParams();\n  const { data: loaderData } = useProjectLoader(projectId);',
 'export const ProjectEditPage = () => {\n  const { projectId } = useParams();\n  const { data: loaderData, error } = useProjectLoader(projectId);');
patch(page,'  if (!projectId || !loaderData || loaderData.projectId !== projectId)', '  if (error) return <p role="alert">{error}</p>;\n  if (!projectId || !loaderData || loaderData.projectId !== projectId)');

// Initial data is already loaded before mounting; do not let a deferred old step
// overwrite a user's first navigation click.
patch(provider,'    const timer = setTimeout(() => {','    {');
patch(provider,'    }, 0);\n    return () => clearTimeout(timer);','    }');

patch(actions,'  const saveProject = useCallback(async () => {\n    try {',`  const saveProject = useCallback(async () => {
    try {
      if (!project?.id || !useProjectStore.getState().projects.some(row => row.id === project.id)) {
        throw new Error('原工程不存在，未执行保存');
      }`);

// Replace only the confirmed toast-only export entry; use the fixed native renderer.
cpSync(join(integration,'editor-export.mjs'),join(root,'src/greenroom-editor-export.mjs'));
cpSync(join(integration,'ManagedFrameExport.tsx'),join(root,'src/ManagedFrameExport.tsx'));
const audioStep='src/pages/project-edit/components/StepAudio.tsx';
patch(audioStep,"import React from 'react';", "import React from 'react';\nimport ManagedFrameExport from '@/ManagedFrameExport';");
patch(audioStep,"import ManagedFrameExport from '@/ManagedFrameExport';", "import ManagedFrameExport from '@/ManagedFrameExport';\nimport { AutoVoiceSynthesizer } from '@/core/services/audio/AutoVoiceSynthesizer';");
patch(audioStep,'          <AudioStudio />',`          <AudioStudio onSynthesizeTTS={async (text, voice) => {
            try {
              const result = await AutoVoiceSynthesizer.auditionVoice(voice, text);
              await new Audio(result.audioUri).play();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : '语音试听失败');
            }
          }} />`);
patch(audioStep,'阶段 4: 声音后期与 4K 音画同轴压制导出','阶段 4: 声音后期与图帧导出');
patch(audioStep,'支持 EdgeTTS / CosyVoice 多角色对白合成，毫秒级音轨对齐、BGM 背景音效与 4K Ultra-HD 视频导出','原工程图帧与配音导出；下方演示音轨面板尚未接入工程保存');
const audioStudio='packages/audio-studio/src/index.tsx';
patch(audioStudio,"  onSynthesizeTTS?: (text: string, voiceId: string) => void;","  onSynthesizeTTS?: (text: string, voiceId: string) => Promise<void>;");
patch(audioStudio,"  const [selectedVoice, setSelectedVoice] = useState('v2');", "  const [selectedVoice, setSelectedVoice] = useState('alloy');");
patch(audioStudio,'已连接 EdgeTTS / CosyVoice 多角色语音合成通道','试听使用管理员托管语音；音色可用性由模型决定');
patch(audioStudio,"{v.name} ({v.gender === 'male' ? '男声' : '女声'} - {v.provider})",'{v.name}');
patch(audioStudio,`            onClick={() => {
              setIsPlaying(true);
              onSynthesizeTTS?.(sampleText, selectedVoice);
              setTimeout(() => setIsPlaying(false), 2000);
            }}`,`            disabled={isPlaying || !onSynthesizeTTS}
            onClick={async () => {
              setIsPlaying(true);
              try { await onSynthesizeTTS?.(sampleText, selectedVoice); }
              finally { setIsPlaying(false); }
            }}`);
let audioStudioText=read(audioStudio);
audioStudioText=audioStudioText.replace("  gender: 'male' | 'female';\n  provider: 'edge-tts' | 'cosyvoice' | 'azure';", "  gender: 'neutral';\n  provider: 'greenroom';");
const voicesStart=audioStudioText.indexOf('export const DEFAULT_VOICES: TTSVoice[] = [');
const voicesEnd=audioStudioText.indexOf('\n];',voicesStart);
if(voicesStart<0||voicesEnd<0)throw new Error('Kineo audio studio voices changed');
audioStudioText=audioStudioText.slice(0,voicesStart)+`export const DEFAULT_VOICES: TTSVoice[] = ['alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse','marin','cedar'].map(id => ({id,name:id,language:'多语言',gender:'neutral',provider:'greenroom'}));`+audioStudioText.slice(voicesEnd+3);
write(audioStudio,audioStudioText);
const fakeExport=`        <Button
          variant="primary"
          onClick={() => {
            toast.success('🎉 漫剧音画同轴合成完成！4K Ultra-HD MP4 导出任务已全量下发');
          }}
          className="gap-1.5 font-bold cursor-pointer bg-gradient-to-r from-emerald-500 to-indigo-600 hover:from-emerald-600 hover:to-indigo-700 text-white shadow-lg shadow-emerald-500/20"
        >
          一键 4K 压制导出漫剧 <ArrowRight className="w-4 h-4" />
        </Button>`;
patch(audioStep,fakeExport,'        <ManagedFrameExport />');

// Keep explicit composition settings when returning from audio/export. The
// page Provider is already keyed by project; key the Studio as well.
const compositionStep='src/pages/project-edit/components/StepComposition.tsx';
patch(compositionStep,"import React, { Suspense, lazy } from 'react';", "import React, { Suspense, lazy } from 'react';\nimport {useParams} from 'react-router-dom';");
patch(compositionStep,'  const {navigation: {setCurrentStep}} = useManagedProjectEdit();', '  const {state: {composition}, navigation: {setCurrentStep}} = useManagedProjectEdit();\n  const {projectId} = useParams();');
patch(compositionStep,'<CompositionStudio frames={frames} onCompositionChange={onCompositionChange} />', '<CompositionStudio key={projectId} projectId={projectId} initialComposition={composition} frames={frames} onCompositionChange={onCompositionChange} />');
const compositionStudio='src/features/composition/components/CompositionStudio/index.tsx';
const studioHook='src/features/composition/components/CompositionStudio/useCompositionStudio.ts';
for(const file of [compositionStudio,studioHook]) patch(file,'  projectId?: string;', '  projectId?: string;\n  initialComposition?: CompositionProject | null;');
patch(compositionStudio,'({ frames, projectId, onCompositionChange }: CompositionStudioProps)', '({ frames, projectId, initialComposition, onCompositionChange }: CompositionStudioProps)');
patch(compositionStudio,'useCompositionStudio({ frames, projectId, onCompositionChange })', 'useCompositionStudio({ frames, projectId, initialComposition, onCompositionChange })');
patch(studioHook,'  const { frames, projectId, onCompositionChange } = options;', `  const { frames, projectId, initialComposition, onCompositionChange } = options;
  if (initialComposition?.projectId && initialComposition.projectId !== projectId) throw new Error('合成配置不属于当前工程');`);
patch(studioHook,"initialCompositionStudioState(buildInitialComposition(projectId ?? ''))", "initialCompositionStudioState(initialComposition ?? buildInitialComposition(projectId ?? ''))");

// This modal has footer=null. Submit through the original form/onSave path,
// with decimal duration input and the existing control ranges enforced.
const globalForm='src/features/composition/components/CompositionStudio/GlobalSettingsForm.tsx';
patch(globalForm,"import { Divider } from '@/components/ui/divider';", "import { Divider } from '@/components/ui/divider';\nimport { Button } from '@/components/ui/button';");
patch(globalForm,'  const handleSave = (e: React.FormEvent) => {', "  const [error, setError] = useState('');\n  const handleSave = (e: React.FormEvent) => {");
patch(globalForm,'    e.preventDefault();\n    onSave({', `    e.preventDefault();
    if (!Number.isFinite(frameDuration) || frameDuration < 1 || frameDuration > 10 || !Number.isFinite(transitionDuration) || transitionDuration < 0.1 || transitionDuration > 5) {
      setError('默认帧时长须为 1–10 秒，转场时长须为 0.1–5 秒');
      return;
    }
    setError('');
    onSave({`);
patch(globalForm,'          <InputNumber\n            min={0.1}', '          <InputNumber\n            inputMode="decimal"\n            pattern="[0-9]+([.][0-9]+)?"\n            min={0.1}');
patch(globalForm,'      <div />\n    </form>', '      <div />\n      {error && <p role="alert">{error}</p>}\n      <Button type="submit">保存全局设置</Button>\n    </form>');

patch('src/core/services/agent/SoundEngineerAgent.ts', "matchedChar?.voice?.voiceId || (idx % 2 === 0 ? 'alloy' : 'nova')", "(matchedChar as any)?.voiceId ?? matchedChar?.voice?.voiceId ?? (idx % 2 === 0 ? 'alloy' : 'nova')");
