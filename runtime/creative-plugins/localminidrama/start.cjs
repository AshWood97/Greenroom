const fs = require('node:fs');
const path = require('node:path');
async function start() {
  const root = path.resolve(process.env.GREENROOM_PLUGIN_ROOT);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  process.env.TMPDIR = path.join(root, 'tmp');
  process.env.LOG_FILE = path.join(root, 'localminidrama.log');
  const response = await fetch((process.env.GREENROOM_MANAGED_URL || 'http://127.0.0.1:18767/managed') + '/models');
  const catalog = await response.json();
  if (!response.ok || catalog.success === false) throw new Error(catalog.error?.message || catalog.message || '无法读取托管模型');
  process.env.GREENROOM_MODELS = JSON.stringify(catalog.data ?? catalog);
  const settingsResponse = await fetch((process.env.GREENROOM_MANAGED_URL || 'http://127.0.0.1:18767/managed') + '/plugins/localminidrama/settings');
  const settings = await settingsResponse.json();
  if (!settingsResponse.ok || settings.success === false) throw new Error(settings.error?.message || settings.message || '无法读取托管参数');
  process.env.GREENROOM_SETTINGS = JSON.stringify(settings.data ?? settings);
  require('./src/server.js');
}
start().catch(error => { console.error(error.message); process.exitCode = 1; });
