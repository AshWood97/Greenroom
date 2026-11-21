import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { root, readRow, writeRow, listRows, deleteRow, getProject, saveProject, mutateProject, createProject, events, member } from '@/lib/greenroom/store';
import { ProjectDataSchema } from '@/lib/project/store';
import { parseSavedProject } from '@/lib/project/saved-project';
import { migrateLegacyRenderLayout } from '@/lib/greenroom/legacy-timeline';
import { deserializeWithScenes } from '@/lib/project/serialize';
import { serializeOSMLWithScenes } from '@/lib/canvas/osml-serializer';
import { OSMLStreamParser } from '@/lib/canvas/osml-stream-parser';
import { getCanvasElements, getAssets } from '@/lib/canvas/assets';
import { buildScriptPrompt } from '@/lib/script/prompt/build';
import { isGenerated, CONTENT_TYPES, connectorOf } from '@/lib/canvas/types';
import { resolveDefaultModels, installManagedModels, hasModel } from '@/lib/connectors/models';
import { buildNodes } from '@/lib/generation/generation-graph';
import { buildSettings, flattenGraph } from '@/lib/generation/graph';
import { createConnector } from '@/lib/connectors/factory';
import { resolveElements } from '@/lib/render/resolve';
import { buildRenderLayout } from '@/lib/render/scene-builder';
import { errorMessage } from '@/lib/errors';
import merge from 'lodash/merge';
import {flatAttributes,splitAttributes} from '@/lib/canvas/element-attributes';
import {osmlSpec} from '@/lib/script/prompt/osml';
import {MOTION_EFFECTS} from '@/lib/render/motion-effect-names';
import {TRANSITION_TYPES} from '@/lib/render/transitions';
import {resultIdentity} from '@/lib/connectors/asset-url';
import {GenerationQueue} from '@/lib/generation/queue';
import {needsGeneration} from '@/lib/generation/staleness';
import {CaptionSchema} from '@/lib/connectors/types';
import {toCaption} from '@/lib/captions/word-captions';

