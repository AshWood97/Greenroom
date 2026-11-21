import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),renderer=require.resolve('@revideo/renderer/lib/server/render-video.js');
// Keep the configured Chromium process model; Revideo 0.11 forces a crashing single-process launch.
await writeFile(renderer,(await readFile(renderer,'utf8')).replace("    if (!args.includes('--single-process')) {\n        args.push('--single-process');\n    }\n",''));
