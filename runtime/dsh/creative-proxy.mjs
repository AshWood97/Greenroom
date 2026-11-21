// 宿主转发层：managed 路由表、HTTP/WS 转发与 JSON 请求工具。
// 只做传输与路由改写，不持有插件状态，也不依赖 DSH 上下文。
import { request as httpRequest } from 'node:http';
import { formatGenerationError } from '../shared/generation-error.ts';

export const jsonResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export const jsonResponse = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('业务请求超出 2 MiB 限制');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    signal: options.signal,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(formatGenerationError('HTTP ' + response.status + ': 插件服务返回非 JSON 响应')); }
  if (!response.ok || result.success === false) {
    throw new Error(formatGenerationError({ error: result.error, message: result.message, detail: result.detail,
      error_code: result.error_code ?? result.code, httpStatus: response.status }));
  }
  return result;
}

// Keep streams and HTTP status intact; credentials and member identity are
// supplied by the existing connector, never by a browser or tool argument.
export function forward(req, res, target, path, generationErrors = false, sourceOrigin, pluginId) {
  const upstreamUrl = new URL(target);
  const headers = { ...req.headers, host: upstreamUrl.host };
  for (const key of ['cookie', 'authorization', 'origin', 'x-greenroom-runtime', 'x-greenroom-plugin']) delete headers[key];
  if (pluginId) headers['x-greenroom-plugin'] = pluginId;
  if (sourceOrigin) {
    const origin = new URL(sourceOrigin);
    headers.host = origin.host;
    headers.referer = origin.origin + '/';
  }
  if (generationErrors) headers['accept-encoding'] = 'identity';
  const upstream = httpRequest({
    hostname: upstreamUrl.hostname, port: upstreamUrl.port, method: req.method, path, headers,
  }, (response) => {
    const outputHeaders = { ...response.headers, 'cache-control': 'no-store' };
    delete outputHeaders['set-cookie'];
    if (generationErrors && response.headers['content-type']?.includes('application/json')) {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let body = Buffer.concat(chunks);
        try {
          const value = JSON.parse(body.toString('utf8'));
          if (value.data?.error) value.data.error = formatGenerationError(value.data.error);
          if (value.error) {
            const message = formatGenerationError({ error: value.error,
              error_code: value.error_code ?? value.code, httpStatus: response.statusCode });
            if (typeof value.error === 'object') value.error.message = message;
            else value.error = message;
          }
          body = Buffer.from(JSON.stringify(value));
        } catch { /* Preserve a non-JSON response and its actual HTTP status. */ }
        delete outputHeaders['transfer-encoding'];
        outputHeaders['content-length'] = String(body.length);
        res.writeHead(response.statusCode, outputHeaders);
        res.end(body);
      });
      response.on('error', () => res.destroy());
      return;
    }
    res.writeHead(response.statusCode, outputHeaders);
    response.pipe(res);
    response.on('error', () => res.destroy());
  });
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else jsonResponse(res, 502, { success: false, error: '插件后台暂不可用' });
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

export function forwardUpgrade(req, socket, head, target, path, sockets) {
  const url = new URL(target);
  const headers = { ...req.headers, host: url.host };
  for (const key of ['cookie', 'authorization', 'origin', 'x-greenroom-runtime']) delete headers[key];
  const request = httpRequest({ hostname: url.hostname, port: url.port, path, headers });
  request.on('upgrade', (response, upstream, upstreamHead) => {
    const responseHeaders = { ...response.headers };
    delete responseHeaders['set-cookie'];
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + Object.entries(responseHeaders).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstream.write(head);
    sockets.add(socket); sockets.add(upstream);
    const close = () => { sockets.delete(socket); sockets.delete(upstream); socket.destroy(); upstream.destroy(); };
    socket.on('error', close); upstream.on('error', close);
    socket.on('close', close); upstream.on('close', close);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  request.on('response', (response) => {
    socket.end('HTTP/1.1 ' + response.statusCode + ' Upgrade Rejected\r\nConnection: close\r\n\r\n');
    response.resume();
  });
  request.on('error', () => socket.destroy());
  socket.on('close', () => request.destroy());
  request.end();
}

export const managedPath = (path) => {
  if (path === '/usage/receipts') return '/creative/api' + path;
  if (path === '/models') return '/creative/api/models';
  if (path === '/image/submit') return '/canvas/api/proxy/image/submit';
  if (path === '/video/submit') return '/canvas/api/proxy/video/submit';
  if (path === '/tts/submit' || path === '/music/submit' || path === '/embeddings' || path === '/rerank') return '/creative/api' + path;
  if (/^\/plugins\/[a-z0-9-]+\/settings$/.test(path)) return '/creative/api' + path;
  if (/^\/tasks\/[A-Za-z0-9_-]+$/.test(path)) return '/canvas/api/greenroom' + path;
  if (path === '/chat/completions') return '/v1/chat/completions';
  if (path === '/media/uploads' || /^\/media\/[A-Za-z0-9_-]+$/.test(path)) return '/api' + path;
  return null;
};

const generationBridge = (path) => /^\/(?:canvas\/api\/greenroom\/tasks\/|canvas\/api\/proxy\/(?:image|video)\/submit|creative\/api\/(?:(?:tts|music)\/submit|embeddings|rerank)|v1\/chat\/completions)/.test(path);
export { generationBridge };
