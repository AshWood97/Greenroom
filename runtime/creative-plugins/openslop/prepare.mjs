import {readFile,writeFile,cp,mkdir,rm,readdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const integration=dirname(fileURLToPath(import.meta.url)),target=resolve(process.argv[2]||'/opt/openslop');
const read=path=>readFile(join(target,path),'utf8'),write=(path,text)=>writeFile(join(target,path),text);
async function edit(path,from,to){const content=await read(path);if(!content.includes(from))throw new Error('固定上游补丁位置不存在: '+path);await write(path,content.replace(from,to));}
await cp(join(integration,'patches'),target,{recursive:true});await mkdir(join(target,'greenroom'),{recursive:true});
for(const file of ['backend.ts','start.ts','tools.json'])await cp(join(integration,file),join(target,'greenroom',file));
await cp(join(integration,'renderer'),join(target,'greenroom','renderer'),{recursive:true});
const packageJson=JSON.parse(await read('package.json'));
for(const name of Object.keys(packageJson.dependencies))if(name==='remotion'||(name.startsWith('@remotion/')&&name!=='@remotion/captions')||name.startsWith('@vercel/')||name.startsWith('@supabase/'))delete packageJson.dependencies[name];
Object.assign(packageJson.dependencies,{'@revideo/2d':'0.11.0','@revideo/core':'0.11.0','@revideo/renderer':'0.11.0','@revideo/player-react':'0.11.0','@revideo/vite-plugin':'0.11.0','@revideo/ui':'0.11.0','@revideo/telemetry':'0.11.0',tsx:'4.20.6',vite:'5.4.21'});
packageJson.scripts={build:'node greenroom/build-preview.mjs && next build',start:'node --import tsx greenroom/start.ts'};
delete packageJson.devDependencies.supabase;
await write('package.json',JSON.stringify(packageJson,null,2)+'\n');
await write('next.config.ts',`import type {NextConfig} from 'next';
const config:NextConfig={basePath:process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH||'/plugins/openslop',images:{unoptimized:true},experimental:{optimizePackageImports:['radix-ui','@dnd-kit/core','@dnd-kit/sortable','@dnd-kit/utilities','lodash']}};
export default config;\n`);
for(const path of ['app/api','app/auth','app/login','remotion','remotion.config.ts','proxy.ts','middleware.ts','lib/supabase','lib/api/queue-callback.ts','lib/api/upload-route.ts','app/components/player/project-preview.module.css'])await rm(join(target,path),{recursive:true,force:true});
// The AI SDK transport bypasses apiFetch, so mount its URL explicitly as well.
await edit('lib/agent/client.ts','`${apiPrefixFor(model.provider)}/agent`',"`${process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH||'/plugins/openslop'}${apiPrefixFor(model.provider)}/agent`");
await edit('lib/project/saved-project.ts','import { selectColumns } from "@/lib/supabase/select-columns";','');
await edit('lib/project/saved-project.ts','selectColumns(SavedProjectSchema)','Object.keys(SavedProjectSchema.shape).join(",")');
await edit('lib/project/saved-project.ts','import { z } from "zod";',`import { z } from "zod";
import { migrateLegacyTimeline } from "@/lib/greenroom/legacy-timeline";`);
await edit('lib/project/saved-project.ts','export const parseSavedProject = (raw: unknown): SavedProject =>\n\tSavedProjectSchema.parse(raw);',`export const parseSavedProject = (raw: unknown): SavedProject => {
  const project = SavedProjectSchema.parse(raw);
  return {...project, script:migrateLegacyTimeline(project.script)};
};`);
await edit('lib/canvas/element-attributes.ts','\t"trimEnd",\n] as const;',`\t"trimEnd",
	"holdDuration",
] as const;`);
await edit('lib/canvas/element-attributes.ts','export function getMotion(element: ContentElement): MotionEffect {',`export const getHoldDuration = (element: ContentElement): number | undefined =>
  clampedNumber(element.layoutAttributes?.holdDuration, { min: 0 });

export function getMotion(element: ContentElement): MotionEffect {`);
await edit('lib/connectors/video/attributes.ts','\t\ttrimEndDef,\n\t]);',`		trimEndDef,
		{ key: "holdDuration", label: "Scene hold" },
	]);`);
await edit('lib/render/types.ts','\tmediaDurationSec: number;',`	mediaDurationSec: number;
	holdDurationSec?: number;`);
await edit('lib/render/resolve.ts','\tgetVolume,\n} from "../canvas/element-attributes";',`	getVolume,
	getHoldDuration,
} from "../canvas/element-attributes";`);
await edit('lib/render/resolve.ts','\t\t\t\t...trim,\n\t\t\t\tmediaDurationSec,',`				...trim,
				holdDurationSec: getHoldDuration(element),
				mediaDurationSec,`);
await edit('lib/render/scene-builder.ts','series.push(sequenceAt(element, cursor, MIN_DURATION_SEC));','series.push(sequenceAt(element, cursor, Math.max(MIN_DURATION_SEC, onGrid(element.holdDurationSec ?? 0))));');
await edit('lib/canvas/editor-ops.ts','mergeAttrs(editor, id, { [TRIM_KEYS[edge]]: String(round(sec, 2)) });','mergeAttrs(editor, id, { [TRIM_KEYS[edge]]: String(round(sec, 2)), holdDuration: null });');
await edit('lib/canvas/editor-ops.ts','const keys = edges.map((edge) => TRIM_KEYS[edge]);','const keys = [...edges.map((edge) => TRIM_KEYS[edge]), "holdDuration"];');
const config=JSON.parse(await read('tsconfig.json'));config.exclude=['node_modules','.next','**/__tests__/**','tests','e2e','scripts','lib/api/jobs.ts','lib/api/route-handler.ts','lib/api/queue.ts','lib/api/*-route.ts','lib/providers/anthropic','lib/providers/cartesia','lib/providers/elevenlabs','lib/providers/runware','lib/providers/openslop','lib/auth','lib/supabase'];
await write('tsconfig.json',JSON.stringify(config,null,2));
const apiFiles=new Set(['agent-turn.ts','asset-bundle.ts','auth.ts','conversations.ts','error-envelope.ts','image-source.ts','jobs.ts','logger.ts','projects.ts','provider-keys.ts','request-schema-fields.ts','sse.ts']);
for(const entry of await readdir(join(target,'lib/api'),{withFileTypes:true}))if(!apiFiles.has(entry.name))await rm(join(target,'lib/api',entry.name),{recursive:true,force:true});
for(const entry of await readdir(join(target,'lib/providers'),{withFileTypes:true}))if(!['base.ts','poll.ts','timestamps-file.ts','llm'].includes(entry.name))await rm(join(target,'lib/providers',entry.name),{recursive:true,force:true});
for(const entry of await readdir(join(target,'lib/providers/llm'),{withFileTypes:true}))if(!['base.ts','agent-model.ts'].includes(entry.name))await rm(join(target,'lib/providers/llm',entry.name),{recursive:true,force:true});
await edit('lib/api/agent-turn.ts','\tllm: () => Promise<LLMProvider>;','\tllm: () => Promise<LLMProvider>;\n\tsignal?:AbortSignal;\n\tparameters?:{temperature?:number;max_tokens?:number;top_p?:number};');
await edit('lib/api/agent-turn.ts','\tconst result = streamText({','\tconst result = streamText({\n\t\tmaxRetries:0,\n\t\tabortSignal:request.signal,\n\t\ttemperature:request.parameters?.temperature,\n\t\tmaxOutputTokens:request.parameters?.max_tokens,\n\t\ttopP:request.parameters?.top_p,');
await write('lib/providers/base.ts',`import type {ValidationResult} from '@/lib/connectors/provider-key';export type WithMetadata<T extends Record<string,unknown>=Record<string,unknown>>={metadata?:T};export type Priced<T>={output:T;costUsd:number};export interface ProviderContract{validate():Promise<ValidationResult>;}\n`);
await edit('app/layout.tsx','import { Instrument_Serif } from "next/font/google";','');
await edit('app/layout.tsx','const instrumentSerif = Instrument_Serif({','const instrumentSerif = localFont({ src: "../public/fonts/Sentient.woff2",');
await edit('app/layout.tsx','\n\tsubsets: ["latin"],','');
await edit('lib/connectors/models.ts','/**\n * Every model',`export type ManagedCatalog={models:Record<string,{id:string;label?:string;provider_label?:string;title?:string;name?:string;description?:string;resolutions?:string[]}[]>;parameters?:Record<string,unknown>};
export function installManagedModels(config:ManagedCatalog){
  const images=config.models.image||[];
  const otherIds=new Set(Object.entries(config.models).filter(([kind])=>kind!=='image').flatMap(([,entries])=>entries.map(entry=>entry.id)));
  (globalThis as any).__greenroomImageLabels=Object.fromEntries(images.filter(entry=>!otherIds.has(entry.id)&&entry.label).map(entry=>{
    const same=images.filter(other=>other.label===entry.label);
    const channel=entry.provider_label&&same.filter(other=>other.provider_label===entry.provider_label).length===1?entry.provider_label:entry.id;
    return [entry.id,same.length>1?entry.label+' ('+channel+')':entry.label];
  }));
  for(const type of CONNECTOR_TYPES){const kind=type==='voice'?'tts':type;const entries=config.models[kind]||[];
    const table=Object.fromEntries(entries.map(entry=>[entry.id,{id:entry.id,cost:'medium',speed:'medium',description:entry.title||entry.name||entry.description||entry.id,...(type==='image'?{name:entry.label||entry.title||entry.name||entry.description||entry.id}:{}),...(['image','video'].includes(type)?{resolutions:entry.resolutions?.filter(value=>['720p','1080p','1152p','1440p'].includes(value)).length?entry.resolutions:['720p','1080p']}: {})}]));
    MODELS[type]={openslop:table} as any;DEFAULT_MODELS[type]={provider:'openslop',model:entries[0]?.id||'greenroom-unconfigured-'+kind};
  }
}
/**
 * Every model`);
await edit('lib/connectors/models.ts','if (!entry)\n\t\tthrow new Error',`if(!entry&&ref.model.startsWith('greenroom-unconfigured-'))return {id:ref.model,description:'管理员尚未配置此能力',cost:'medium',speed:'medium',resolutions:['720p']} as ModelEntries[T];
  if (!entry)
    throw new Error`);
await edit('lib/connectors/provider-catalog.ts','name: "OpenSlop",','name: "Greenroom",');
await edit('lib/connectors/provider-catalog.ts','description: "Hosted models, included with your account. No key needed.",','description: "模型及生成参数由管理员统一配置。",');
await edit('lib/connectors/types.ts','const WordsSchema = z.array(CaptionSchema).optional().catch(undefined);',`const WordsSchema = z.preprocess(value=>Array.isArray(value)?value.map(word=>word&&typeof word==='object'&&word.startMs===undefined&&typeof word.start==='number'&&typeof word.end==='number'?{text:word.text,startMs:word.start*1000,endMs:word.end*1000,timestampMs:null,confidence:null}:word):value,z.array(CaptionSchema).optional().catch(undefined));`);
await edit('lib/connectors/types.ts','\tvoiceId: z.string().optional(),\n});',`	voiceId: z.string().optional(),
}).transform(result=>{result.originalTextTimestamps??=result.textTimestamps;return result;});`);
await edit('lib/connectors/types.ts','export interface PluginContext {','export interface PluginContext {\n greenroom?:{projectId:string;elementId:string;runId?:string;submissionId?:string;inputs?:unknown;connectorType?:string};');
await edit('lib/connectors/base.ts','const result = await this._generate(prepared, ctx.signal);','const result = await this._generate({...prepared,...(ctx.greenroom?{__greenroom:ctx.greenroom}:{})}, ctx.signal);');
await edit('lib/generation/generate-for-element.ts','export function generateForElement(','let managedProjectId="";\nexport function setManagedProject(id:string){managedProjectId=id;}\nexport function generateForElement(');
await edit('lib/generation/generate-for-element.ts','{ job, inputs }: GenerationNode,','{ id, job, inputs }: GenerationNode,');
await edit('lib/generation/generate-for-element.ts','{ dependencies, reads: inputs.reads, signal },',`{ dependencies, reads: inputs.reads, signal,greenroom:{projectId:managedProjectId,elementId:id,submissionId:crypto.randomUUID(),connectorType:job.connectorType,inputs:{...inputs,dependencies:Object.fromEntries(Object.entries(dependencies).map(([key,result])=>[key,[result.imageUrl,result.audioUrl,result.videoUrl,result.voiceId].filter(Boolean).join('|')]))}} },`);
await edit('lib/generation/queue.ts','\n\tsetError(elementId:',`\n restoreManagedGeneration(elementId:string,patch:Partial<ElementSnapshot>){this.snapshots.update(elementId,patch);this.snapshots.notify();if(patch.status==='idle')this.processQueue();}
\tsetError(elementId:`);
await edit('lib/connectors/voice/connector.ts','const { url, durationSec } = await this.tts.voicePreview(voiceId);\n\t\treturn { voiceId, audioUrl: url, durationSec };','return { voiceId, durationSec: 0 };');
await edit('lib/connectors/video/start-frame.ts','URL.canParse(frame)',`(URL.canParse(frame)||frame.startsWith((process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH||'/plugins/openslop')+'/media/'))`);
await edit('lib/connectors/video/start-frame.ts','z.union([z.enum([NO_FRAME, PREVIOUS_VISUAL]), z.url()])',`z.union([z.enum([NO_FRAME, PREVIOUS_VISUAL]), z.url(), z.string().startsWith((process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH||'/plugins/openslop')+'/media/')])`);
await edit('lib/connectors/video/capture-frames.ts','import { memoAsync }','import {apiJson} from "@/lib/clients/http";\nimport { memoAsync }');
await edit('lib/connectors/video/capture-frames.ts','Promise.all(keys.map((key) => uploadFrame(videoUrl, key)));',`typeof window==='undefined'?apiJson<{frames:string[]}>('/api/greenroom/video-frames',{method:'POST',body:{sourceUrl:videoUrl,frames:keys}}).then(value=>value.frames):Promise.all(keys.map((key) => uploadFrame(videoUrl, key)));`);
await edit('app/components/canvas/canvas-providers.tsx','import { useEditorSession }','import { ManagedProjectSync } from "@/lib/greenroom/project-sync";\nimport { useEditorSession }');
await edit('app/components/canvas/canvas-providers.tsx','<ActiveCaptionFont />','<ActiveCaptionFont /><ManagedProjectSync />');
for(const path of ['app/components/player/player-control-context.tsx','app/components/player/use-player-state.ts','app/components/player/start-playback-at.ts']){
  const source=await read(path);await write(path,source.replace('import type { PlayerRef } from "@remotion/player";','import type { NativePlayer as PlayerRef } from "./native-player";'));
}
await edit('lib/user/account-store.ts','import { createClient } from "@/lib/supabase/client";','');
const account=await read('lib/user/account-store.ts');await write('lib/user/account-store.ts',account.replace(/const \{ error \} = await createClient\(\)\.auth\.updateUser\(\{[\s\S]*?if \(error\) throw new Error\(`Failed to save defaults: \$\{error.message\}`\);/,`await apiJson('/api/greenroom/account',{method:'PUT',body:{models}});`));
await write('lib/upload/upload-file.ts',`import {apiJson} from '@/lib/clients/http';import type {UploadKind} from './upload-files';
export async function uploadFile(kind:UploadKind,file:File):Promise<string>{const form=new FormData();form.set('file',file);return (await apiJson<{url:string}>('/api/upload/'+kind,{method:'POST',body:form})).url;}\n`);
await write('lib/auth/session.ts',`export async function signOut(){window.top?.postMessage({type:'greenroom:close-plugin'},location.origin);}export async function sendMagicLink(_input:{email:string;shouldCreateUser?:boolean;data?:Record<string,unknown>}){throw new Error('请从 Greenroom 工作台打开');}export async function signInWithGoogle(){throw new Error('登录由 Greenroom 统一管理');}\n`);
await write('app/components/settings/settings-dialog.tsx',`"use client";
import {DialogContent,DialogDescription,DialogTitle,MountedDialog} from '@/components/ui/dialog';import {useSettings} from '@/lib/settings/use-settings';import {ModelDefaultControl} from '@/app/components/models/model-default-control';import {MODEL_GROUPS} from '@/lib/connectors/model-groups';import {useAccount} from '@/lib/user/use-account';import {toastError} from '@/lib/toast-error';
export function SettingsDialog(){const settings=useSettings(),models=useAccount(state=>state.models),setModels=useAccount(state=>state.setModels);return <MountedDialog open={settings.tab!==null} onOpenChange={open=>!open&&settings.close()}><DialogContent><DialogTitle>创作模型</DialogTitle><DialogDescription>可用模型及默认参数由 Greenroom 管理员统一配置。</DialogDescription>{MODEL_GROUPS.map(({key,label,types})=><div key={key} className="flex items-center justify-between"><span>{label}</span><ModelDefaultControl types={types} tier="account" chain={{account:models}} label={label} onChange={patch=>void setModels(patch).catch(toastError)}/></div>)}</DialogContent></MountedDialog>;}\n`);
await edit('app/components/player/use-export.tsx','import { useCallback,','import { useProjectId } from "@/lib/project/project-provider";\nimport { useCallback,');
await edit('app/components/player/use-export.tsx','export function useExport() {','export function useExport() {\n const projectId=useProjectId();');
await edit('app/components/player/use-export.tsx','runRender(layout, resolution)','runRender(layout, resolution,projectId)');
await edit('lib/render/render-client.ts','resolution: Resolution,','resolution: Resolution,\n projectId:string,');
await edit('lib/render/render-client.ts','body: { inputProps: layout, resolution },','body: { inputProps: layout, resolution,projectId },');
await write('lib/render/render-api.ts',`import {z} from 'zod';import {RESOLUTIONS} from './resolutions';export const RenderRequest=z.object({inputProps:z.record(z.string(),z.unknown()),resolution:z.enum(RESOLUTIONS),projectId:z.string()});export const RenderHandle=z.object({renderId:z.string()});export type RenderHandle=z.infer<typeof RenderHandle>;export const RenderProgress=z.discriminatedUnion('type',[z.object({type:z.literal('progress'),progress:z.number()}),z.object({type:z.literal('done'),url:z.string(),size:z.number()}),z.object({type:z.literal('error'),message:z.string()})]);export type RenderProgress=z.infer<typeof RenderProgress>;\n`);
await edit('lib/render/motion-effects.ts','import { Easing, interpolate } from "remotion";','');
await edit('lib/render/motion-effects.ts','const easeInOut = Easing.inOut(Easing.ease);',`const easeIn=(x:number)=>{let a=0,b=1,t=x;for(let i=0;i<16;i++){t=(a+b)/2;const value=3*(1-t)*(1-t)*t*.42+3*(1-t)*t*t+t*t*t;if(value<x)a=t;else b=t;}return 3*(1-t)*t*t+t*t*t;};
const ease=(x:number)=>x<.5?easeIn(x*2)/2:1-easeIn((1-x)*2)/2;`);
const motion=await read('lib/render/motion-effects.ts');await write('lib/render/motion-effects.ts',motion.replace(/return interpolate\(frame, \[0, duration\], \[from, to\], \{[\s\S]*?\}\);/,`return from+(to-from)*ease(Math.max(0,Math.min(1,frame/duration)));`));
await edit('lib/render/motion-effects.ts','/** Subpixel safety margin',`export function motionComponents(effect:MotionEffect,frame:number,duration:number){return effect==='none'?ZERO:SPECS[effect](frame,Math.max(1,duration));}
/** Subpixel safety margin`);
await write('lib/render/audio-volume.ts',`import {fadeRamp} from './fade-ramp';export function audioVolume(multiplier:number,durationInFrames:number,fadeFrames:number):number|((frame:number)=>number){const ramp=fadeRamp(durationInFrames,fadeFrames);if(!ramp)return multiplier;return frame=>{const x=Math.max(ramp.input[0],Math.min(ramp.input.at(-1)!,frame));let i=1;while(i<ramp.input.length-1&&x>ramp.input[i])i++;return (ramp.output[i-1]+(ramp.output[i]-ramp.output[i-1])*(x-ramp.input[i-1])/(ramp.input[i]-ramp.input[i-1]))*multiplier;};}\n`);
for(const path of ['lib/render/transition-presentations.ts','lib/render/lambda-config.ts'])await rm(join(target,path),{force:true});
async function walk(dir){const result=[];for(const entry of await readdir(join(target,dir),{withFileTypes:true})){if(entry.name==='__tests__')continue;const path=dir+'/'+entry.name;if(entry.isDirectory())result.push(...await walk(path));else if(/\.tsx?$/.test(path))result.push(path);}return result;}
for(const dir of ['lib','app','components'])for(const path of await walk(dir)){
  let source=await read(path);source=source.replace(/from ["']@supabase\/supabase-js["']/g,'from "@/lib/greenroom/user"');
  source=source.replace(/(["'`])\/(fonts|effects|icons)\//g,(_,quote,folder)=>quote+'/plugins/openslop/'+folder+'/');
  source=source.replace(/(["'])\/(openslop-mark\.svg|openslop-wordmark\.svg)/g,(_,quote,file)=>quote+'/plugins/openslop/'+file);
  await write(path,source);
}
for(const path of ['app/components/models/model-default-control.tsx','app/components/models/model-select.tsx']){
  const source=await read(path);await write(path,source.replaceAll('{model.model}','{model.model.startsWith("greenroom-unconfigured-")?"未配置":((globalThis as any).__greenroomImageLabels?.[model.model]||model.model)}'));
}
await cp(join(integration,'renderer','build-preview.mjs'),join(target,'greenroom','build-preview.mjs'));
await edit('app/globals.css','url("/cursors/trim-start.svg")','url("/plugins/openslop/cursors/trim-start.svg")');
await edit('app/globals.css','url("/cursors/trim-end.svg")','url("/plugins/openslop/cursors/trim-end.svg")');
await edit('app/globals.css','url("/grain.png")','url("/plugins/openslop/grain.png")');
