import type {z} from 'zod';
import { ApiErrorEnvelope } from '@/lib/api/error-envelope';
export type QueryParams=Record<string,string|number|undefined>;
type RequestOptions={method?:string;body?:unknown;params?:QueryParams;signal?:AbortSignal};
export function buildUrl(url:string,params?:QueryParams){const query=new URLSearchParams(Object.entries(params||{}).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])).toString();return query?url+'?'+query:url;}
export class UnreachableError extends Error {constructor(cause:unknown){super('无法连接 OpenSlop 服务',{cause});this.name='UnreachableError';}}
export class ApiError extends Error {constructor(message:string,readonly requestId:string|null){super(message);this.name='ApiError';}}
export async function apiFetch(url:string,{method='GET',body,params,signal}:RequestOptions={}):Promise<Response>{
  const base=process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH||'/plugins/openslop';
  let target=url.startsWith('/')&&!url.startsWith(base+'/')?base+url:url;
  if(typeof window==='undefined'&&target.startsWith('/'))target=(process.env.GREENROOM_SELF_URL||'http://127.0.0.1:18809')+target;
  let response:Response;try{response=await fetch(buildUrl(target,params),{method,signal,...(body===undefined?{}:body instanceof FormData?{body}:{body:JSON.stringify(body),headers:{'content-type':'application/json'}})});}catch(error){if(error instanceof TypeError)throw new UnreachableError(error);throw error;}
  if(!response.ok){const data=await response.json().catch(()=>undefined);throw new ApiError(ApiErrorEnvelope.safeParse(data).data?.error||`${response.status} ${response.statusText}`,response.headers.get('x-vercel-id'));}return response;
}
export function apiJson<T>(url:string,schema:z.ZodType<T>,options?:RequestOptions):Promise<T>;
export function apiJson<T>(url:string,options?:RequestOptions):Promise<T>;
export async function apiJson<T>(url:string,schemaOrOptions?:z.ZodType<T>|RequestOptions,options?:RequestOptions):Promise<T>{
  const schema=schemaOrOptions&&'parse' in schemaOrOptions?schemaOrOptions:undefined;
  const value:unknown=await (await apiFetch(url,schema?options:schemaOrOptions as RequestOptions|undefined)).json();
  return schema?schema.parse(value):value as T;
}
