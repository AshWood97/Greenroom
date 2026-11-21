import {readFile,writeFile,mkdir,cp,symlink} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import { renderVideo } from '@revideo/renderer';

async function main(){
const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
const source=dirname(fileURLToPath(import.meta.url)),directory=dirname(plan.output),work=join(directory,'scene');
await mkdir(work,{recursive:true});
await cp(join(source,'scene.tsx'),join(work,'scene.tsx'));await cp(join(source,'visuals.ts'),join(work,'visuals.ts'));
await writeFile(join(work,'project.ts'),`import {makeProject} from '@revideo/core';import scene from './scene?scene';export default makeProject({scenes:[scene],settings:${JSON.stringify({rendering:{fps:plan.fps||30}})}});`);
await symlink(join(source,'node_modules'),join(work,'node_modules'),'dir').catch(error=>{if(error.code!=='EEXIST')throw error;});
const mediaOrigin='http://127.0.0.1:'+(process.env.PORT||'18811'),mediaBase=mediaOrigin+'/media/';
const localUrl=value=>typeof value==='string'&&value.startsWith(mediaBase)?'/greenroom-media/'+value.slice(mediaBase.length):value;
for(const cut of plan.cuts){for(const key of ['source','backgroundImage','backgroundVideo'])if(cut[key])cut[key]=localUrl(cut[key]);if(cut.images)cut.images=cut.images.map(localUrl);}
plan.mediaSizes=Object.fromEntries(Object.entries(plan.mediaSizes||{}).map(([key,value])=>[localUrl(key),value]));
process.chdir(work);
await renderVideo({
  projectFile: './project.ts', variables: { plan },
  settings: {
    outDir: dirname(plan.output), outFile: basename(plan.output), workers: 1, logProgress: false,
    projectSettings: { size: { x: plan.width, y: plan.height }, range: [0, plan.duration] },
    puppeteer: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'] },
    viteConfig:{cacheDir:join(directory,'vite-cache'),optimizeDeps:{include:['@revideo/core','@revideo/2d','@revideo/renderer/lib/client/render']},server:{fs:{allow:[source,work]},proxy:{'/greenroom-media/':{target:mediaOrigin,rewrite:path=>'/media/'+path.slice('/greenroom-media/'.length)}}}},
  },
});
}
main().catch(error=>process.stderr.write(String(error.message||error)+'\n',()=>process.exit(1)));
