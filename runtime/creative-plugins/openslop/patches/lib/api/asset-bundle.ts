import { z } from 'zod';
import { apiFetch } from '@/lib/clients/http';
const BundleContentsSchema = z.object({result:z.record(z.string(),z.string()),metadata:z.record(z.string(),z.unknown()).optional()});
export const BundleResponseSchema = BundleContentsSchema.extend({id:z.string(),type:z.string(),provider:z.string()});
export type BundleResponse = z.infer<typeof BundleResponseSchema>;
export type BundleFileData = {key:string;filename:string;contentType:string;data:Buffer|ArrayBuffer|string};
export type BundleFileRemote = {key:string;filename:string;contentType:string;url:string};
export type BundleFile = BundleFileData|BundleFileRemote;
export class EmptyRemoteFileError extends Error {}
export class AssetBundle {
  static baseUrl = process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH || '/plugins/openslop';
  constructor(readonly url:string,readonly manifest:z.infer<typeof BundleContentsSchema>){}
  get durationSec(){return Number(this.manifest.metadata?.durationSec || 0);}
  resolve(key:string){const value=this.manifest.result[key];if(!value)throw new Error('素材包缺少 '+key);return /^https?:\/\//.test(value)||value.startsWith('/')?value:this.url+'/'+value;}
  async fetchJson<T>(key:string,schema:z.ZodType<T>):Promise<T>{const response=await apiFetch(this.resolve(key));return schema.parse(await response.json());}
  static buildUrl(type:string,provider:string,id:string){return `${this.baseUrl}/assets/${type}/${provider}/${id}`;}
  static holds(url:string){return url.startsWith(this.baseUrl+'/assets/')||url.startsWith(this.baseUrl+'/media/');}
  static fromResponse(value:BundleResponse){return new AssetBundle(this.buildUrl(value.type,value.provider,value.id),value);}
  static async load(type:string,provider:string,id:string):Promise<BundleResponse|null>{try{const response=await apiFetch(this.buildUrl(type,provider,id)+'/manifest.json');return {id,type,provider,...BundleContentsSchema.parse(await response.json())};}catch{return null;}}
}
