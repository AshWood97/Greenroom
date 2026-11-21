import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.GREENROOM_PLUGIN_ROOT || '/data/aid';
const sourceRoot = process.env.AID_ROOT || '/opt/aid';
const bindHost = process.env.BIND_HOST || '0.0.0.0';
mkdirSync(root, { recursive: true });
const backend = spawn('java', ['-jar', join(sourceRoot, 'aid-admin.jar'), '--server.port=18827', '--server.address=' + bindHost], {
  stdio: 'inherit', env: { ...process.env, GREENROOM_MANAGED: 'true', AID_PROFILE: join(root, 'private-files'), LOG_PATH: join(root, 'logs') },
});
const frontend = spawn(process.execPath, [join(sourceRoot, 'frontend/web/server.js')], {
  cwd: join(sourceRoot, 'frontend/web'), stdio: 'inherit', env: { ...process.env, NEXT_PROXY_TARGET: 'http://127.0.0.1:18827', HOSTNAME: '127.0.0.1', PORT: '18817' },
});
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    try {
      const [api, ui] = await Promise.all([fetch('http://127.0.0.1:18827/greenroom/health'), fetch('http://127.0.0.1:18817/plugins/aid-studio')]);
      const body = await api.json();
      if (!api.ok || body.code !== 200 || !ui.ok) throw new Error('starting');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ready":true}');
    } catch { res.writeHead(503, { 'content-type': 'application/json' }).end('{"ready":false}'); }
    return;
  }
  const member = req.headers['x-greenroom-member'];
  if (typeof member !== 'string' || !member) { res.writeHead(403).end(); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  const uiApi = url.pathname.startsWith('/plugins/aid-studio/url/');
  const ui = !uiApi && url.pathname.startsWith('/plugins/aid-studio');
  // Next.js redirects the trailing-slash entry; serve it directly through the broker.
  const businessPath = uiApi ? url.pathname.replace(/^\/plugins\/aid-studio\/url/, '')
    : url.pathname === '/plugins/aid-studio/' ? '/plugins/aid-studio' : url.pathname;
  const blocked = (uiApi && businessPath.startsWith('/greenroom'))
    || /\/(?:system|monitor|tool|login|register|auth)(?:\/|$)/.test(businessPath)
    || (businessPath.startsWith('/aid/') && !['/aid/agent/info', '/aid/agent/list'].includes(businessPath))
    || /(?:userAiConfig|aiProvider|aiModel|api-key|apiKey|ai-config|provider-config|api-config)/i.test(businessPath);
  if (blocked) { res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 403, msg: 'API 配置由 Greenroom 管理员统一管理' })); return; }
  const outgoing = request({ hostname: '127.0.0.1', port: ui ? 18817 : 18827, path: businessPath + url.search,
    method: req.method, headers: { ...req.headers, 'x-greenroom-member': member } }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  outgoing.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 503, msg: 'AID 服务正在启动' })); else res.destroy(); });
  req.on('aborted', () => outgoing.destroy());
  req.pipe(outgoing);
});
server.listen(Number(process.env.PORT || 18807), bindHost);
let stopping = false;
function stop() { if (stopping) return; stopping = true; server.close(); backend.kill('SIGTERM'); frontend.kill('SIGTERM'); }
backend.on('exit', stop); frontend.on('exit', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
