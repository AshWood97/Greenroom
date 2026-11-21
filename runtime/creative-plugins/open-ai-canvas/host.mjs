import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

const base = '/plugins/open-ai-canvas';
const root = process.env.GREENROOM_PLUGIN_ROOT;
mkdirSync(root, { recursive: true });
const sourceRoot = resolve(process.env.CANVAS_ROOT || '/opt/canvas');
const backend = spawn(process.env.CANVAS_BACKEND_BINARY || '/usr/local/bin/yingce-backend', [], { cwd: sourceRoot, stdio: 'inherit', env: {
  ...process.env, GREENROOM_MANAGED: 'true', CANVAS_BACKEND_ADDR: '127.0.0.1:18826', CANVAS_BACKEND_DATA_DIR: root,
  CANVAS_ALLOW_PRIVATE_UPSTREAMS: 'true', GIN_MODE: 'release',
} });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp4': 'video/mp4' };
let activeRequests = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const mounted = url.pathname === base || url.pathname.startsWith(base + '/');
  const path = mounted ? url.pathname.slice(base.length) || '/' : url.pathname;
  if (path === '/api/greenroom/lifecycle') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ known: true, busy: Boolean(activeRequests || backend.exitCode !== null) })); return;
  }
  if (path.startsWith('/api/')) {
    if (/^\/api\/(?:admin|channels|settings\/oss|plugins\/[^/]+\/config|auth\/(?!session$|settings$))/.test(path)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 403, msg: 'API 配置由 Greenroom 管理员统一管理' })); return;
    }
    activeRequests++;
    let released = false;
    const release = () => { if (!released) { released = true; activeRequests--; } };
    const outgoing = request({ hostname: '127.0.0.1', port: 18826, method: req.method, path: path + url.search,
      headers: { ...req.headers, 'accept-encoding': 'identity' } }, response => {
      response.once('end', release); response.once('error', release);
      const type = String(response.headers['content-type'] || '');
      if (mounted && type.includes('application/json')) {
        const chunks = [];
        response.on('data', data => chunks.push(data));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString().replace(/"\/api\//g, '"' + base + '/api/');
          const headers = { ...response.headers, 'content-length': Buffer.byteLength(body) };
          delete headers['transfer-encoding']; res.writeHead(response.statusCode, headers).end(body);
        });
      } else { res.writeHead(response.statusCode, response.headers); response.pipe(res); }
    });
    outgoing.on('error', () => { release(); if (!res.headersSent) res.writeHead(503).end(); else res.destroy(); });
    req.on('aborted', () => outgoing.destroy()); req.pipe(outgoing); return;
  }
  const dist = join(sourceRoot, 'web/dist');
  const target = resolve(dist, '.' + decodeURIComponent(path));
  if (!target.startsWith(dist + '/') && target !== dist) { res.writeHead(404).end(); return; }
  const file = existsSync(target) && statSync(target).isFile() ? target : join(dist, 'index.html');
  res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); createReadStream(file).pipe(res);
});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname.startsWith(base + '/') ? url.pathname.slice(base.length) : url.pathname;
  if (!/^\/api\/canvas-projects\/[^/]+\/realtime$/.test(path)) { socket.destroy(); return; }
  const outgoing = request({ hostname: '127.0.0.1', port: 18826, method: 'GET', path: path + url.search, headers: req.headers });
  outgoing.on('upgrade', (response, upstream, upstreamHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key,value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
    if (upstreamHead.length) socket.write(upstreamHead); if (head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream); socket.on('close', () => upstream.destroy());
  });
  outgoing.on('error', () => socket.destroy()); outgoing.end();
});
server.listen(Number(process.env.PORT || 18806), process.env.BIND_HOST || '0.0.0.0');
function stop() { server.close(); backend.kill('SIGTERM'); }
backend.on('exit', () => { server.close(); process.exitCode = 1; });
process.on('SIGINT', stop); process.on('SIGTERM', stop);
