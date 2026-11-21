import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { formatGenerationError } from '../shared/generation-error.ts';
import { inspectRenderWork } from '../shared/plugin-work.mjs';
import { CREATIVE_PLUGINS, publicMcpName, publishedPlugins } from './creative-catalog.mjs';
import { jsonResponse, readJson, jsonRequest, forward, forwardUpgrade, managedPath, generationBridge } from './creative-proxy.mjs';
import { rejectPluginUiRoute, registerReleaseUpgrades } from './creative-ui-routes.mjs';
import { loadCreativeAdapters, startAdapterRecovery, healthPayload } from './creative-lifecycle.mjs';
import { connectCreativeMcp, CREATIVE_PLUGINS_RESOURCE } from './creative-mcp-client.mjs';
import { createCreativeTools } from './creative-tools.mjs';
import { createCreativeInvocations, registerCreativeConversations } from './creative-conversations.mjs';
import { createCreativeAdmission } from './creative-admission.mjs';

const runtimeRoot = dirname(fileURLToPath(import.meta.url));
const pluginsRoot = join(runtimeRoot, '../creative-plugins');
const brokerUrl = 'http://127.0.0.1:3081';
const endpoint = 'http://127.0.0.1:18767';
// The bridge answers for this member and this process only. A scale-down is
// confirmed against the instance that really holds the plugin work, so the id
// is fresh on every process start: a pid, a stable env value or a pod name
// would let a restarted bridge reuse a confirmation it can no longer honour.
const memberId = process.env.MEMBER_ID || '';
const instanceId = randomUUID();
// The current drain and latest coordinator reopen epoch. Retaining the latter
// after opening prevents a delayed older control request changing this gate.
let drainEpoch = 0;
let reopenEpoch = 0;
// Set while a drain is closing new business entry points. A restart clears it,
// which is why the reopen below must name the current epoch explicitly.
let draining = false;
const internalOnly = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const drainBody = (body) => typeof body?.member_id === 'string' && body.member_id === memberId && memberId
  && Number.isInteger(body.epoch) && body.epoch >= 1 && body.instance_id === instanceId
  && body.epoch >= drainEpoch && body.epoch > reopenEpoch ? body.epoch : null;
const reopenBody = (body) => {
  if (typeof body?.member_id !== 'string' || body.member_id !== memberId || !memberId
    || !Number.isInteger(body.epoch) || body.epoch < 1 || body.instance_id !== instanceId) return null;
  if ((drainEpoch && body.epoch <= drainEpoch) || body.epoch < reopenEpoch) return null;
  reopenEpoch = body.epoch;
  return body.epoch;
};

