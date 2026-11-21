import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, createReadStream, openSync, fsyncSync, closeSync } from 'node:fs';
import { readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { formatGenerationError } from './generation-error.ts';
import { createMediaRetention } from './media-retention.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.GREENROOM_PLUGIN_ROOT || '/var/lib/dsh/creative-plugins/kineo');
const bridge = process.env.GREENROOM_MANAGED_URL || 'http://127.0.0.1:18767/managed';
const base = '/plugins/kineo';
const fileRoot = join(root, 'files');
mkdirSync(fileRoot, { recursive: true });
const database = join(root, 'state.json');
const state = existsSync(database) ? JSON.parse(readFileSync(database, 'utf8')) : { storage: {}, tasks: {} };
const subscribers = new Set();
const running = new Set();
const taskInputLeases = new Map();
const retention = createMediaRetention({ root, tasks:()=>state.tasks, bridge });
let batchingOutput = false;
function persist(client = '', notify = false, durable = false) {
  if (batchingOutput) return;
  writeFileSync(database + '.tmp', JSON.stringify(state));
  if(durable) { const fd=openSync(database+'.tmp','r');try { fsyncSync(fd); } finally { closeSync(fd); } }
  renameSync(database + '.tmp', database);
  if(durable) { const fd=openSync(root,'r');try { fsyncSync(fd); } finally { closeSync(fd); } }
  if (notify) for (const response of subscribers) response.write('data: ' + JSON.stringify({ client }) + '\n\n');
}
function json(res, code, value) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 48 * 1024 * 1024) throw new Error('请求超出 48 MiB 限制'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
async function managed(path, payload, submission) {
  const response = await fetch(bridge + path, { method: payload === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(submission ? { 'X-T8-Provider-Submission': submission } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const value = await response.json();
  if (!response.ok || value.success === false || value.error) throw new Error(formatGenerationError({ ...(typeof value === 'object' ? value : {}), httpStatus: response.status }));
  return value;
}
async function config() {
  const [catalog, settings] = await Promise.all([managed('/models'), managed('/plugins/kineo/settings')]);
  const models = Object.fromEntries(Object.entries(catalog.data).map(([kind, rows]) => [kind,
    settings.data.models[kind].flatMap(id => rows.filter(row => row.id === id))]));
  return { models, settings: settings.data };
}
function projects() { return JSON.parse(state.storage['kineo-project-storage-v2'] || '{"state":{"projects":[]},"version":0}').state.projects; }
function saveProjects(values, client = '') { state.storage['kineo-project-storage-v2'] = JSON.stringify({ state: { projects: values }, version: 0 }); persist(client, true); }
function project(id) { const value = projects().find(row => row.id === id); if (!value) throw new Error('Kineo 项目不存在'); return value; }
function updateProject(id, changes) { const values = projects(); const row = values.find(item => item.id === id); if (!row) throw new Error('Kineo 项目不存在'); Object.assign(row, changes, { id, updatedAt: new Date().toISOString() }); saveProjects(values); return row; }
function filePath(value) {
  const relative = value.startsWith('/files/') ? value.slice(7) : value;
  if (!relative || relative.includes('\\') || relative.split('/').some(part => ['', '.', '..'].includes(part))) throw new Error('成员文件路径无效');
  const path = resolve(fileRoot, relative);
  if (!path.startsWith(fileRoot + '/')) throw new Error('成员文件路径无效');
  return path;
}
const mime = path => ({ '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mov':'video/quicktime','.avi':'video/x-msvideo','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac','.ogg':'audio/ogg','.opus':'audio/ogg','.m4a':'audio/mp4','.json':'application/json','.txt':'text/plain','.srt':'text/plain' }[extname(path).toLowerCase()] || 'application/octet-stream');
async function localMedia(value, directory, task) {
  if (typeof value !== 'string') throw new Error('素材路径无效');
  if (value.startsWith(base + '/api/files/')) value = decodeURIComponent(value.slice((base + '/api/files/').length));
  if (value.startsWith(fileRoot + '/') && retention.binding(value)) value='/files/'+basename(value);
  if (value.startsWith('/files/')) {
    const path = filePath(value), bound = retention.binding(path);
    if (bound) return retention.materialize(bound.mediaRetention.assetId,directory,task?.id);
    if (task) {
      // Keep an unarchived input alive until this native consumer has finished.
      const release=retention.lease(path);taskInputLeases.get(task.id).push(release);
    }
    await stat(path);return path;
  }
  const match = /^\/(?:creative-managed|api)\/media\/([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw new Error('请先将素材上传或归档到当前成员空间');
  if (retention.managed(task)) return retention.materialize(match[1],directory,task.id);
  const path = join(directory, match[1]);
  if (existsSync(path)) return path;
  const response = await fetch(bridge + '/media/' + match[1]);
  if (!response.ok) throw new Error(formatGenerationError({ message: '成员素材读取失败', httpStatus: response.status }));
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  return path;
}
async function archive(path, assetType) {
  const response = await fetch(bridge + '/media/uploads', { method:'POST', duplex:'half',
    headers:{ 'content-type':mime(path),'content-length':String(statSync(path).size),
      'X-File-Name':encodeURIComponent(basename(path)), 'X-Asset-Type':assetType }, body:createReadStream(path) });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(formatGenerationError({ ...value, httpStatus:response.status }));
  return { assetId:value.assetId, url:'/creative-managed/media/' + encodeURIComponent(value.assetId), mimeType:value.mimeType };
}
async function native(command, args, nativeRoot = root) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.env.KINEO_NATIVE || join(here,'kineo-native'), [], { env:{...process.env,GREENROOM_PLUGIN_ROOT:nativeRoot}, stdio:['pipe','pipe','pipe'] });
    let output='', error=''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => error += value);
    child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error(formatGenerationError(error))); else { try { resolveResult(JSON.parse(output)); } catch { reject(new Error('Kineo 原生引擎返回格式异常')); } } });
    child.stdin.end(JSON.stringify({ command, arguments:args }));
  });
}
async function program(binary,args,task) {
  if(binary==='ffmpeg' && retention.managed(task)) retention.admit(task.id);
  return new Promise((resolveResult,reject)=>{
    const child=spawn(binary,args,{stdio:['ignore','pipe','pipe']});let output='',error='';
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
    child.on('error',reject);child.on('exit',code=>code===0?resolveResult(output):reject(new Error(formatGenerationError(error))));
  });
}
async function probe(path) {
  const data=JSON.parse(await program('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path]));
  const video=data.streams?.find(stream=>stream.codec_type==='video');
  return {duration:Number(data.format?.duration || 0),width:video?.width || 0,height:video?.height || 0,
    hasAudio:data.streams?.some(stream=>stream.codec_type==='audio')};
}
function subtitleTime(value) {const ms=Math.round(Number(value)*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;}
async function ffmpegJob(task) {
  const body=task.body,operation=body.operation,options=body.options || {};
  const directory=join(root,'tmp',task.id);mkdirSync(directory,{recursive:true});
  const format=body.outputFormat || options.format || 'mp4';
  if(!['mp4','webm','mov','avi'].includes(format))throw new Error('视频导出格式无效');
  const output=join(fileRoot,task.id+'.'+format),temporary=join(directory,'result.'+format);
  const videoCodec=options.videoCodec || (format==='webm'?'vp9':'h264');
  const codec={h264:'libx264',h265:'libx265',vp9:'libvpx-vp9',av1:'libaom-av1'}[videoCodec];
  if(!codec)throw new Error('视频编码格式无效');
  const encoding=['-c:v',codec,...(options.bitrate?['-b:v',String(options.bitrate)]:[]),'-c:a',format==='webm'?'libopus':'aac'];
  if(!existsSync(output)) {
    beginNative(task);
    if(operation==='compose_video' || operation==='concat_videos') {
      const scenes=body.scenes || await Promise.all((body.paths || []).map(async path=>({mediaPath:path,mediaType:'video',duration:(await probe(await localMedia(path,directory,task))).duration})));
      if(!scenes.length)throw new Error('合成场景不能为空');
      const width=options.resolution?.width || 1920,height=options.resolution?.height || 1080,fps=options.fps || 30;
      const segments=[];
      for(let index=0;index<scenes.length;index++) {
        const scene=scenes[index],input=await localMedia(scene.mediaPath,directory,task),segment=join(directory,'scene-'+index+'.mp4');
        const filters=[`scale=${width}:${height}:force_original_aspect_ratio=decrease`,`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,`fps=${fps}`,'setsar=1'];
        for(const effect of scene.effects || []) {
          if(effect.type==='fade_in')filters.push('fade=t=in:d='+Number(effect.duration));
          else if(effect.type==='fade_out')filters.push('fade=t=out:d='+Number(effect.duration));
          else throw new Error('原上游尚未实现此通用场景效果：'+effect.type);
        }
        await program('ffmpeg',['-y',...(scene.mediaType==='image'?['-loop','1']:[]),'-i',input,'-t',String(scene.duration),'-vf',filters.join(','),'-an','-c:v','libx264','-pix_fmt','yuv420p',segment],task);
        segments.push(segment);
      }
      const list=join(directory,'concat.txt');await writeFile(list,segments.map(path=>"file '"+path+"'").join('\n'));
      await program('ffmpeg',['-y','-f','concat','-safe','0','-i',list,...encoding,temporary],task);
    } else {
      const input=await localMedia(body.inputPath,directory,task),info=await probe(input);
      if(operation==='add_subtitles') {
        const subtitles=body.subtitles?.subtitles || [],style=body.style || {};
        const path=join(directory,'subtitles.srt');await writeFile(path,subtitles.map((entry,index)=>`${index+1}\n${subtitleTime(entry.startTime)} --> ${subtitleTime(entry.endTime)}\n${entry.text}\n`).join('\n'));
        const styles=[];
        if(style.fontSize)styles.push('FontSize='+Number(style.fontSize));
        if(style.font)styles.push('FontName='+String(style.font).replace(/[^\p{L}\p{N} _-]/gu,''));
        if(style.margin!==undefined)styles.push('MarginV='+Number(style.margin));
        if(style.position)styles.push('Alignment='+({top:8,center:5,bottom:2}[style.position] || 2));
        if(/^#[\da-f]{6}$/i.test(style.color || ''))styles.push('PrimaryColour=&H00'+style.color.slice(5,7)+style.color.slice(3,5)+style.color.slice(1,3));
        await program('ffmpeg',['-y','-i',input,'-vf',`subtitles=${path}${styles.length?":force_style='"+styles.join(',')+"'":''}`,...encoding,temporary],task);
      } else if(operation==='add_audio') {
        const music=body.music || {},audio=await localMedia(music.filePath,directory,task);
        const filters=[`volume=${Number(music.volume ?? 1)}`];
        if(music.fadeIn)filters.push(`afade=t=in:d=${Number(music.fadeIn)}`);
        if(music.fadeOut)filters.push(`afade=t=out:st=${Math.max(0,info.duration-Number(music.fadeOut))}:d=${Number(music.fadeOut)}`);
        const filter=`[1:a]${filters.join(',')}[bgm];`+(info.hasAudio?'[0:a][bgm]amix=inputs=2:duration=first[outa]':'[bgm]anull[outa]');
        await program('ffmpeg',['-y','-i',input,...(music.loop?['-stream_loop','-1']:[]),'-i',audio,'-filter_complex',filter,'-map','0:v','-map','[outa]','-t',String(info.duration),...encoding,temporary],task);
      } else if(operation==='export_video') {
        const filters=options.resolution?[`scale=${Number(options.resolution.width)}:${Number(options.resolution.height)}`]:[];
        await program('ffmpeg',['-y','-i',input,...(filters.length?['-vf',filters.join(',')]:[]),...(options.fps?['-r',String(options.fps)]:[]),...encoding,temporary],task);
      } else throw new Error('通用 FFmpeg 业务无效');
    }
    renameSync(temporary,output);
  }
  task.localOutput=output;task.status='archiving';persist();
  const info=await probe(output);
  const result={duration:info.duration,width:info.width,height:info.height,fileSize:statSync(output).size};
  if(retention.managed(task)) await deliver(task,result,'outputPath');
  else { task.outputs=[await archive(output,'video')];task.result={...result,outputPath:task.outputs[0].url};task.status='succeeded';applyOutput(task);await rm(directory,{recursive:true,force:true}); }
}
function applyOutput(task) {
  if (!task.projectId) return;
  const row = project(task.projectId), result = task.result;
  if (task.kind === 'script') {
    const shots = result.episodes.flatMap(episode => episode.scenes.flatMap(scene => scene.shots));
    const frames = shots.map(shot => ({ id:shot.id, title:shot.id, sceneDescription:shot.prompt,
      composition:'中心构图',cameraType:'medium',dialogue:shot.dialogue || '',duration:shot.duration_seconds,imageUrl:shot.image_url }));
    state.storage['kineo-storyboards-' + row.id] = JSON.stringify(frames);
    updateProject(row.id, { content:task.text || row.content, script:task.text || row.script,
      parsedScenes:result.episodes, characters:result.characters,storyboardFrames:frames });
  } else if (['image','video','tts'].includes(task.kind) && task.outputs?.length) {
    const field = { image:'imageUrl',video:'videoUrl',tts:'audioUrl' }[task.kind];
    const frames = row.storyboardFrames || JSON.parse(state.storage['kineo-storyboards-' + row.id] || '[]');
    const frame = frames.find(item => item.id === task.frameId);
    if (frame) frame[field] = task.outputs[0].url;
    state.storage['kineo-storyboards-' + row.id] = JSON.stringify(frames);
    updateProject(row.id, { storyboardFrames:frames, ...(task.kind === 'image' && !row.coverImage ? { coverImage:task.outputs[0].url } : {}) });
  } else if (['render','ffmpeg'].includes(task.kind) && task.outputs?.length) updateProject(row.id,{ videoPath:task.outputs[0].url,status:'completed' });
}
function beginNative(task) {
  if (!retention.managed(task)) return;
  if (task.mediaRetention.nativeStarted) throw new Error('上次本地处理结果未知，保留原任务临时文件，未自动重新执行');
  retention.admit(task.id);
  task.mediaRetention.nativeStarted=true;persist('',false,true);
}
async function deliver(task,result,pathField) {
  const output=retention.output(task);
  task.localOutput=output;task.status='archiving';task.mediaRetention.source=retention.stamp(output);persist('',false,true);
  const asset=await retention.archive(task,mime(output));
  const oldTask=structuredClone(task), oldStorage=structuredClone(state.storage);
  try {
    batchingOutput=true;
    task.outputs=[asset];task.result={...result,[pathField]:asset.url};task.status='succeeded';task.queryError=null;
    task.mediaRetention.assetId=asset.assetId;task.mediaRetention.ready=true;
    applyOutput(task);
    batchingOutput=false;persist('',true,true);
  } catch(error) {
    batchingOutput=false;
    for(const key of Object.keys(task)) delete task[key];Object.assign(task,oldTask);state.storage=oldStorage;
    throw error;
  }
  // Cleanup is deliberately after the single durable task/project/Asset binding.
  await retention.retire(task);
}
async function runTask(task) {
  if (running.has(task.id) || ['succeeded','failed'].includes(task.status)) return;
  running.add(task.id);taskInputLeases.set(task.id,[]);
  try {
    if (['image','video','tts','music'].includes(task.kind)) {
      if (!task.providerTaskId) {
        const response = await managed('/' + task.kind + '/submit', task.body, task.submissionId);
        task.providerTaskId = response.data.taskId; task.status='running'; persist();
      }
      let result;
      try { result = (await managed('/tasks/' + encodeURIComponent(task.providerTaskId))).data; }
      catch (error) { task.queryError = formatGenerationError(error.message); persist(); return; }
      task.status = result.status; task.outputs = result.outputs?.map(output => ({...output,url:output.assetId ? '/creative-managed/media/' + encodeURIComponent(output.assetId) : output.url})) || [];
      task.error = result.error || null; task.queryError = null;
      if (result.status === 'succeeded') applyOutput(task);
    } else if (task.kind === 'llm' || task.kind === 'script') {
      if (task.status === 'running' && !task.text && !task.result) throw new Error('上次文本请求结果未完整保存，未自动重新提交');
      task.status='running'; persist();
      if (task.body && !task.text) {
        const response = await managed('/chat/completions',task.body);
        task.result = response; task.text = response.choices?.[0]?.message?.content;
        if (typeof task.text !== 'string' || !task.text) throw new Error('文本模型未返回剧本');
        persist();
      }
      if (task.kind === 'script') {
        task.result = await native(task.mode === 'script' ? 'parse_direct_script' : 'parse_novel_to_script', { text:task.text, stylePreset:task.stylePreset });
        applyOutput(task);
      }
      task.status='succeeded';
    } else if (task.kind === 'ffmpeg') {
      task.status='running';persist();await ffmpegJob(task);
    } else if (['render','cut','preview'].includes(task.kind)) {
      task.status='running'; persist();
      const directory = retention.managed(task) ? retention.directory(task) : join(root,'tmp',task.id); mkdirSync(directory,{recursive:true});
      const params = structuredClone(task.body); params.project_id = task.projectId || task.id;
      if (!/^[A-Za-z0-9_-]+$/.test(params.project_id)) throw new Error('工程 ID 无效');
      let output=retention.managed(task) ? retention.output(task) : task.localOutput || join(fileRoot,task.id+'.mp4');
      params.output_path=retention.managed(task)?join(directory,'native-result.mp4'):task.kind==='render'?join(directory,'rendering.mp4'):output;
      if (!existsSync(output)) {
        beginNative(task);
        for (const scene of params.scenes || []) {
          scene.image_path=await localMedia(scene.image_path,directory,task);
          if(scene.audio_path) scene.audio_path=await localMedia(scene.audio_path,directory,task);
        }
        if(params.bgm_path) params.bgm_path=await localMedia(params.bgm_path,directory,task);
        if (task.kind !== 'render') params.input_path=await localMedia(params.input_path || params.inputPath,directory,task);
        if(retention.managed(task)) retention.admit(task.id);
        const result=await native({render:'render_full_video',cut:'cut_video',preview:'generate_preview'}[task.kind],{params},retention.managed(task)?directory:root);
        if(retention.managed(task)) {
          const produced=typeof result==='string'?result:params.output_path;
          retention.safe(produced,produced===output?fileRoot:directory);
          task.result=typeof result==='string'?{file_size:statSync(produced).size}:result;
          // A crash after canonical rename must retain every original RenderResult field.
          persist('',false,true);
          if(produced!==output) renameSync(produced,output);
        } else if (typeof result === 'string') { output=result; task.result={output_path:output,file_size:statSync(output).size}; }
        else { task.result=result;if(task.kind==='render'){renameSync(params.output_path,output);task.result.output_path=output;} }
      }
      else task.result ||= { output_path:output,file_size:statSync(output).size };
      task.localOutput=output; task.status='archiving'; persist();
      if(retention.managed(task)) await deliver(task,task.result,'output_path');
      else {
        task.outputs=[await archive(output,'video')];
        task.result={...task.result,output_path:task.outputs[0].url}; task.status='succeeded'; applyOutput(task);
        await rm(directory,{recursive:true,force:true});
      }
    }
    task.updatedAt=new Date().toISOString(); persist();
  } catch (error) {
    if (retention.managed(task) && task.mediaRetention.ready) { task.queryError=formatGenerationError(error.message); }
    else if (task.localOutput && existsSync(task.localOutput)) { task.status='archiving'; task.queryError=formatGenerationError(error.message); }
    else { task.status='failed'; task.error=formatGenerationError(error.message); }
    persist();
  } finally {
    for(const release of taskInputLeases.get(task.id) || []) await release().catch(()=>{});
    taskInputLeases.delete(task.id);running.delete(task.id);
  }
}
async function submit(kind,args,submissionId) {
  if(!['image','video','tts','music','llm','script','render','cut','preview','ffmpeg'].includes(kind)) throw new Error('Kineo 生成能力无效');
  const existing=Object.values(state.tasks).find(task=>submissionId && task.submissionId===submissionId);
  if(existing) return existing;
  if(args.projectId) project(args.projectId);
  const task={id:randomUUID(),kind,projectId:args.projectId,frameId:args.frameId,status:'pending',submissionId:submissionId || 'kineo:'+randomUUID(),createdAt:new Date().toISOString()};
  if(['image','video','tts','music','llm'].includes(kind) || (kind==='script' && args.idea)) {
    const capability=kind==='script'?'llm':kind;
    const {models,settings}=await config(); const options=models[capability];
    const model=args.model || options[0]?.id;
    if(!model || !options.some(row=>row.id===model)) throw new Error('此能力未配置或所选模型未获管理员启用');
    task.body={...(settings.parameters[capability] || {}),model};
    if(capability==='llm') task.body={...task.body,messages:args.messages || [{role:'system',content:'你是专业漫剧编剧。输出可直接拆分的中文剧本，包含明确分集、场景、角色与对白。'},{role:'user',content:args.idea ? `创作 ${args.episodes || 1} 集漫剧。创意：${args.idea}` : args.prompt}],stream:false};
    else for(const field of capability==='tts'?['text','voice','speed','response_format']:['prompt','size','aspect_ratio','duration','first_frame_url','images','resolution','n']) if(args[field]!==undefined) task.body[field]=args[field];
    if(capability==='llm') for(const field of ['temperature','max_tokens','top_p']) if(args[field]!==undefined) task.body[field]=args[field];
    if(capability==='tts' && !task.body.voice) task.body.voice='alloy';
  }
  if(kind==='script') { task.text=args.text; task.mode=args.mode; task.stylePreset=args.stylePreset; }
  if(['render','cut','preview','ffmpeg'].includes(kind)) task.body=args.params;
  const bound=Object.values(state.tasks).find(row=>submissionId && row.submissionId===submissionId);
  if(bound) return bound;
  if(['render','cut','preview','ffmpeg'].includes(kind)) {
    const format=kind==='ffmpeg'?(args.params.outputFormat || args.params.options?.format || 'mp4'):'mp4';
    if(!['mp4','webm','mov','avi'].includes(format)) throw new Error('视频导出格式无效');
    retention.admit();
    task.mediaRetention={version:1,format,logicalPath:'/files/'+task.id+'.'+format,archiveKey:'kineo:output:'+task.id};
  }
  state.tasks[task.id]=task; persist(); runTask(task).catch(()=>{}); return task;
}
async function restore() {
  for(const task of Object.values(state.tasks)) {
    if(retention.managed(task) && task.status==='succeeded' && task.mediaRetention.ready) await retention.retire(task).catch(()=>{});
    else if(!['succeeded','failed','cancelled'].includes(task.status)) runTask(task).catch(()=>{});
  }
  return Object.values(state.tasks);
}
async function business(operation,args={},submissionId) {
  switch(operation) {
    case 'list_projects':return projects();
    case 'create_project': { const now=new Date().toISOString(); const value={id:randomUUID(),name:args.name || '新项目',description:args.description || '',content:'',status:'draft',createdAt:now,updatedAt:now}; saveProjects([...projects(),value]); return value; }
    case 'get_project':return project(args.projectId);
    case 'update_project':return updateProject(args.projectId,args.changes);
    case 'parse_script':return submit('script',args,submissionId);
    case 'generate_script':return submit('script',args,submissionId);
    case 'generate_image':return submit('image',args,submissionId);
    case 'generate_video':return submit('video',args,submissionId);
    case 'synthesize_speech':return submit('tts',args,submissionId);
    case 'render_video':return submit('render',args,submissionId);
    case 'compose_video':return submit('ffmpeg',{projectId:args.projectId,params:{...args,operation:'compose_video'}},submissionId);
    case 'add_subtitles':return submit('ffmpeg',{projectId:args.projectId,params:{...args,operation:'add_subtitles'}},submissionId);
    case 'mix_audio':return submit('ffmpeg',{projectId:args.projectId,params:{...args,operation:'add_audio'}},submissionId);
    case 'export_video':return submit('ffmpeg',{projectId:args.projectId,params:{...args,operation:'export_video'}},submissionId);
    case 'list_tasks':return Object.values(state.tasks).filter(task=>!args.projectId || task.projectId===args.projectId);
    case 'get_task':if(!state.tasks[args.taskId]) throw new Error('任务不存在'); return state.tasks[args.taskId];
    case 'resume_tasks':return restore();
    default:throw new Error('此 Kineo 业务尚未开放');
  }
}
async function command(name,args={}) {
  if(name==='get_kineo_version') return '0.0.2';
  if(name==='check_runtime_dependencies') return {ffmpeg:true,ffprobe:true,managed:true};
  if(name==='check_ffmpeg') return {installed:true};
  if(name==='detect_hardware_accel') return {videotoolbox:false,nvenc:false,qsv:false,preferred:'software'};
  if(['show_window','hide_window','show_main_window','hide_main_window'].includes(name)) return null;
  if(name==='get_app_data_path') return '/files';
  if(name==='read_project_file') return state.storage['project_'+args.projectId] || '{}';
  if(name==='save_project_file') { state.storage['project_'+args.projectId]=args.contents; persist(); return null; }
  if(name==='read_text_file') return readFile(filePath(args.path),'utf8');
  if(name==='write_text_file') { const path=filePath(args.path); await writeFile(path,args.content); return null; }
  if(name==='parse_novel_to_script' || name==='parse_direct_script') return native(name,args);
  if(name==='generate_script_from_idea') return submit('script',{...args,idea:args.idea});
  if(name==='render_full_video') return submit('render',{projectId:args.params.project_id,params:args.params});
  if(['compose_video','add_subtitles','add_audio','concat_videos'].includes(name) || (name==='export_video' && args.inputPath && !args.segments)) return submit('ffmpeg',{params:{...args,operation:name}});
  if(['cut_video','export_video','generate_preview'].includes(name)) {
    const value=args.params || args;
    const params={...value,input_path:value.input_path || value.inputPath,
      transition_duration:value.transition_duration ?? value.transitionDuration,add_subtitles:value.add_subtitles ?? value.addSubtitles};
    return submit(name==='generate_preview'?'preview':'cut',{params});
  }
  if(['analyze_video','extract_key_frames','generate_thumbnail'].includes(name)) {
    const id=randomUUID(),directory=join(root,'tmp',id); mkdirSync(directory,{recursive:true});taskInputLeases.set(id,[]);
    try {
      const result=await native(name,{...args,path:await localMedia(args.path,directory,{id})});
      if(name==='analyze_video') { await rm(directory,{recursive:true,force:true}); return result; }
      const paths=Array.isArray(result)?result:[result],outputs=[];
      for(const path of paths) outputs.push((await archive(path,'image')).url);
      await rm(directory,{recursive:true,force:true}); return Array.isArray(result)?outputs:outputs[0];
    } finally { for(const release of taskInputLeases.get(id)) await release().catch(()=>{});taskInputLeases.delete(id); }
  }
  throw new Error('此桌面专用操作未在 Web 版开放：'+name);
}
let activeRequests=0;
const server=createServer(async(req,res)=>{
  if(req.url==='/api/greenroom/lifecycle')return json(res,200,{known:true,busy:Boolean(activeRequests||running.size)});
  activeRequests++;
  try {
    const url=new URL(req.url,'http://127.0.0.1'); let path=url.pathname;
    if(path.startsWith(base+'/')) path=path.slice(base.length);
    if(path==='/api/bootstrap' && req.method==='GET') return json(res,200,{storage:state.storage,...await config()});
    if(path==='/api/state' && req.method==='PUT') {
      const payload=await body(req);
      if(typeof payload.key!=='string' || /(?:api.*key|ai_model_settings|secure_.*(?:key|token|settings))/i.test(payload.key)) throw new Error('API 配置仅由管理员管理');
      if(payload.value===null) delete state.storage[payload.key]; else if(typeof payload.value==='string') state.storage[payload.key]=payload.value; else throw new Error('工程数据格式无效');
      persist(req.headers['x-kineo-client'], true); return json(res,200,{saved:true});
    }
    if(path==='/api/events') { res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'}); res.write('\n'); subscribers.add(res); req.on('close',()=>subscribers.delete(res)); return; }
    if(path==='/api/business' && req.method==='POST') { const payload=await body(req); return json(res,200,await business(payload.operation,payload.arguments,payload.submissionId)); }
    if(path==='/api/jobs' && req.method==='POST') { const payload=await body(req); return json(res,200,await submit(payload.kind,payload.arguments || {},payload.submissionId)); }
    if(path.startsWith('/api/tasks/') && req.method==='GET') { const task=state.tasks[path.slice(11)]; if(!task) return json(res,404,{error:'任务不存在'}); return json(res,200,task); }
    if(path==='/api/restore' && req.method==='POST') return json(res,200,await restore());
    if(path==='/api/invoke' && req.method==='POST') { const payload=await body(req); return json(res,200,await command(payload.command,payload.arguments)); }
    if(path==='/api/files' && req.method==='POST') {
      const name=decodeURIComponent(req.headers['x-file-name'] || 'input.bin'); const id=randomUUID()+extname(basename(name)); const path=join(fileRoot,id);
      let size=0; async function* chunks(){for await(const chunk of req){size+=chunk.length;if(size>512*1024*1024) throw new Error('素材超出 512 MiB 限制');yield chunk;}}
      await pipeline(chunks(),createWriteStream(path)); return json(res,200,{path:'/files/'+id,name,size});
    }
    if(path.startsWith('/api/files/') && req.method==='GET') {
      const file=filePath(decodeURIComponent(path.slice(11))), bound=retention.binding(file);
      if(bound) {
        const response=await fetch(bridge+'/media/'+bound.mediaRetention.assetId,{headers:req.headers.range?{range:req.headers.range}:{}});
        const headers={'cache-control':'no-store'};
        for(const key of ['content-type','content-length','content-range','accept-ranges']) if(response.headers.has(key)) headers[key]=response.headers.get(key);
        res.writeHead(response.status,headers);if(response.body) await pipeline(Readable.fromWeb(response.body),res);else res.end();return;
      }
      const release=retention.lease(file);
      try { const metadata=await stat(file);res.writeHead(200,{'content-type':mime(file),'content-length':metadata.size,'cache-control':'no-store'});await pipeline(createReadStream(file),res); }
      finally { await release(); } return;
    }
    if(path==='/api/read-text' && req.method==='POST') return json(res,200,await readFile(filePath((await body(req)).path),'utf8'));
    const dist=resolve(here,'../dist'); const target=resolve(dist,'.'+decodeURIComponent(path));
    if(!target.startsWith(dist+'/') && target!==dist) return json(res,404,{error:'页面不存在'});
    const file=existsSync(target) && statSync(target).isFile()?target:join(dist,'index.html');
    const type={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'}[extname(file)] || mime(file);
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'});createReadStream(file).pipe(res);
  }catch(error){if(res.headersSent)res.destroy();else json(res,400,{error:formatGenerationError(error.message)});}
  finally{activeRequests--;}
});
const timer=setInterval(()=>restore().catch(()=>{}),5000);timer.unref();
server.listen(Number(process.env.PORT || 18808),'127.0.0.1',()=>restore().catch(()=>{}));
process.on('SIGTERM',()=>{clearInterval(timer);server.close();});