const base=(process.env.GREENROOM_BASE_PATH || '/plugins/openslop').replace(/\/$/,'');
const managed=(process.env.GREENROOM_MANAGED_URL || 'http://127.0.0.1:18767/managed').replace(/\/$/,'');
const bridge=managed.replace(/\/managed$/,'');
const broker=(process.env.GREENROOM_BROKER_URL || 'http://127.0.0.1:3081').replace(/\/$/,'');
const json=(value:unknown,status=200)=>Response.json(value,{status});
const emptySnapshot=()=>({status:'idle',startedAt:null,result:null,error:null,resultInputs:null,connectorType:null,pinned:false});
const pending=new Set(['pending','processing']);
async function managedJson(path:string,init?:RequestInit){const response=await fetch(managed+path,init);const value=await response.json();if(!response.ok||value.success===false)throw new Error(typeof value.error==='string'?value.error:value.error?.message||`${response.status} ${response.statusText}`);return value.data??value;}
async function managedTool(name:string,args:Record<string,unknown>={}){
  let ticket:string|undefined;const admission=bridge+'/admission/openslop';
  try{for(;;){
    const response=await fetch(bridge+'/plugins/openslop/_greenroom/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,arguments:args,...(ticket?{admissionId:ticket}:{})})});
    const result=await response.json();
    if(response.status!==202||result.waiting_memory!==true||result.submitted!==false){
      if(!response.ok)throw new Error(result.error||'托管业务调用失败');
      const value=JSON.parse(result.content?.find((part:any)=>part.type==='text')?.text||'{}');if(result.isError)throw new Error(value.error||'OpenSlop 业务调用失败');return value;
    }
    ticket||=randomUUID();
    for(;;){const ready=await fetch(admission,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})});
      const status=await ready.json();if(!ready.ok)throw new Error(status.error||'插件准备失败');if(status.state==='ready')break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(10000,Math.max(1000,Number(status.retry_after_ms)||2000))));}
  }}finally{if(ticket)await fetch(admission,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})}).catch(()=>{});}
}
export async function modelCatalog(settings:any){
  const all=await managedJson('/models');const models:Record<string,any[]>={};
  for(const kind of ['llm','image','video','tts','music','embedding','rerank']){
    const entries=Array.isArray(all[kind])?all[kind]:[];const approved=settings?.configured?settings.models?.[kind]||[]:entries.map((entry:any)=>entry.id);
    models[kind]=approved.map((id:string)=>entries.find((entry:any)=>entry.id===id)).filter(Boolean);
  }
  return {models,parameters:settings?.parameters||{}};
}
async function currentSettings(){const catalog=await managedTool('openslop_get_catalog');return {configured:true,models:Object.fromEntries(Object.entries(catalog.models).map(([kind,entries]:any)=>[kind,entries.map((entry:any)=>entry.id)])),parameters:catalog.parameters||{}};}
async function chooseModel(kind:string,requested:string|undefined,settings:any){
  const config=await modelCatalog(settings);const entries=config.models[kind]||[];
  if(!entries.length)throw new Error(`管理员尚未为 OpenSlop 配置${({llm:'文本',image:'图像',video:'视频',tts:'语音',music:'音乐'} as any)[kind]||kind}模型`);
  const model=requested||entries[0].id;if(!entries.some((entry:any)=>entry.id===model))throw new Error('所选模型未获管理员批准');return model;
}
function parseManagedScript(script:string,models:any,catalog:any){
  // No await between installation, explicit-pin validation and the native
  // parser: resolveModel otherwise silently replaces an unknown saved pin.
  installManagedModels(catalog);
  // Preserve the prepare-owned unavailable marker for document-only authoring;
  // it is not a selectable model and submitGeneration still fails closed.
  const allowed=(kind:any,pick:any)=>hasModel(kind,pick)||(pick.provider==='openslop'&&pick.model==='greenroom-unconfigured-'+(kind==='voice'?'tts':kind)&&!(catalog.models[kind==='voice'?'tts':kind]||[]).length);
  for(const [kind,pick] of Object.entries(models||{}) as [any,any][])if(pick?.model!==undefined&&!allowed(kind,pick))throw new Error('工程所选模型未获管理员批准：'+pick.model);
  for(const element of new OSMLStreamParser().appendChunk(script)){
    const kind=connectorOf(element.type),pick=element.attrs;
    if(kind&&(pick.model!==undefined||pick.provider!==undefined)&&!allowed(kind,pick))throw new Error('元素所选模型未获管理员批准：'+(pick.model||pick.provider));
  }
  return deserializeWithScenes(script,resolveDefaultModels({project:models}),index=>'scene-'+index);
}
async function blocks(project:any,settings?:any){const saved=parseSavedProject(project),catalog=await modelCatalog(settings??await currentSettings());return parseManagedScript(saved.script,saved.store.models,catalog);}
async function projectElements(project:any,settings?:any){return getCanvasElements(await blocks(project,settings));}
async function projectResponse(id:string,settings?:any){const raw=await getProject(id),project={...raw,...parseSavedProject(raw)};return {...project,elements:await projectElements(project,settings),tasks:(await listRows('jobs')).filter(job=>job.projectId===id),runs:(await listRows('runs')).filter(run=>run.projectId===id)};}
async function rememberVersion(project:any){const id=randomUUID();await writeRow('versions',id,{id,projectId:project.id,updatedAt:new Date().toISOString(),content:parseSavedProject(project)});}
async function writeScript(id:string,script:string,settings?:any){const project=await getProject(id),state=ProjectDataSchema.parse(project.store),catalog=await modelCatalog(settings??await currentSettings());const canonical=serializeOSMLWithScenes(parseManagedScript(parseSavedProject({...project,script}).script,state.models,catalog));await rememberVersion(project);return saveProject(id,{script:canonical},true);}
function outputExtension(mime:string){return ({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','video/webm':'.webm','audio/mpeg':'.mp3','audio/wav':'.wav','audio/mp4':'.m4a','audio/ogg':'.ogg'} as any)[mime]||'.bin';}
function mediaUrl(id:string,file:string){return `${base}/media/${id}/${encodeURIComponent(file)}`;}
async function probeDuration(file:string){return new Promise<number>((resolve,reject)=>{let output='';const child=spawn(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',file]);child.stdout.on('data',value=>output+=value);child.on('error',reject);child.on('exit',code=>code===0?resolve(Number(output.trim())||0):reject(new Error('无法读取素材时长')));});}
async function cacheAsset(assetId:string,mimeType:string,id=randomUUID()){
  const response=await fetch(managed+'/media/'+encodeURIComponent(assetId));if(!response.ok)throw new Error(`读取成员素材失败 (${response.status})`);
  const mime=mimeType||response.headers.get('content-type')||'application/octet-stream';const filename='media'+outputExtension(mime),dir=join(root,'media',id);await mkdir(dir,{recursive:true});
  const file=join(dir,filename);const {pipeline}=await import('node:stream/promises');await pipeline(Readable.fromWeb(response.body as any), (await import('node:fs')).createWriteStream(file));
  const durationSec=mime.startsWith('image/')?0:await probeDuration(file),media={id,file,filename,mimeType:mime,assetId,url:mediaUrl(id,filename),durationSec};
  await writeRow('bundles',id,{id,type:mime.split('/')[0],provider:'openslop',result:{media:media.url},metadata:{assetId,mimeType:mime,durationSec}});return media;
}
function localMedia(url:string){const path=URL.canParse(url)?new URL(url).pathname:url;return new RegExp('^'+base+'/media/([A-Za-z0-9-]+)/([^/]+)$').exec(path);}
async function referenceUrl(url:string){const local=localMedia(url);if(local){const bundle=await readRow('bundles',local[1]);if(!bundle?.metadata?.assetId)throw new Error('参考素材尚未归入成员资产');return '/api/media/'+encodeURIComponent(bundle.metadata.assetId);}return url;}
async function videoFrames(input:any){
  const media=localMedia(input.sourceUrl);if(!media||!Array.isArray(input.frames)||input.frames.some((key:string)=>!['first','middle','last'].includes(key)))throw new Error('请选择当前工程视频和指定帧位置');
  const bundle=await readRow('bundles',media[1]);if(!bundle?.metadata?.mimeType?.startsWith('video/'))throw new Error('当前成员没有此视频');
  const filename=decodeURIComponent(media[2]);if(filename!==basename(filename))throw new Error('素材名称无效');const source=join(root,'media',media[1],filename),duration=await probeDuration(source);
  const frames=[];for(const key of input.frames){const seconds=key==='first'?0:key==='middle'?duration/2:Math.max(0,duration-1/24);const bytes=await new Promise<Buffer>((resolve,reject)=>{const chunks:Buffer[]=[];let error='';const child=spawn(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-ss',String(seconds),'-i',source,'-frames:v','1','-f','image2pipe','-vcodec','mjpeg','-q:v','2','pipe:1']);child.stdout.on('data',value=>chunks.push(value));child.stderr.on('data',value=>error+=value);child.on('error',reject);child.on('exit',code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error(error||'视频取帧失败')));});if(!bytes.length)throw new Error('视频未返回可用画面帧');frames.push('data:image/jpeg;base64,'+bytes.toString('base64'));}return {frames};
}
function captionWords(timestamps:any[]){return timestamps.filter(word=>typeof word.text!=='string'||word.text.trim()).map(word=>CaptionSchema.parse(word.startMs===undefined?toCaption(word.text.trim(),word.start,word.end):word));}
function nativeResult(media:any,timestamps:any[]=[]){const words=captionWords(timestamps);return {durationSec:media.durationSec,...(media.mimeType.startsWith('image/')?{imageUrl:media.url}:{...(media.mimeType.startsWith('video/')?{videoUrl:media.url}:{audioUrl:media.url}),textTimestamps:words,originalTextTimestamps:words})};}
async function commitElement(projectId:string,elementId:string,result:any,connectorType?:string,inputs?:any,pinned=false){
  const historyId=randomUUID();await writeRow('element-history',historyId,{id:historyId,projectId,elementId,createdAt:new Date().toISOString(),result,inputs:inputs||{prompt:'',attributes:{},reads:{},dependencies:{}},connectorType:connectorType||'image',pinned});
  await mutateProject(projectId,project=>({generation:{...project.generation,[elementId]:{...(project.generation[elementId]||emptySnapshot()),status:'idle',startedAt:null,result,error:null,resultInputs:inputs||null,connectorType:connectorType||null,pinned}},...(result.imageUrl&&!project.thumbnail_url?{thumbnail_url:result.imageUrl}:{})}),'generation');
}
async function bundleForJob(job:any,task:any){
  if(job.result)return job.result;const output=task.outputs?.[0];if(!output?.assetId)throw new Error('生成任务没有返回成员资产编号');
  const media=await cacheAsset(output.assetId,output.mimeType||'',job.jobId);const key=job.kind==='image'?'image':job.kind==='video'?'video':'audio';
  const timestamps=captionWords(Array.isArray(output.textTimestamps)?output.textTimestamps:Array.isArray(task.textTimestamps)?task.textTimestamps:[]);
  if(key==='audio')await writeFile(join(root,'media',media.id,'timestamps.json'),JSON.stringify(timestamps));
  const bundle={id:job.jobId,type:job.kind,provider:'openslop',result:{[key]:media.url,...(key==='audio'?{timestamps:mediaUrl(media.id,'timestamps.json')}:{})},metadata:{durationSec:media.durationSec,assetId:output.assetId,mimeType:media.mimeType}};
  await writeRow('bundles',job.jobId,bundle);
  if(job.elementId)await commitElement(job.projectId,job.elementId,nativeResult(media,timestamps),job.connectorType||job.kind,job.inputs);
  return bundle;
}
const jobUpdates=new Map<string,Promise<any>>();
async function updateJob(input:any){
  const operation=(jobUpdates.get(input.jobId)||Promise.resolve()).catch(()=>{}).then(async()=>{
  const job=await readRow('jobs',input.jobId);if(!job)throw new Error('当前成员没有此任务');
  if(input.task){const task=input.task;job.platformTaskId=task.taskId||job.platformTaskId;job.platformStatus=task.status;job.progress=task.progress??job.progress;job.queryError=null;
    if(task.status==='succeeded'){
      try{job.result=await bundleForJob(job,task);job.status='completed';job.error=null;job.outputError=null;}catch(error){job.outputError=errorMessage(error);job.status='processing';}
    }else if(task.status==='failed'||task.status==='cancelled'){job.status='failed';job.error=task.error||'服务商未返回具体失败原因';}
    else job.status='processing';
  }
  if(input.submissionError){job.status='failed';job.error=input.submissionError;job.submissionUnknown=true;}
  if(input.queryError)job.queryError=input.queryError;
  if(input.archive){job.archived=input.archive;job.archiveError=null;}
  if(input.archiveError&&!job.archived)job.archiveError=input.archiveError;
  job.updatedAt=new Date().toISOString();await writeRow('jobs',job.jobId,job);
  events.emit('project:'+job.projectId,{change:'tasks',tasks:[{...jobPoll(job),elementId:job.elementId,connectorType:job.connectorType}]});
  if(job.status==='failed'&&job.elementId)await mutateProject(job.projectId,project=>({generation:{...project.generation,[job.elementId]:{...(project.generation[job.elementId]||emptySnapshot()),status:'idle',startedAt:null,error:job.error}}}),'generation');
  return job;
  });
  jobUpdates.set(input.jobId,operation);
  try{return await operation;}finally{if(jobUpdates.get(input.jobId)===operation)jobUpdates.delete(input.jobId);}
}
function jobPoll(job:any){return {jobId:job.jobId,status:job.status,result:job.result||null,error:job.error||null,queryError:job.queryError||job.outputError||null,platformTaskId:job.platformTaskId||null};}
async function submitGeneration(args:any,settings:any){
  await getProject(args.projectId);const kind=args.kind;if(!['image','video','tts','music'].includes(kind))throw new Error('此生成能力尚未由管理员配置');
  if(args.runId&&args.elementId){const existing=(await listRows('jobs')).find(job=>job.projectId===args.projectId&&job.runId===args.runId&&job.elementId===args.elementId);if(existing)return jobPoll(existing);}
  const model=await chooseModel(kind,args.model,settings);const defaults=settings?.parameters?.[kind]||{};const jobId=randomUUID();
  const parameters={...defaults,...Object.fromEntries(Object.entries(args).filter(([,value])=>value!==undefined))};
  const body:any={model,[kind==='tts'?'text':'prompt']:args.prompt};
  if(kind==='tts'){body.text=args.prompt;body.voice=parameters.voice||'alloy';body.speed=parameters.speed??1;if(parameters.response_format!==undefined)body.response_format=parameters.response_format;}
  else if(kind==='music'){for(const key of ['duration','instrumental'])if(parameters[key]!==undefined)body[key]=parameters[key];}
  else {
    for(const key of kind==='image'?['size','aspect_ratio','n','seed']:['duration','resolution','aspect_ratio','seed','generate_audio'])if(parameters[key]!==undefined)body[key]=parameters[key];if(parameters.aspectRatio!==undefined)body.aspect_ratio=parameters.aspectRatio;
    if(parameters.width||parameters.height||parameters.quality!==undefined)body.providerParams={...(parameters.width?{width:parameters.width}:{}),...(parameters.height?{height:parameters.height}:{}),...(parameters.quality!==undefined?{quality:parameters.quality}:{})};
    const refs=[...(parameters.referenceAssetIds||[]).map((id:string)=>'/api/media/'+encodeURIComponent(id)),...await Promise.all([...(parameters.referenceImages||[]),...(parameters.continuityFrames||[])].map(referenceUrl))];
    if(refs.length)body[kind==='image'?'reference_images':'reference_image_urls']=refs;
    if(kind==='video'&&parameters.frameImage)body.first_frame_url=await referenceUrl(parameters.frameImage);
  }
  const job={jobId,projectId:args.projectId,elementId:args.elementId||null,runId:args.runId||null,connectorType:args.connectorType||kind,inputs:args.inputs||null,kind,body,model,status:'pending',platformTaskId:null,error:null,createdAt:new Date().toISOString()};
  await writeRow('jobs',jobId,job);
  events.emit('project:'+args.projectId,{change:'tasks',tasks:[job]});
  return {jobId,submissions:[{jobId,kind,body,submissionId:'openslop-'+jobId}]};
}
export function bindRunModelCatalog(plan:ReturnType<typeof flattenGraph>,catalog:any){
  // The original dimensions hook is synchronous but is invoked only after
  // async prompt/reference plugins. Bind its actual lookup, not generate().
  return plan.map(node=>({...node,job:{...node.job,config:{...node.job.config,plugins:(node.job.config.plugins||[]).map((plugin:any)=>plugin.name==='dimensions'?{...plugin,beforeGenerate:(params:any,ctx:any)=>{installManagedModels(catalog);return plugin.beforeGenerate(params,ctx);}}:plugin)}}}));
}
const runningRuns=new Set<string>();
async function executeRun(runId:string){
  if(runningRuns.has(runId))return;runningRuns.add(runId);
  try{
    const run=await readRow('runs',runId);if(!run||run.status==='completed'||run.status==='failed')return;
    const registry=(await import('@/lib/connectors/registry')).DEFAULT_CONNECTOR_REGISTRY;const project=parseSavedProject(run.project);const state=ProjectDataSchema.parse(project.store);const canvas=getCanvasElements(parseManagedScript(project.script,state.models,run.catalog));
    const selected=canvas.filter((element:any)=>isGenerated(element)&&run.elementIds.includes(element.id));
    const plan=bindRunModelCatalog(flattenGraph(buildNodes(selected as any,{projectId:run.projectId,settings:buildSettings(state),canvas,registry})),run.catalog);
    run.status='processing';run.results||={};run.failures||={};await writeRow('runs',runId,run);const snapshots=new GenerationQueue({initialState:project.generation});
    for(const [elementId,result] of Object.entries(run.results))snapshots.restoreManagedGeneration(elementId,{result:result as any,status:'idle'});
    for(const node of plan){
      if(run.results[node.id]||run.failures[node.id])continue;const existing=project.generation[node.id];
      if(existing?.result&&(existing.pinned||(!run.elementIds.includes(node.id)&&!needsGeneration(node,snapshots)))){run.results[node.id]=existing.result;await writeRow('runs',runId,run);continue;}
      const dependencies=Object.fromEntries(Object.entries(node.dependsOn).map(([key,value])=>[key,run.results[value.id]||project.generation[value.id]?.result]));
      run.currentElement=node.id;await writeRow('runs',runId,run);
      const inputs={...node.inputs,dependencies:Object.fromEntries(Object.entries(dependencies).map(([key,result]:any)=>[key,result?resultIdentity(result):'']))};
      try{
        const failed=Object.entries(node.dependsOn).find(([,dependency])=>run.failures[dependency.id]);if(failed)throw new Error(`依赖素材 ${failed[0]} 未完成：${run.failures[failed[1].id]}`);
        const result=await (createConnector(node.job.connectorType,node.job.model,run.projectId,node.job.config) as any).generate({prompt:node.inputs.prompt,...node.inputs.attributes},{dependencies,reads:node.inputs.reads,greenroom:{projectId:run.projectId,elementId:node.id,runId,inputs,connectorType:node.job.connectorType}});
        run.results[node.id]=result;snapshots.restoreManagedGeneration(node.id,{status:'idle',result,resultInputs:inputs});await commitElement(run.projectId,node.id,result,node.job.connectorType,inputs);
      }catch(error){run.failures[node.id]=errorMessage(error);await mutateProject(run.projectId,project=>({generation:{...project.generation,[node.id]:{...(project.generation[node.id]||emptySnapshot()),status:'idle',startedAt:null,error:run.failures[node.id]}}}),'generation');}
      await writeRow('runs',runId,run);
    }
    run.status=Object.keys(run.failures).length?'failed':'completed';run.currentElement=null;await writeRow('runs',runId,run);
  }catch(error){const run=await readRow('runs',runId);if(run){run.status='failed';run.error=errorMessage(error);await writeRow('runs',runId,run);}}
  finally{runningRuns.delete(runId);}
}
const localRenders=new Set<string>();
async function executeRender(jobId:string){
  if(localRenders.has(jobId))return;localRenders.add(jobId);
  let job=await readRow('jobs',jobId);try{
    if(!job||job.status==='completed')return;job.layout=migrateLegacyRenderLayout(job.layout);job.status='processing';await writeRow('jobs',jobId,job);
    const dir=join(root,'renders',jobId);await mkdir(dir,{recursive:true});const input=join(dir,'layout.json');await writeFile(input,JSON.stringify({layout:job.layout,resolution:job.resolution,output:join(dir,'video.mp4')}));
    await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','greenroom/renderer/render.ts',input],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});let failure='';child.stderr.on('data',value=>{failure=(failure+value).slice(-3500);});child.stdout.on('data',value=>{for(const line of String(value).split('\n'))if(line.startsWith('progress:')){job.progress=Number(line.slice(9));void writeRow('jobs',jobId,job);}});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(failure||`本地渲染退出 (${code})`)));});
    job.localFile=join(dir,'video.mp4');job.assetType='video';job.status='completed';job.progress=1;job.url=`${base}/renders/${jobId}/video.mp4`;job.size=(await stat(job.localFile)).size;job.error=null;await writeRow('jobs',jobId,job);
  }catch(error){if(job){job.status='failed';job.error=errorMessage(error);await writeRow('jobs',jobId,job);}}finally{localRenders.delete(jobId);}
}
async function createRender(projectId:string,layout:any,resolution='1080p'){
  await getProject(projectId);if(!layout?.series||!layout.totalDurationSec||!['480p','720p','1080p','1440p','4K'].includes(resolution))throw new Error('工程没有可渲染素材或输出尺寸无效');
  const jobId=randomUUID();const job={jobId,projectId,archiveKey:'openslop:local:'+jobId,kind:'render',status:'pending',layout:JSON.parse(JSON.stringify(layout)),resolution,progress:0,createdAt:new Date().toISOString()};await writeRow('jobs',jobId,job);void executeRender(jobId);return {jobId,renderId:jobId};
}
const scriptSubmissions=new Map<string,Promise<any>>();
function scriptResult(job:any){return job.status==='completed'?job.result:{...job,queryHint:'使用 openslop_get_tasks 查询原记录；结果未确认时不会重新提交文本生成。'};}
async function savePendingScript(job:any,settings:any){
  try{
    const saved=await writeScript(job.projectId,job.generated.text,settings);
    job.result={...saved,jobId:job.jobId,status:'completed',textGeneration:{model:job.model,usage:job.generated.usage,providerRequestId:job.providerRequestId}};
    job.status='completed';delete job.queryError;
  }catch(error){job.status='save_pending';job.queryError='原文本已保存，工程写入失败；再次调用只补写原输出，不重新生成：'+errorMessage(error);}
  job.updatedAt=new Date().toISOString();await writeRow('jobs',job.jobId,job);return scriptResult(job);
}
async function generateScript(args:any,settings:any,callId?:string){
  await getProject(args.projectId);
  if(!callId)throw new Error('剧本生成缺少真实调用编号');
  if(scriptSubmissions.has(args.projectId))return scriptSubmissions.get(args.projectId);
  const operation=(async()=>{
    const jobs=(await listRows('jobs')).filter(job=>job.kind==='script'&&job.projectId===args.projectId);
    const existing=jobs.find(job=>job.callId===callId)||jobs.find(job=>['submission_unknown','save_pending'].includes(job.status));
    if(existing)return existing.status==='save_pending'?savePendingScript(existing,settings):scriptResult(existing);
    const project=await getProject(args.projectId);
    if(typeof args.prompt!=='string'||!args.prompt.trim())throw new Error('请提供剧本创作要求');
    const model=await chooseModel('llm',args.model,settings),state=ProjectDataSchema.parse(project.store);
    const prompt=buildScriptPrompt(getAssets(await blocks(project,settings)),state.scriptSettings,{kind:'brief',brief:args.prompt});
    const job:any={jobId:randomUUID(),projectId:args.projectId,kind:'script',callId,model,status:'submission_unknown',createdAt:new Date().toISOString()};
    await writeRow('jobs',job.jobId,job);
    let generated:any;
    try{
      generated=await (await textGeneration({prompt:prompt.prompt,systemPrompt:prompt.system,model},settings,async response=>{
        const requestId=response.headers.get('x-request-id');
        if(requestId){job.providerRequestId=requestId;await writeRow('jobs',job.jobId,job);}
      })).json();
    }catch(error){
      job.queryError='文本请求结果尚未确认，未自动重提：'+errorMessage(error);
      job.updatedAt=new Date().toISOString();await writeRow('jobs',job.jobId,job);return scriptResult(job);
    }
    try{
      if(typeof generated.text!=='string'||!generated.text.trim())throw new Error('文本模型未返回剧本，原工程保持不变');
      const parsed=parseManagedScript(generated.text,state.models,await modelCatalog(settings));
      if(!getCanvasElements(parsed).some(element=>element.type in CONTENT_TYPES))throw new Error('文本模型未返回可用 OSML 剧本，原工程保持不变');
    }catch(error){
      job.status='failed';job.error=errorMessage(error);job.updatedAt=new Date().toISOString();
      await writeRow('jobs',job.jobId,job);return scriptResult(job);
    }
    // Persist the accepted output before touching the project. A storage failure
    // here leaves the earlier unknown record locked, never a permission to resubmit.
    job.generated=generated;job.status='save_pending';await writeRow('jobs',job.jobId,job);
    return savePendingScript(job,settings);
  })();
  scriptSubmissions.set(args.projectId,operation);
  try{return await operation;}finally{scriptSubmissions.delete(args.projectId);}
}
export async function callBusiness(name:string,args:any,settings:any,callId?:string){
  if(name==='openslop_get_catalog')return {...await modelCatalog(settings),authoring:{osml:osmlSpec('zh'),sceneSeparator:'--- Scene 1 ---',motions:MOTION_EFFECTS,transitions:TRANSITION_TYPES,captions:'导入带 textTimestamps 的配音，或使用语音服务实际返回的字词时间轴。无时间轴时不编造字幕时间。',soundEffects:'独立音效服务未配置；成员音效素材可导入、裁切、循环和混音。',transcription:'语音转文字服务尚未配置；不重新生成原媒体，不编造字词时间轴。'}};
  if(name==='openslop_list_projects')return {projects:(await listRows('projects')).sort((a,b)=>b.updated_at.localeCompare(a.updated_at))};
  if(name==='openslop_create_project')return createProject(args.title);
  if(name==='openslop_get_project')return projectResponse(args.projectId,settings);
  if(name==='openslop_set_script')return writeScript(args.projectId,args.script,settings);
  if(name==='openslop_generate_script')return generateScript(args,settings,callId);
  if(name==='openslop_update_settings'){const project=await getProject(args.projectId);await rememberVersion(project);const store=ProjectDataSchema.parse({...project.store,...(args.title===undefined?{}:{title:args.title}),videoSettings:merge({},project.store.videoSettings,args.videoSettings),scriptSettings:{...project.store.scriptSettings,...args.scriptSettings}});return saveProject(args.projectId,{store,name:store.title||project.name},true);}
  if(name==='openslop_list_elements'){const project=await getProject(args.projectId),tasks=await listRows('jobs');return {elements:(await projectElements(project,settings)).map(element=>({...element,snapshot:project.generation[element.id]||emptySnapshot(),tasks:tasks.filter(task=>task.projectId===project.id&&task.elementId===element.id).map(jobPoll)}))};}
  if(name==='openslop_update_element'){
    const project=await getProject(args.projectId),content=await blocks(project,settings);const element=getCanvasElements(content).find(item=>item.id===args.elementId);if(!element)throw new Error('工程没有此元素');
    if(args.text!==undefined)element.children=[{id:randomUUID(),text:args.text}];if(args.attributes)Object.assign(element,splitAttributes({...flatAttributes(element),...args.attributes}));return writeScript(args.projectId,serializeOSMLWithScenes(content),settings);
  }
  if(name==='openslop_generate_elements'){
    const raw=await getProject(args.projectId),project={...raw,...parseSavedProject(raw)};const config=await modelCatalog(settings);const elements=getCanvasElements(parseManagedScript(project.script,ProjectDataSchema.parse(project.store).models,config));
    if(!args.elementIds?.length||args.elementIds.some((id:string)=>!elements.some(element=>element.id===id&&isGenerated(element))))throw new Error('请选择工程中可生成的元素');
    const runId=randomUUID();const run={runId,projectId:args.projectId,elementIds:args.elementIds,project,catalog:config,status:'pending',results:{},createdAt:new Date().toISOString()};await writeRow('runs',runId,run);void executeRun(runId);return {runId,status:'pending'};
  }
  if(name==='openslop_submit_generation')return submitGeneration(args,settings);
  if(name==='openslop_import_asset'){
    const project=await getProject(args.projectId);const element=(await projectElements(project,settings)).find(element=>element.id===args.elementId);if(!element)throw new Error('工程没有此元素');const media=await cacheAsset(args.assetId,args.mimeType);if(args.durationSec!==undefined)media.durationSec=args.durationSec;
    const result=nativeResult(media,args.textTimestamps||[]);await writeRow('bundles',media.id,{id:media.id,type:media.mimeType.split('/')[0],provider:'openslop',result:{media:media.url},metadata:media});await commitElement(args.projectId,args.elementId,result,undefined,undefined,true);return {elementId:args.elementId,result,assetId:args.assetId};
  }
  if(name==='openslop_get_tasks'){await getProject(args.projectId);return {tasks:(await listRows('jobs')).filter(job=>job.projectId===args.projectId),runs:(await listRows('runs')).filter(run=>run.projectId===args.projectId)};}
  if(name==='openslop_render_project'){
    const project=parseSavedProject(await getProject(args.projectId)),state=ProjectDataSchema.parse(project.store),resolved=resolveElements(await blocks(project,settings),id=>project.generation[id]||emptySnapshot());
    return createRender(args.projectId,buildRenderLayout(resolved,state.videoSettings),args.resolution||settings.parameters?.video?.resolution||'1080p');
  }
  if(name==='openslop_archive_project'){
    const project=await getProject(args.projectId);const jobId=randomUUID(),dir=join(root,'archives',jobId);await mkdir(dir,{recursive:true});const source=join(dir,'project.json'),document=await projectResponse(project.id,settings);await writeFile(source,JSON.stringify(document,null,2));
    const mediaIds=new Set<string>();const mediaUrls=[...(project.store?.media||[]).map((item:any)=>item.url),...(Object.values(project.generation) as any[]).flatMap(snapshot=>[snapshot.result?.imageUrl,snapshot.result?.audioUrl,snapshot.result?.videoUrl])];for(const value of mediaUrls){const match=typeof value==='string'&&new RegExp('^'+base+'/media/([A-Za-z0-9-]+)/').exec(value);if(match)mediaIds.add(match[1]);}
    const file=join(dir,'openslop-project.zip');await new Promise<void>((resolve,reject)=>{const child=spawn('python3',['-c','import sys,zipfile,pathlib; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); z.write(sys.argv[2],"project.json"); root=pathlib.Path(sys.argv[3]); [(z.write(p,str(p.relative_to(root)))) for id in sys.argv[4:] for p in (root/"media"/id).glob("*") if p.is_file()]; z.close()',file,source,root,...mediaIds]);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('工程归档失败')));});
    const job={jobId,projectId:project.id,archiveKey:'openslop:local:'+jobId,kind:'archive',status:'completed',localFile:file,assetType:'document',createdAt:new Date().toISOString()};await writeRow('jobs',jobId,job);return job;
  }
  throw new Error('未知 OpenSlop 业务工具');
}
async function textGeneration(input:any,configuredSettings?:any,onHeaders?:(response:Response)=>Promise<void>){
  const settings=configuredSettings??await currentSettings(),model=await chooseModel('llm',input.model,settings);
  const defaults=settings.parameters?.llm||{};
  const response=await fetch(broker+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer greenroom-managed'},body:JSON.stringify({model,messages:[...(input.systemPrompt?[{role:'system',content:input.systemPrompt}]:[]),{role:'user',content:input.referenceImages?.length?[{type:'text',text:input.prompt},...input.referenceImages.map((url:string)=>({type:'image_url',image_url:{url}}))]:input.prompt}],temperature:input.temperature??defaults.temperature,max_tokens:input.maxTokens??defaults.max_tokens,top_p:input.topP??defaults.top_p,stream:false})});
  if(onHeaders)await onHeaders(response);
  const value=await response.json();if(!response.ok)throw new Error(typeof value.error==='string'?value.error:value.error?.message||`${response.status} ${response.statusText}`);
  const result={providerRequestId:response.headers.get('x-request-id')||undefined,text:value.choices?.[0]?.message?.content||'',model,usage:{inputTokens:value.usage?.prompt_tokens||0,outputTokens:value.usage?.completion_tokens||0}};
  if(!input.stream)return json(result);return new Response(`data: ${JSON.stringify({text:result.text,done:false})}\n\ndata: ${JSON.stringify({text:'',done:true})}\n\n`,{headers:{'content-type':'text/event-stream'}});
}
async function serveFile(request:Request,file:string,mime:string){
  let info;try{info=await stat(file);}catch{return json({error:'素材不存在'},404);}let start=0,end=info.size-1,status=200;const range=request.headers.get('range');
  if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match)return new Response(null,{status:416});if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}else if(match[2])start=Math.max(0,info.size-Number(match[2]));if(start>end||start>=info.size)return new Response(null,{status:416});status=206;}
  return new Response(request.method==='HEAD'?null:Readable.toWeb(createReadStream(file,{start,end})) as any,{status,headers:{'content-type':mime,'content-length':String(end-start+1),'accept-ranges':'bytes','access-control-allow-origin':'*',...(status===206?{'content-range':`bytes ${start}-${end}/${info.size}`}:{})}});
}
function mimeFor(file:string){return ({'.mp4':'video/mp4','.webm':'video/webm','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.json':'application/json','.zip':'application/zip'} as any)[extname(file)]||'application/octet-stream';}
let lifecycleRequests=0;
export async function handle(request:Request):Promise<Response|null>{
  const url=new URL(request.url);let path=url.pathname;if(path===base)path='/';else if(path.startsWith(base+'/'))path=path.slice(base.length);
  if(path==='/api/greenroom/lifecycle')return json({known:true,busy:Boolean(lifecycleRequests||runningRuns.size||localRenders.size)});
  lifecycleRequests++;
  try{
    if(path==='/health')return json({success:true,application:'openslop'});
    if(path==='/greenroom/call'){const body=await request.json();return json(await callBusiness(body.name,body.arguments||{},body.settings||{},body.callId));}
    if(path==='/greenroom/task-update')return json(await updateJob(await request.json()));
    if(path==='/greenroom/pending')return json({tasks:(await listRows('jobs')).filter(job=>(pending.has(job.status)&&job.platformTaskId)||(job.localFile&&!job.archived))});
    if(path.startsWith('/greenroom/job/')){const job=await readRow('jobs',decodeURIComponent(path.slice(15)));if(!job)throw new Error('当前成员没有此任务');return json(jobPoll(job));}
    if(path==='/api/greenroom/catalog')return json(await managedTool('openslop_get_catalog'));
    if(path==='/api/greenroom/video-frames')return json(await videoFrames(await request.json()));
    if(path==='/api/greenroom/account'){if(request.method==='PUT'){const input=await request.json();await writeRow('account','defaults',input);return json({success:true});}return json(await readRow('account','defaults')||{});}
    if(path==='/api/greenroom/projects'){if(request.method==='POST'){const input=await request.json();return json(await createProject(input.title||'Untitled'));}return json(await listRows('projects'));}
    const projectRoute=/^\/api\/greenroom\/projects\/([A-Za-z0-9_.-]+)(?:\/(versions|history|events)(?:\/([A-Za-z0-9_.-]+))?)?$/.exec(path);
    if(projectRoute){const [,id,section,item]=projectRoute;await getProject(id);
      if(!section){if(request.method==='DELETE'){await deleteRow('projects',id);return json({success:true});}if(request.method==='PUT'){const input=await request.json();const parsed=parseSavedProject(input);return json(await saveProject(id,{...parsed,name:input.name||parsed.store.title||'Untitled',thumbnail_url:input.thumbnail_url??null}));}return json(await projectResponse(id));}
      if(section==='events'){const encoder=new TextEncoder(),tasks=(await listRows('jobs')).filter(job=>job.projectId===id);let listener:(value:any)=>void;return new Response(new ReadableStream({start(controller){listener=value=>controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n'));events.on('project:'+id,listener);request.signal.addEventListener('abort',()=>{events.off('project:'+id,listener);try{controller.close();}catch{}});controller.enqueue(encoder.encode('data: '+JSON.stringify({change:'tasks',tasks})+'\n\n'));},cancel(){events.off('project:'+id,listener);}}),{headers:{'content-type':'text/event-stream','cache-control':'no-cache'}});}
      if(section==='versions'){
        if(request.method==='POST'||request.method==='PUT'){const content=parseSavedProject(await request.json()),versionId=item||randomUUID(),existing=item?await readRow('versions',item):null;if(existing&&existing.projectId!==id)throw new Error('工程版本不存在');const row={id:versionId,projectId:id,updatedAt:new Date().toISOString(),content};await writeRow('versions',versionId,row);return json({id:versionId,updatedAt:row.updatedAt});}
        if(item){const row=await readRow('versions',item);if(!row||row.projectId!==id)throw new Error('工程版本不存在');return json(parseSavedProject(row.content));}return json((await listRows('versions')).filter(row=>row.projectId===id).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100).map(({id,updatedAt})=>({id,updatedAt})));
      }
      if(section==='history'){if(request.method==='POST'){const value=await request.json(),historyId=randomUUID(),row={...value,id:historyId,projectId:id,elementId:item,createdAt:value.createdAt||new Date().toISOString()};await writeRow('element-history',historyId,row);return json(row);}return json((await listRows('element-history')).filter(row=>row.projectId===id&&row.elementId===item).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));}
    }
    if(path==='/api/render'){const input=await request.json();return json(await createRender(input.projectId,input.inputProps,input.resolution));}
    if(path==='/api/render/progress'){const {renderId}=await request.json();const job=await readRow('jobs',renderId);if(!job)throw new Error('渲染任务不存在');return json(job.status==='failed'?{type:'error',message:job.error}:job.status==='completed'?{type:'done',url:job.url,size:job.size}:{type:'progress',progress:job.progress||0});}
    const gateway=/^\/api\/(?:v1|third-party)\/(image|video|tts|music|sfx|stt|llm|agent)(?:\/(.*))?$/.exec(path);
    if(gateway){const [,kind,suffix]=gateway;
      if(kind==='llm')return textGeneration(await request.json());
      if(kind==='agent'){
        const input=await request.json();await getProject(input.projectId);const settings=await currentSettings(),model=await chooseModel('llm',input.model,settings);
        const [{streamAgentTurn},{parseSloppyMessage},{createOpenAI}]=await Promise.all([import('@/lib/api/agent-turn'),import('@/lib/agent/messages'),import('@ai-sdk/openai')]);
        const message=await parseSloppyMessage(input.message);if(!message)throw new Error('对话消息格式无效');
        const controller=new AbortController();
        const abort=()=>controller.abort(request.signal.reason);
        request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
        lifecycleRequests++;let released=false;
        const release=()=>{if(released)return;released=true;lifecycleRequests--;request.signal.removeEventListener('abort',abort);};
        try{
        const response=await streamAgentTurn({signal:controller.signal,projectId:input.projectId,userId:member.id,message,model,parameters:{...settings.parameters?.llm,...Object.fromEntries(Object.entries({temperature:input.temperature,max_tokens:input.maxTokens,top_p:input.topP}).filter(([,value])=>value!==undefined))},recordSpend:async()=>{},llm:async()=>({agentModel:()=>({model:createOpenAI({baseURL:broker+'/v1',apiKey:'greenroom-managed'}).chat(model),modelId:model,providerOptions:{},cachedPrefix:{},costOf:()=>0})} as any)});
        if(!response.body){release();return response;}
        const reader=response.body.getReader();
        const body=new ReadableStream({
          async pull(stream){try{const value=await reader.read();if(value.done){release();stream.close();}else stream.enqueue(value.value);}catch(error){release();stream.error(error);}},
          async cancel(reason){controller.abort(reason);try{await reader.cancel(reason);}finally{release();}},
        });
        return new Response(body,{status:response.status,headers:response.headers});
        }catch(error){release();throw error;}
      }
      if(suffix==='voices'){const settings=await currentSettings();await chooseModel('tts',url.searchParams.get('model')||undefined,settings);const voice=settings.parameters?.tts?.voice||'alloy';return json({voices:[{id:voice,name:voice,description:'管理员配置的托管语音'}]});}
      if(suffix==='voices/preview')throw new Error('管理员配置的语音服务未提供试听素材');
      if(suffix){const job=await readRow('jobs',suffix);if(!job)throw new Error('当前成员没有此任务');if(pending.has(job.status))await managedTool('openslop_get_tasks',{projectId:job.projectId});return json(jobPoll(await readRow('jobs',suffix)));}
      if(kind==='stt')throw new Error('平台尚未配置语音转文字服务；可导入带真实字词时间轴的配音或视频，已有字幕仍可编辑和导出');
      if(kind==='sfx')throw new Error('平台未配置独立音效生成能力，可导入成员音效素材后使用原混音功能');
      const input=await request.json(),context=input.__greenroom||{};if(!context.projectId)throw new Error('生成任务缺少当前工程');
      const speed=typeof input.speed==='string'?({slow:0.8,medium:1,fast:1.2} as any)[input.speed]:input.speed;
      const rawDuration=input.duration??input.durationSeconds;
      const result=await managedTool('openslop_submit_generation',{projectId:context.projectId,kind,prompt:input.prompt,model:input.model,elementId:context.elementId,runId:context.runId||context.submissionId,duration:rawDuration===undefined?undefined:Number(rawDuration),aspectRatio:input.width&&input.height?(input.width>input.height?'16:9':'9:16'):undefined,width:input.width?Number(input.width):undefined,height:input.height?Number(input.height):undefined,resolution:input.resolution,referenceImages:input.referenceImages,voice:input.voiceId,speed,frameImage:input.frameImage,continuityFrames:input.continuityFrames,connectorType:context.connectorType,inputs:context.inputs});
      return json(result);
    }
    if(path.startsWith('/api/upload/')){
      const form=await request.formData(),file=form.get('file');if(!(file instanceof File))throw new Error('请选择素材文件');const bytes=new Uint8Array(await file.arrayBuffer());const kind=file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':'audio';
      const response=await managedJson('/media/uploads',{method:'POST',headers:{'content-type':file.type||'application/octet-stream','x-file-name':encodeURIComponent(file.name),'x-asset-type':kind,'content-length':String(bytes.byteLength)},body:bytes});
      const media=await cacheAsset(response.assetId,response.mimeType||file.type);return json({url:media.url,assetId:response.assetId,durationSec:media.durationSec});
    }
    const media=/^\/media\/([A-Za-z0-9-]+)\/([^/]+)$/.exec(path);if(media){const file=decodeURIComponent(media[2]);if(file!==basename(file)||file==='.'||file==='..')throw new Error('素材名称无效');return serveFile(request,join(root,'media',media[1],file),mimeFor(file));}
    const rendered=/^\/renders\/([A-Za-z0-9-]+)\/video\.mp4$/.exec(path);if(rendered){const job=await readRow('jobs',rendered[1]);if(!job?.localFile)throw new Error('成片尚未生成');return serveFile(request,job.localFile,'video/mp4');}
    const bundle=/^\/assets\/[^/]+\/openslop\/([A-Za-z0-9-]+)\/manifest.json$/.exec(path);if(bundle){const value=await readRow('bundles',bundle[1]);return value?json(value):json({error:'素材包不存在'},404);}
    if(path.startsWith('/api/'))return json({error:'此接口由 Greenroom 管理员统一托管'},403);
    return null;
  }catch(error){return json({error:errorMessage(error)},400);}
  finally{lifecycleRequests--;}
}
export async function restore(){
  for(const job of await listRows('jobs'))if(pending.has(job.status)){if(job.kind==='render')void executeRender(job.jobId);else if(!job.platformTaskId)await updateJob({jobId:job.jobId,submissionError:'任务提交时服务中断，未取得服务商任务编号；未自动重新提交。'});}
  for(const run of await listRows('runs'))if(pending.has(run.status))void executeRun(run.runId);
}
