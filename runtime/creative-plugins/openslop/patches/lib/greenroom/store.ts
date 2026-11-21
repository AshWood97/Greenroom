import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export const root = process.env.GREENROOM_PLUGIN_ROOT || '/var/lib/dsh/creative-plugins/openslop';
export const events = new EventEmitter();
events.setMaxListeners(0);
const directories = new Set(['projects', 'jobs', 'versions', 'element-history', 'conversations', 'messages', 'bundles', 'runs', 'account']);
const safe = (value: string) => { if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..') throw new Error('业务编号无效'); return value; };
function filename(table: string, id: string) {
  if (!directories.has(table)) throw new Error('未知业务存储');
  return join(root, table, safe(id) + '.json');
}
export async function readRow<T = any>(table: string, id: string): Promise<T | null> {
  try { return JSON.parse(await readFile(filename(table, id), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeRow(table: string, id: string, value: unknown) {
  const file = filename(table, id); await mkdir(join(root, table), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp'; await writeFile(temporary, JSON.stringify(value)); await rename(temporary, file);
}
export async function listRows<T = any>(table: string): Promise<T[]> {
  if (!directories.has(table)) throw new Error('未知业务存储');
  let names: string[]; try { names = await readdir(join(root, table)); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readRow<T>(table, name.slice(0, -5)))) as Promise<T[]>;
}
export async function deleteRow(table: string, id: string) { await rm(filename(table, id), { force: true }); }
export async function getProject(id: string) { const project = await readRow('projects', id); if (!project) throw new Error('当前成员没有此工程'); return project; }
const projectWrites = new Map<string,Promise<unknown>>();
export async function mutateProject(id:string,update:(project:any)=>Record<string,unknown>,change:string|false=false) {
  const operation=(projectWrites.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
    const project=await getProject(id),next={...project,...update(project),id,updated_at:new Date().toISOString()};
    await writeRow('projects',id,next);if(change)events.emit('project:'+id,{project:next,change});return next;
  });projectWrites.set(id,operation);try{return await operation;}finally{if(projectWrites.get(id)===operation)projectWrites.delete(id);}
}
export async function saveProject(id:string,patch:Record<string,unknown>,external=false){return mutateProject(id,()=>patch,external?'document':false);}
export async function createProject(title = 'Untitled') {
  const id = randomUUID(), timestamp = new Date().toISOString();
  const value = { id, name: title, thumbnail_url: null, script: '', store: { title }, generation: {}, created_at: timestamp, updated_at: timestamp };
  await writeRow('projects', id, value); return value;
}
export const member = { id: 'greenroom-member', email: 'member@greenroom.local', app_metadata: { api_access: true },
  user_metadata: { full_name: 'Greenroom', models: {} } };
