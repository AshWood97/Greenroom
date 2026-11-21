import {build} from 'vite';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url),revideo=require('@revideo/vite-plugin').default;
// Revideo 0.11 forces Chromium into one process, which crashes the native browser at launch.
const renderer=require.resolve('@revideo/renderer/lib/server/render-video.js');
await writeFile(renderer,(await readFile(renderer,'utf8')).replace("    if (!args.includes('--single-process')) {\n        args.push('--single-process');\n    }\n",''));
const wasm=require.resolve('@revideo/core/lib/exporter/WasmExporter.js');
await writeFile(wasm,(await readFile(wasm,'utf8')).replace('width: this.settings.size.x,','width: Math.round(this.settings.size.x * this.settings.resolutionScale),').replace('height: this.settings.size.y,','height: Math.round(this.settings.size.y * this.settings.resolutionScale),'));
await build({configFile:false,root:resolve('greenroom/renderer'),base:(process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH||'/plugins/openslop')+'/greenroom-player/',publicDir:false,plugins:[revideo({project:resolve('greenroom/renderer/project.ts'),buildForEditor:false}),{name:'openslop-preview-entry',enforce:'post',config(){return {build:{rollupOptions:{input:resolve('greenroom/renderer/preview.html')}}};}}],resolve:{alias:{'@':process.cwd()}},build:{outDir:resolve('public/greenroom-player'),emptyOutDir:true}});
