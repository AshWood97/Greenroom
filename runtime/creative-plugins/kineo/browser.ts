import type { ImageGenerationResult } from '@/core/services/ai/image/image-generation/types';
export const apiBase = '/plugins/kineo/api';
export let managedCatalog: Record<string, any[]> = {};
export let managedSettings: any = {};
const client = crypto.randomUUID();
let values: Record<string, string> = {};
let pending = Promise.resolve();
let activeJobs = 0;
let refreshPending = false;
export async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(apiBase + path, { ...options, headers: { 'content-type': 'application/json', 'X-Kineo-Client': client, ...options.headers } });
  const result = await response.json();
  if (!response.ok || result?.error) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function saveStorage(key: string, value: string | null) {
  // A new explicit storage write may proceed after a prior failed save; never replay the old payload.
  pending = pending.catch(() => {}).then(() => request('/state', { method: 'PUT', body: JSON.stringify({ key, value }) })).then(() => {});
  pending.catch(error => {
    let notice = document.getElementById('greenroom-save-error');
    if (!notice) { notice = document.createElement('div'); notice.id = 'greenroom-save-error'; notice.setAttribute('role','alert'); notice.style.cssText='position:fixed;bottom:12px;left:12px;z-index:99999;background:#7f1d1d;color:white;padding:12px'; document.body.append(notice); }
    notice.textContent = '工程保存未完成：' + error.message;
  });
}
const storage = {
  getItem: (key: string) => values[key] ?? null,
  setItem(key: string, value: string) { values[key] = value; saveStorage(key, value); },
  removeItem(key: string) { delete values[key]; saveStorage(key, null); },
  clear() { for (const key of Object.keys(values)) storage.removeItem(key); },
  key: (index: number) => Object.keys(values)[index] ?? null,
  get length() { return Object.keys(values).length; },
};
export async function flushManagedStorage() { await pending; }
export const managedStorage: Storage = new Proxy(storage, {
  ownKeys: () => Object.keys(values),
  getOwnPropertyDescriptor: () => ({ enumerable:true,configurable:true }),
}) as Storage;
export async function initializeManaged() {
  const data = await request('/bootstrap'); values=data.storage; managedCatalog=data.models; managedSettings=data.settings;
  // These markers select the migrated native business branches; all Tauri imports
  // are resolved to the HTTP bridge by the managed Vite build.
  (window as any).__TAURI__={}; (window as any).__TAURI_INTERNALS__={};
  const events=new EventSource(apiBase+'/events');
  events.onmessage=event=>{
    const value=JSON.parse(event.data);
    if(value.client===client) return;
    if(activeJobs){refreshPending=true;return;}
    pending.then(()=>location.reload());
  };
}
export async function runJob(kind:string,args:any,signal?:AbortSignal,submissionId?:string,onAccepted?:(job:any)=>Promise<void> | void,beforeSubmit?:()=>boolean) {
  activeJobs++;
  try {
    await pending;
    if (signal?.aborted || (beforeSubmit && !beforeSubmit())) throw Object.assign(new Error('工程已切换或等待已取消，未提交导出'),{notSubmitted:true});
    const job=await request('/jobs',{method:'POST',body:JSON.stringify({kind,arguments:args,submissionId:submissionId || 'kineo:'+crypto.randomUUID()}),signal});
    if (onAccepted) {
      try { await onAccepted(job); }
      catch (error) { throw Object.assign(new Error('原任务已受理，记录保存失败；请按原编号查询：'+job.id),{taskId:job.id,cause:error}); }
    }
    try { return await waitForJob(job,signal); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)),{taskId:job.id}); }
  } finally { activeJobs--; if(!activeJobs && refreshPending) { refreshPending=false; setTimeout(()=>pending.then(()=>location.reload()),500); } }
}
export async function waitForJob(job:any,signal?:AbortSignal) {
  for(let attempt=0;attempt<3600;attempt++) {
    if(signal?.aborted) throw new Error('已停止等待，后台任务继续执行');
    const task=await request('/tasks/'+encodeURIComponent(job.id),{signal});
    if(task.status==='succeeded') return task;
    if(['failed','cancelled'].includes(task.status)) throw new Error(task.error || '服务商未返回具体失败原因');
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  throw new Error('任务仍在后台执行，请在任务列表中查询原编号：'+job.id);
}
export async function managedText(prompt:string,options:any={}) {
  const model=options.model || managedCatalog.llm?.[0]?.id;
  const task=await runJob('llm',{prompt,model,messages:options.messages,temperature:options.temperature,max_tokens:options.max_tokens},options.signal);
  return {content:task.text,model,usage:task.result?.usage};
}
export async function managedImage(prompt:string,options:any={}): Promise<ImageGenerationResult> {
  const task=await runJob('image',{projectId:options.projectId,frameId:options.frameId,model:options.model || managedCatalog.image?.[0]?.id,prompt,
    size:options.size,n:options.numImages,aspect_ratio:options.aspectRatio,images:options.referenceImage ? [options.referenceImage] : undefined},options.signal,options.submissionId);
  return {url:task.outputs[0].url,width:0,height:0,model:task.body.model};
}
export async function managedVideo(prompt:string,options:any={}) {
  const task=await runJob('video',{projectId:options.projectId,frameId:options.frameId,model:options.model || managedCatalog.video?.[0]?.id,prompt,
    duration:options.duration,aspect_ratio:options.aspectRatio,first_frame_url:options.referenceImage},options.signal,options.submissionId);
  return {url:task.outputs[0].url,width:0,height:0,duration:options.duration || 0,model:task.body.model,taskId:task.id,status:'completed' as const};
}
export async function uploadFile(file:File | Blob,name='input.bin') {
  const response=await fetch(apiBase+'/files',{method:'POST',headers:{'X-File-Name':encodeURIComponent(file instanceof File?file.name:name)},body:file});
  const result=await response.json(); if(!response.ok) throw new Error(result.error); return result.path;
}
export async function persistedBlobUrl(blob:Blob) { return convertFileSrc(await uploadFile(blob,'media.'+(blob.type.includes('audio')?'mp3':'mp4'))); }
export function convertFileSrc(path:string) {
  if(path.startsWith('/creative-managed/media/')) return path;
  if(path.startsWith('/plugins/kineo/api/files/')) return path;
  if(path.startsWith('/api/media/')) return path.replace('/api/media/','/creative-managed/media/');
  return apiBase+'/files/'+encodeURIComponent(path);
}
export async function open(options:any={}) {
  return await new Promise(resolve=>{
    const input=document.createElement('input');input.type='file';input.multiple=!!options.multiple;
    const extensions=options.filters?.flatMap((item:any)=>item.extensions.map((ext:string)=>'.'+ext));if(extensions?.length) input.accept=extensions.join(',');
    input.oncancel=()=>resolve(null);input.onchange=async()=>{const paths=await Promise.all(Array.from(input.files || []).map(file=>uploadFile(file)));resolve(options.multiple?paths:paths[0] || null);};input.click();
  });
}
export async function save(options:any={}) { return '/files/'+crypto.randomUUID()+'-'+(options.defaultPath?.split(/[\\/]/).pop() || 'export.txt'); }
export async function invoke<T=any>(command:string,args:any={}):Promise<T> {
  await pending;
  if(['add_subtitles','add_audio','export_video'].includes(command)) {
    const input=args.videoBlob || args.inputBlob;
    if(input instanceof Blob) { args={...args,inputPath:await uploadFile(input,'input.mp4')}; delete args.videoBlob; delete args.inputBlob; }
    if(!args.outputFormat && /\.(mp4|webm|mov|avi)$/.test(args.outputPath || '')) args={...args,outputFormat:args.outputPath.split('.').pop()};
  }
  if(command==='concat_videos' && args.videoBlobs) {
    args={...args,paths:await Promise.all(args.videoBlobs.map((blob:Blob)=>uploadFile(blob,'input.mp4')))};delete args.videoBlobs;
  }
  if(['render_full_video','generate_script_from_idea','cut_video','export_video','generate_preview','compose_video','add_subtitles','add_audio','concat_videos'].includes(command)) {
    activeJobs++;
    try {
      const job=await request('/invoke',{method:'POST',body:JSON.stringify({command,arguments:args})});
      const task=await waitForJob(job); return (['cut_video','generate_preview'].includes(command) || (command==='export_video' && task.kind==='cut') ? task.result.output_path : task.result) as T;
    } finally { activeJobs--; }
  }
  return await request('/invoke',{method:'POST',body:JSON.stringify({command,arguments:args})});
}
export const listen=async()=>()=>{};
export const emit=async()=>{};
export const readTextFile=(path:string)=>request('/read-text',{method:'POST',body:JSON.stringify({path})});
export const writeTextFile=(path:string,contents:string)=>invoke('write_text_file',{path,content:contents});
export const exists=async(path:string)=>{const response=await fetch(convertFileSrc(path),{method:'GET'});return response.ok;};
export const mkdir=async()=>{};
export const remove=async()=>{throw new Error('请在工程界面删除成员项目或素材');};
export const readDir=async()=>[];
export const appDataDir=async()=>'/files';
export const appConfigDir=appDataDir,documentDir=appDataDir,videoDir=appDataDir,downloadDir=appDataDir;
export const isTauri=()=>true;
export class LogicalSize { constructor(public width:number,public height:number){} }
export class LogicalPosition { constructor(public x:number,public y:number){} }
const unavailableWindow=async()=>{throw new Error('窗口布局由 Greenroom 工作台管理');};
export const getCurrentWindow=()=>({
  minimize:unavailableWindow,toggleMaximize:unavailableWindow,close:unavailableWindow,maximize:unavailableWindow,unmaximize:unavailableWindow,
  setTitle:async(title:string)=>{document.title=title;},setFullscreen:async(fullscreen:boolean)=>{if(fullscreen)await document.documentElement.requestFullscreen();else if(document.fullscreenElement)await document.exitFullscreen();},
  setAlwaysOnTop:unavailableWindow,setSize:unavailableWindow,setPosition:unavailableWindow,center:unavailableWindow,
  isMaximized:async()=>!!document.fullscreenElement,isMinimized:async()=>document.hidden,isFullscreen:async()=>!!document.fullscreenElement,
  isFocused:async()=>document.hasFocus(),isAlwaysOnTop:async()=>false,title:async()=>document.title,
  innerSize:async()=>new LogicalSize(innerWidth,innerHeight),innerPosition:async()=>new LogicalPosition(screenX,screenY),
  show:async()=>{},hide:unavailableWindow,setFocus:async()=>window.focus(),requestUserAttention:async()=>{},
  onDragDropEvent:async(callback:any)=>{const handler=async(event:DragEvent)=>{event.preventDefault();const paths=await Promise.all(Array.from(event.dataTransfer?.files || []).map(file=>uploadFile(file)));callback({payload:{type:'drop',paths}});};document.addEventListener('drop',handler);return()=>document.removeEventListener('drop',handler);},
});
export const message=async(value:string)=>window.alert(value);
export const ask=async(value:string)=>window.confirm(value);
export const confirm=ask;
export const isPermissionGranted=async()=>false;
export const requestPermission=async()=>'denied';
export const sendNotification=()=>{};
export class Store {
  async get(key:string){const value=managedStorage.getItem(key);return value?JSON.parse(value):null;}
  async set(key:string,value:unknown){managedStorage.setItem(key,JSON.stringify(value));await pending;}
  async delete(key:string){managedStorage.removeItem(key);await pending;}
  async keys(){return Object.keys(values);}
  async save(){await pending;}
}
export const load=async()=>new Store();
