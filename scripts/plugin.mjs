import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { plugins } from '../lib/catalog.mjs';
import { bridgeKey } from '../lib/credentials.mjs';

const plugin = plugins.find(entry => entry.id === process.argv[2]);
if (!plugin) {
  console.error('用法：npm run plugin -- <插件 ID>');
  process.exit(1);
}
const data = resolve(process.env.GREENROOM_DATA ?? '.greenroom');
const port = Number(process.env.GREENROOM_PORT ?? 3210);
const key = readFileSync(resolve(data, 'key'));
console.log('Base URL: http://127.0.0.1:' + port + '/gateway/' + plugin.id + '/v1');
console.log('API Key: ' + bridgeKey(key, plugin.id));