export async function startCreativeMcp(ctx, { definitions, baseTools }) {
  const registry = createCreativeTools();
  const { register, call } = registry;
  const upgradedSockets = new Set();
  let closed = false;
  const memoryEnabled = /^(1|true|yes|on)$/i.test((process.env.MEMBER_MEMORY_ENABLED || '').trim());
  const closingPlugins = new Map();
  const reopenedPlugins = new Map();
  const canStart = (pluginId) => !memoryEnabled || (!draining && !closingPlugins.has(pluginId));
  const waitOpen = async (pluginId, signal) => {
    while (!draining && closingPlugins.has(pluginId)) await delay(200, undefined, { signal });
  };
  const admitMemory = memoryEnabled ? async (pluginId, signal, shouldWait = () => true) => {
    const podUid = process.env.GREENROOM_POD_UID || '';
    if (!podUid) throw new Error('成员内存配置尚未就绪，请稍后重试');
    const url = brokerUrl + '/internal/memory/admit';
    const body = JSON.stringify({ podUid, pluginId });
    let waiting = false, admitted = false;
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason || new Error('操作已取消');
        if (!canStart(pluginId)) throw new Error('成员运行环境正在调整，请稍后重试');
        let response;
        try {
          const signals = [AbortSignal.timeout(20_000), ...(signal ? [signal] : [])];
          response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body, signal: AbortSignal.any(signals) });
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error;
          if (error.name !== 'TimeoutError' && !(error instanceof TypeError)) throw error;
          await delay(2_000, undefined, { signal });
          continue;
        }
        const result = await response.json();
        if (response.ok && result.admitted === true) { admitted = true; return; }
        if (response.status !== 202 || result.waiting !== true) {
          throw new Error(result.error || result.detail || '成员内存申请失败');
        }
        waiting = true;
        if (!shouldWait()) throw new Error('当前内存暂不足，稍后再预热');
        const interval = Math.min(10_000, Math.max(1_000, Number(result.retry_after_ms) || 2_000));
        await delay(interval, undefined, { signal });
      }
    } finally {
      if (waiting && !admitted) {
        await fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body,
          signal: AbortSignal.timeout(5_000) }).catch(() => {});
      }
    }
  } : undefined;
  const getHuobao = () => {
    const lifecycle = ctx.get('greenroomHuobao')?.lifecycle;
    if (memoryEnabled && lifecycle) {
      lifecycle.canStart = () => canStart('huobao');
      lifecycle.admit = (signal, shouldWait) => admitMemory('huobao', signal, shouldWait);
    }
    return lifecycle;
  };
  const invocations = createCreativeInvocations();
  for (const definition of definitions) {
    register(definition.name.startsWith('t8_canvas_') ? 't8' : 'huobao', {
      name: definition.name, description: definition.description, inputSchema: definition.parameters,
    }, (args, extra) => definition.execute(args, extra.exec));
  }
  const { adapters, manifests, lifecycles, usage } = await loadCreativeAdapters({ pluginsRoot, brokerUrl, endpoint, register, canStart, waitOpen, admit: admitMemory });
  const admission = createCreativeAdmission((id) => {
    const lifecycle = id === 'huobao' ? getHuobao() : lifecycles.get(id);
    if (id === 'huobao' && !lifecycle) throw new Error('火宝短剧服务尚未就绪');
    return lifecycle;
  });
  const controlLaunchers = async (phase, epoch) => {
    const receipts = await Promise.all([...lifecycles].map(async ([id, lifecycle]) => {
      try {
        const receipt = await lifecycle.memoryControl[phase](epoch);
        return receipt.memory_enabled === true && receipt.plugin_id === id
          && receipt.pod_uid === process.env.GREENROOM_POD_UID && Boolean(receipt.instance_id)
          && receipt.epoch === epoch && receipt[phase === 'drain' ? 'closed' : 'opened'] === true;
      } catch { return false; }
    }));
    return receipts.every(Boolean);
  };
  if (publishedPlugins().some((plugin) => !plugin.builtin && !adapters.has(plugin.id))) {
    throw new Error('已开放批次的创作插件尚未全部安装');
  }
  const publishedIds = new Set(publishedPlugins().map((plugin) => plugin.id));
  const { startup, prewarm, dispose: disposeRecovery } = startAdapterRecovery({
    adapters, lifecycles, usage, publishedIds,
    getHuobao, isClosed: () => closed,
  });
  const publishedNames = registry.publishedNames(publishedIds);
  const visibleDefinitions = () => registry.visibleDefinitions(publishedNames);
  const serveMcp = async (req, res) => {
    const server = new Server({ name: 'greenroom', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} }, instructions: '' });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleDefinitions() }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{
      uri: CREATIVE_PLUGINS_RESOURCE, name: 'Greenroom 创作插件', mimeType: 'application/json',
    }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri !== CREATIVE_PLUGINS_RESOURCE) throw new Error('插件目录资源不存在');
      return { contents: [{ uri: CREATIVE_PLUGINS_RESOURCE, mimeType: 'application/json', text: JSON.stringify({
        plugins: registry.catalog(publishedIds),
      }) }] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (!publishedNames.has(publicMcpName(request.params.name))) throw new Error('业务工具未开放');
      return call(request.params.name, request.params.arguments || {},
        invocations.resolve(request.params._meta?.greenroomInvocation, extra));
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
  const acquireHttp = async (id, req, res) => {
    const lifecycle = lifecycles.get(id);
    if (!lifecycle) return true;
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const deadline = memoryEnabled ? AbortSignal.timeout(10_000) : undefined;
    let release;
    try {
      release = await lifecycle.acquire({ usage: req.method === 'GET' && /^\/plugins\/[a-z0-9-]+\/?(?:\?|$)/.test(req.url),
        signal: deadline ? AbortSignal.any([controller.signal, deadline]) : controller.signal });
    } catch (error) {
      if (deadline?.aborted && !controller.signal.aborted && !res.destroyed) {
        jsonResponse(res, 503, { error: '插件正在等待可用资源，请从工作台打开插件', submitted: false });
        return false;
      }
      throw error;
    }
    if (res.destroyed) { release(); return false; }
    res.once('finish', release); res.once('close', release);
    return true;
  };
  const http = createServer(async (req, res) => {
    try {
      if (req.headers.origin || !['127.0.0.1:18767', 'localhost:18767'].includes(req.headers.host)) {
        return jsonResponse(res, 403, { error: '仅允许成员环境内部访问' });
      }
      const url = new URL(req.url, endpoint);
      if (url.pathname === '/lifecycle/prewarm') {
        if (req.method !== 'POST') return jsonResponse(res, 405, { error: '仅支持 POST' });
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return jsonResponse(res, 403, { error: '仅允许成员环境内部访问' });
        if (!canStart()) return jsonResponse(res, 409, { error: '成员运行环境正在调整，请稍后重试' });
        return jsonResponse(res, 200, await prewarm());
      }
      if (url.pathname === '/lifecycle/work') {
        if (req.method !== 'GET') return jsonResponse(res, 405, { error: '仅支持 GET' });
        if (!internalOnly(req)) return jsonResponse(res, 403, { error: '仅允许成员环境内部访问' });
        // Same snapshot the member's own restore path uses; a plugin that
        // cannot be inspected is reported, never silently treated as idle.
        const huobao = getHuobao();
        for (const lifecycle of [...lifecycles.values(), huobao].filter(Boolean)) await lifecycle.hasWork();
        const health = healthPayload({ adapters, manifests, startup, lifecycles, huobao });
        if (memoryEnabled) health.plugins = health.plugins.map((item) => ({ ...item,
          ...(lifecycles.get(item.id)?.memory ? { memory: lifecycles.get(item.id).memory } : {}) }));
        return jsonResponse(res, 200, { ...health,
          ...(memoryEnabled ? { memory_enabled: true } : {}),
          render_inventory: { member_id: memberId,
            ...inspectRenderWork(join(process.env.DSH_HOME || '/var/lib/dsh', 'creative-plugins')) },
        });
      }
      if (url.pathname === '/lifecycle/instance') {
        if (req.method !== 'GET') return jsonResponse(res, 405, { error: '仅支持 GET' });
        if (!internalOnly(req)) return jsonResponse(res, 403, { error: '仅允许成员环境内部访问' });
        // An identity report only: it never states closed, idle or opened,
        // which are answered separately for one drain epoch.
        return jsonResponse(res, 200, { member_id: memberId, instance_id: instanceId });
      }
      if (memoryEnabled && ['/lifecycle/memory/drain', '/lifecycle/memory/reopen'].includes(url.pathname)) {
        if (req.method !== 'POST') return jsonResponse(res, 405, { error: '仅支持 POST' });
        if (!internalOnly(req)) return jsonResponse(res, 403, { error: '仅允许成员环境内部访问' });
        const body = await readJson(req);
        const { member_id: requestedMember, plugin_id: pluginId, pod_uid: podUid,
          instance_id: launcherId, epoch } = body || {};
        const lifecycle = lifecycles.get(pluginId);
        if (requestedMember !== memberId || !memberId || podUid !== process.env.GREENROOM_POD_UID
            || !podUid || typeof launcherId !== 'string' || !launcherId || !lifecycle
            || !Number.isInteger(epoch) || epoch < 1) return jsonResponse(res, 409, {});
        const expected = { pod_uid: podUid, plugin_id: pluginId, instance_id: launcherId };
        const reopening = url.pathname.endsWith('/reopen');
        if (reopening) {
          if (closingPlugins.has(pluginId) && epoch <= closingPlugins.get(pluginId)) return jsonResponse(res, 409, {});
          const receipt = await lifecycle.memoryControl.reopen(epoch, expected);
          if (receipt.pod_uid !== podUid || receipt.plugin_id !== pluginId || receipt.instance_id !== launcherId
              || receipt.epoch !== epoch || receipt.opened !== true) return jsonResponse(res, 409, {});
          closingPlugins.delete(pluginId);
          reopenedPlugins.set(pluginId, epoch);
          return jsonResponse(res, 200, { ...expected, member_id: memberId, epoch, opened: true });
        }
        if (draining || epoch <= (reopenedPlugins.get(pluginId) || 0)
            || epoch < (closingPlugins.get(pluginId) || 0)) return jsonResponse(res, 409, {});
        await lifecycle.hasWork();
        const current = lifecycle.memory;
        if (lifecycle.state !== 'sleeping' || lifecycle.active || lifecycle.starting
            || lifecycle.work.known !== true || lifecycle.work.busy || current?.pod_uid !== podUid
            || current?.instance_id !== launcherId || current?.plugin_id !== pluginId) return jsonResponse(res, 409, {});
        closingPlugins.set(pluginId, epoch);
        const receipt = await lifecycle.memoryControl.drain(epoch, expected);
        if (receipt.pod_uid !== podUid || receipt.plugin_id !== pluginId || receipt.instance_id !== launcherId
            || receipt.epoch !== epoch || receipt.closed !== true || receipt.lifecycle !== 'sleeping') return jsonResponse(res, 409, {});
        await lifecycle.hasWork();
        const locked = lifecycle.memory;
        if (closingPlugins.get(pluginId) !== epoch || lifecycle.state !== 'sleeping' || lifecycle.active || lifecycle.starting
            || lifecycle.work.known !== true || lifecycle.work.busy || locked?.pod_uid !== podUid
            || locked?.instance_id !== launcherId || locked?.drain_epoch !== epoch
            || !Number.isSafeInteger(locked?.memory_current_bytes) || locked.memory_current_bytes <= 0) return jsonResponse(res, 409, {});
        return jsonResponse(res, 200, { ...expected, member_id: memberId, epoch, closed: true, idle: true,
          memory_current_bytes: locked.memory_current_bytes });
      }
      if (url.pathname === '/lifecycle/drain') {
        if (req.method !== 'POST') return jsonResponse(res, 405, { error: '仅支持 POST' });
        if (!internalOnly(req)) return jsonResponse(res, 403, { error: '仅允许成员环境内部访问' });
        const epoch = drainBody(await readJson(req));
        if (epoch === null) {
          return jsonResponse(res, 409, { member_id: memberId, epoch: 0, instance_id: instanceId, closed: false, idle: false });
        }
        // New business entry points close first, so nothing can start behind
        // the idle check below.
        drainEpoch = epoch;
        draining = true;
        if (memoryEnabled && !await controlLaunchers('drain', epoch)) {
          return jsonResponse(res, 409, { member_id: memberId, epoch, instance_id: instanceId, closed: false, idle: false });
        }
        // A starting or busy plugin, an in-flight request or an unreadable
        // snapshot is never idle: a task this bridge cannot see finish keeps
        // the member awake rather than being dropped.
        const huobao = getHuobao();
        for (const lifecycle of [...lifecycles.values(), huobao].filter(Boolean)) await lifecycle.hasWork();
        // Inspection yields: a newer reopen/drain must not receive a stale
        // closed receipt from this earlier request.
        if (!draining || drainEpoch !== epoch || reopenEpoch >= epoch) {
          return jsonResponse(res, 409, { member_id: memberId, epoch, instance_id: instanceId, closed: false, idle: false });
        }
        const busy = healthPayload({
          adapters, manifests, startup, lifecycles, huobao,
        }).plugins.some((item) => item.lifecycle === 'starting' || item.lifecycle === 'busy' || item.activeRequests
          || item.work?.known === false || item.work?.busy);
        return jsonResponse(res, 200, { member_id: memberId, epoch, instance_id: instanceId, closed: !busy, idle: !busy });
      }
      if (url.pathname === '/lifecycle/reopen') {
        if (req.method !== 'POST') return jsonResponse(res, 405, { error: '仅支持 POST' });
        if (!internalOnly(req)) return jsonResponse(res, 403, { error: '仅允许成员环境内部访问' });
        const epoch = reopenBody(await readJson(req));
        if (epoch === null) {
          return jsonResponse(res, 409, { member_id: memberId, epoch: 0, instance_id: instanceId, opened: false });
        }
        if (memoryEnabled && !await controlLaunchers('reopen', epoch)) {
          return jsonResponse(res, 409, { member_id: memberId, epoch, instance_id: instanceId, opened: false });
        }
        if (reopenEpoch !== epoch || drainEpoch >= epoch) {
          return jsonResponse(res, 409, { member_id: memberId, epoch, instance_id: instanceId, opened: false });
        }
        // Only this instance, serving again, finishes a reopen: a closed-idle
        // answer for a drain epoch is a different phase and never counts here.
        draining = false;
        drainEpoch = 0;
        return jsonResponse(res, 200, { member_id: memberId, epoch, instance_id: instanceId, opened: !closed });
      }
      const bridgeRoute = /^\/managed(?:\/for\/([a-z0-9-]+))?(\/.*)$/.exec(url.pathname);
      const bridgePath = bridgeRoute && managedPath(bridgeRoute[2]);
      // A closed epoch stops new business here, before any tool call or plugin
      // request runs. Control and original-task queries keep working.
      if (draining && url.pathname !== '/health') {
        if (bridgeRoute) {
          const path = bridgePath;
          // Only new submissions close: a task query or completion of an
          // original task still has to reach its own backend.
          const recovery = ['GET', 'HEAD'].includes(req.method)
            || (req.method === 'POST' && path === '/api/media/uploads');
          if (path && !recovery) {
            return jsonResponse(res, 409, { error: '成员运行环境正在休眠，已停止受理新任务',
              code: 'greenroom.submission_not_sent', submitted: false });
          }
        } else if (url.pathname === '/mcp' || url.pathname.startsWith('/plugins/')) {
          return jsonResponse(res, 409, { error: '成员运行环境正在休眠，已停止受理新任务' });
        }
      }
      if (url.pathname === '/mcp') return await serveMcp(req, res);
      if (url.pathname === '/health') return jsonResponse(res, 200, healthPayload({
        adapters, manifests, startup, lifecycles, huobao: getHuobao(),
      }));
      const admissionMatch = /^\/admission\/([a-z0-9-]+)$/.exec(url.pathname);
      if (admissionMatch) {
        const id = admissionMatch[1];
        if (!publishedIds.has(id) || (id !== 'huobao' && !adapters.has(id))) return jsonResponse(res, 404, { error: '插件尚未开放' });
        if (!['POST', 'DELETE'].includes(req.method)) return jsonResponse(res, 405, { error: '请求方法不支持' });
        const { ticket } = await readJson(req);
        if (req.method === 'DELETE') return jsonResponse(res, 200, { cancelled: admission.cancel(id, ticket) });
        const result = admission.prepare(id, ticket);
        return jsonResponse(res, result.state === 'failed' ? 503 : result.state === 'claimed' ? 409 : result.state === 'ready' ? 200 : 202,
          { ...result, retry_after_ms: 2000 });
      }
      if (bridgeRoute) {
        const id = bridgeRoute[1];
        if (!bridgePath || id && !publishedIds.has(id)) return jsonResponse(res, 404, { error: '接口不存在',
          code: 'greenroom.managed_route_not_found', submitted: false });
        return forward(req, res, brokerUrl, bridgePath + url.search, generationBridge(bridgePath), undefined, id);
      }
      const match = /^\/plugins\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
      if (!match || !publishedIds.has(match[1]) || !adapters.has(match[1])) return jsonResponse(res, 404, { error: '插件尚未开放' });
      const id = match[1], suffix = match[2] || '';
      if (suffix === '/_greenroom/tools' && req.method === 'GET') {
        return jsonResponse(res, 200, { tools: registry.pluginDefinitions(id) });
      }
      if (suffix === '/_greenroom/call' && req.method === 'POST') {
        const body = await readJson(req);
        if (!registry.toolNames(id).includes(publicMcpName(body.name))) return jsonResponse(res, 404, { error: '业务工具不存在' });
        const controller = new AbortController();
        req.on('aborted', () => controller.abort());
        res.once('close', () => { if (!res.writableFinished) controller.abort(); });
        if (!memoryEnabled) return jsonResponse(res, 200, await call(body.name, body.arguments || {}, { signal: controller.signal, callId: randomUUID() }));
        const lifecycle = lifecycles.get(id);
        const existing = body.admissionId ? null : (lifecycle ? lifecycle.holdConfirmed() : () => {});
        const claimed = existing ? { state: 'claimed', lifecycle, release: existing } : admission.claim(id, body.admissionId);
        if (claimed.state === 'claimed' && claimed.release) {
          try {
            if (claimed.lifecycle) usage.record(id);
            return jsonResponse(res, 200, await call(body.name, body.arguments || {}, {
              signal: controller.signal, callId: randomUUID(), acquiredLifecycle: claimed.lifecycle,
            }));
          } finally { claimed.release(); }
        }
        if (claimed.state === 'claimed') return jsonResponse(res, 409, { error: '该请求已经执行或正在执行', submitted: true });
        return jsonResponse(res, 202, { waiting_memory: true, submitted: false, retry_after_ms: 2000 });
      }
      if (suffix === '/_greenroom/source' && req.method === 'GET' && manifests.get(id).license.startsWith('AGPL')) {
        if (!await acquireHttp(id, req, res)) return;
        return forward(req, res, 'http://127.0.0.1:' + manifests.get(id).runtime.port, '/greenroom/source');
      }
      if (rejectPluginUiRoute(id, req.method, suffix)) {
        return jsonResponse(res, 404, { error: '接口不存在' });
      }
      if (!await acquireHttp(id, req, res)) return;
      const adapter = adapters.get(id);
      if (adapter.handleUi) return await adapter.handleUi(req, res, suffix || '/');
      if (manifests.get(id).ui === null) return jsonResponse(res, 200, { id, title: registry.toolNames(id) && CREATIVE_PLUGINS.find((plugin) => plugin.id === id).title, mode: 'conversation' });
      const target = await adapter.getUiTarget();
      const targetUrl = new URL(typeof target === 'string' ? target : target.url);
      const settingsRoute = id === 'toonflow' && (req.method === 'GET' && suffix === '/api/settings/get'
        || req.method === 'PUT' && suffix === '/api/settings/save');
      return forward(req, res, targetUrl.origin, (targetUrl.pathname.replace(/\/$/, '') + suffix || '/') + url.search,
        false, settingsRoute ? process.env.GREENROOM_DSH_ORIGIN : undefined);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else jsonResponse(res, 500, { success: false, error: formatGenerationError(error.message) });
    }
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(18767, '127.0.0.1', resolve); });
  const client = await connectCreativeMcp('greenroom-dsh');
  const discovered = await client.listTools();
  const conversations = registerCreativeConversations(ctx, {
    client, definitions: discovered.tools, baseTools, registry, invocations, publishedIds,
  });
  const releaseRoutes = publishedPlugins().filter((plugin) => !plugin.builtin).map((plugin) => ctx.webServer.register({
    kind: 'prefix', path: '/plugins/' + plugin.id,
    handler(req, res) {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) return res.writeHead(rejection).end();
      return forward(req, res, endpoint, req.url);
    },
  }));
  const releaseBridge = ctx.webServer.register({
    kind: 'prefix', path: '/creative-managed',
    handler(req, res) {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) return res.writeHead(rejection).end();
      const url = new URL(req.url, endpoint);
      const path = managedPath(url.pathname.slice('/creative-managed'.length));
      if (!path) return jsonResponse(res, 404, { error: '接口不存在',
          code: 'greenroom.managed_route_not_found', submitted: false });
      return forward(req, res, brokerUrl, path + url.search, generationBridge(path));
    },
  });
  const releaseAdmission = ctx.webServer.register({
    kind: 'prefix', path: '/creative-admission',
    handler(req, res) {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) return res.writeHead(rejection).end();
      const url = new URL(req.url, endpoint);
      if (!/^\/creative-admission\/[a-z0-9-]+$/.test(url.pathname)) return jsonResponse(res, 404, { error: '插件尚未开放' });
      return forward(req, res, endpoint, url.pathname.replace('/creative-admission/', '/admission/'));
    },
  });
  const releaseUpgrades = registerReleaseUpgrades(ctx, { endpoint, manifests, publishedIds, lifecycles, forwardUpgrade, upgradedSockets });
  const releaseStatus = ctx.webServer.register({
    kind: 'exact', path: '/creative-status',
    handler(req, res) {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) return res.writeHead(rejection).end();
      return forward(req, res, endpoint, '/health');
    },
  });
  return {
    managedNames: conversations.managedNames,
    recordUse: (id) => usage.record(id),
    admitMemory,
    async close() {
      closed = true;
      disposeRecovery();
      for (const release of releaseRoutes) release();
      for (const release of releaseUpgrades) release();
      admission.close();
      for (const socket of upgradedSockets) socket.destroy();
      releaseAdmission(); releaseBridge(); releaseStatus();
      conversations.close();
      for (const adapter of adapters.values()) await adapter.close();
      await client.close();
      await new Promise((resolve) => { http.close(resolve); http.closeAllConnections(); });
    },
  };
}
