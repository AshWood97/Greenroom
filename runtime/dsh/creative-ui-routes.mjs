// 各插件定制的 UI 业务路由白名单与 WebSocket 升级路由。
// 白名单外的 /greenroom 前缀一律 404；策略与路由注册集中在此，
// 不混入 MCP 协议处理。

const moyinUiRoutes = new Set([
  'GET /api/greenroom/catalog', 'POST /api/greenroom/ipc', 'POST /api/greenroom/db',
  'GET /api/greenroom/files', 'PUT /api/greenroom/files', 'DELETE /api/greenroom/files',
  'POST /api/greenroom/business', 'POST /api/greenroom/submit', 'POST /api/greenroom/media/submit',
  'GET /api/greenroom/tasks',
]);
const openslopUiRoutes = new Set([
  'GET /api/greenroom/catalog', 'POST /api/greenroom/video-frames',
  'GET /api/greenroom/account', 'PUT /api/greenroom/account',
  'GET /api/greenroom/projects', 'POST /api/greenroom/projects',
]);

// These are trusted adapter/worker handoffs. Browser actions enter
// through the published business schema above, with server-owned settings.
export function rejectPluginUiRoute(id, method, suffix) {
  const moyinBusiness = id === 'moyin' && (moyinUiRoutes.has(method + ' ' + suffix)
    || method === 'GET' && /^\/api\/greenroom\/tasks\/[A-Za-z0-9_-]+$/.test(suffix));
  const openslopBusiness = id === 'openslop' && (openslopUiRoutes.has(method + ' ' + suffix)
    || ['GET', 'PUT', 'DELETE'].includes(method) && /^\/api\/greenroom\/projects\/[A-Za-z0-9_.-]+$/.test(suffix)
    || method === 'GET' && /^\/api\/greenroom\/projects\/[A-Za-z0-9_.-]+\/events$/.test(suffix)
    || ['GET', 'POST'].includes(method) && /^\/api\/greenroom\/projects\/[A-Za-z0-9_.-]+\/(?:versions|history\/[A-Za-z0-9_.-]+)$/.test(suffix)
    || ['GET', 'PUT'].includes(method) && /^\/api\/greenroom\/projects\/[A-Za-z0-9_.-]+\/versions\/[A-Za-z0-9_.-]+$/.test(suffix));
  if (!moyinBusiness && !openslopBusiness && (/^\/greenroom(?:\/|$)/.test(suffix) || /^\/api\/greenroom(?:\/|$)/.test(suffix))) {
    return true;
  }
  return false;
}

export function registerReleaseUpgrades(ctx, { endpoint, manifests, publishedIds, lifecycles, forwardUpgrade, upgradedSockets }) {
  const releases = [];
  const memoryEnabled = /^(1|true|yes|on)$/i.test((process.env.MEMBER_MEMORY_ENABLED || '').trim());
  const upgradeSignal = (controller) => memoryEnabled
    ? AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) : controller.signal;
  if (publishedIds.has('moneyprinter')) {
    releases.push(ctx.webServer.registerUpgrade({
      path: '/plugins/moneyprinter/_stcore/stream',
      async handler(req, socket, head) {
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) return socket.end('HTTP/1.1 ' + rejection + ' Forbidden\r\nConnection: close\r\n\r\n');
        const url = new URL(req.url, endpoint);
        const controller = new AbortController();
        socket.once('close', () => controller.abort());
        socket.once('error', () => controller.abort());
        try {
          const release = await lifecycles.get('moneyprinter').acquire({ signal: upgradeSignal(controller) });
          if (socket.destroyed) { release(); return; }
          socket.once('close', release);
        } catch { if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
        return forwardUpgrade(req, socket, head, 'http://127.0.0.1:' + manifests.get('moneyprinter').runtime.port,
          '/_stcore/stream' + url.search, upgradedSockets);
      },
    }));
  }
  if (publishedIds.has('open-ai-canvas')) {
    releases.push(ctx.webServer.registerUpgrade({
      path: '/plugins/open-ai-canvas/_greenroom/socket',
      async handler(req, socket, head) {
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) return socket.end('HTTP/1.1 ' + rejection + ' Forbidden\r\nConnection: close\r\n\r\n');
        const url = new URL(req.url, endpoint);
        const path = url.searchParams.get('path') || '';
        if (!/^\/api\/canvas-projects\/[A-Za-z0-9_-]+\/realtime$/.test(path)) {
          return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        }
        url.searchParams.delete('path');
        const controller = new AbortController();
        socket.once('close', () => controller.abort());
        socket.once('error', () => controller.abort());
        try {
          const release = await lifecycles.get('open-ai-canvas').acquire({ signal: upgradeSignal(controller) });
          if (socket.destroyed) { release(); return; }
          socket.once('close', release);
        } catch { if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
        return forwardUpgrade(req, socket, head, 'http://127.0.0.1:' + manifests.get('open-ai-canvas').runtime.port,
          path + url.searchParams.toString().replace(/^(.+)$/, '?$1'), upgradedSockets);
      },
    }));
  }
  return releases;
}
