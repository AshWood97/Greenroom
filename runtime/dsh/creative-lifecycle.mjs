// 插件生命周期：适配器装载、后台恢复轮询与健康快照。
// App processes and the shared database may still be starting when DSH is
// ready. Recovery runs on those backends, without holding DSH's profile boot.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { formatGenerationError } from '../shared/generation-error.ts';
import { PluginLifecycle, memberWarmQueue, createPluginUsage, pluginCoreHealth } from '../shared/plugin-lifecycle.mjs';
import { inspectPluginWork } from '../shared/plugin-work.mjs';
import { jsonRequest } from './creative-proxy.mjs';
import { CREATIVE_PLUGINS, pluginEnabled, creativeKnowledgeRoot } from './creative-catalog.mjs';
import { createCreativeCapabilities } from './creative-capabilities.mjs';

export async function loadCreativeAdapters({ pluginsRoot, brokerUrl, endpoint, register, canStart = () => true, waitOpen, admit }) {
  const adapters = new Map();
  const manifests = new Map();
  const lifecycles = new Map();
  const usage = createPluginUsage(join(process.env.DSH_HOME || '/var/lib/dsh', 'plugin-usage.json'));
  for (const plugin of CREATIVE_PLUGINS.filter((item) => !item.builtin)) {
    if (plugin.status === 'awaiting-authorization') continue;
    if (!pluginEnabled(plugin) && (plugin.kind === 'website' || !(plugin.releaseBatch === 'aigc-skills'
      ? process.env.GREENROOM_AIGC_PREVIEW === '1' : process.env.GREENROOM_CREATIVE_PREVIEW === '1'))) continue;
    const directory = join(pluginsRoot, plugin.id);
    if (!existsSync(join(directory, 'manifest.json'))) continue;
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    if (manifest.id !== plugin.id || manifest.group !== plugin.group || !manifest.revision) throw new Error('Invalid creative plugin manifest: ' + plugin.id);
    manifests.set(plugin.id, manifest);
    const root = join(process.env.DSH_HOME || '/var/lib/dsh', 'creative-plugins', plugin.id);
    mkdirSync(root, { recursive: true });
    const pluginEndpoint = !manifest.runtime ? null : plugin.id === 'aid-studio' ? brokerUrl + '/creative/aid' : 'http://127.0.0.1:' + manifest.runtime.port;
    let lifecycle;
    if (manifest.runtime?.lifecycle) {
      const control = 'http://127.0.0.1:' + (manifest.runtime.port + 1000);
      const startupMs = Number(manifest.runtime.env?.GREENROOM_PLUGIN_STARTUP_MS ?? 45_000);
      lifecycle = new PluginLifecycle({
        id: plugin.id, queue: memberWarmQueue, canStart: () => canStart(plugin.id),
        waitOpen: waitOpen && ((signal) => waitOpen(plugin.id, signal)),
        admit: admit && ((signal, shouldWait) => admit(plugin.id, signal, shouldWait)),
        recordUse: (id) => usage.record(id),
        probe: () => jsonRequest(control + '/state', { signal: AbortSignal.timeout(5_000) }),
        start: async (signal) => {
          for (;;) {
            const signals = [AbortSignal.timeout(startupMs + 5_000), ...(signal ? [signal] : [])];
            const state = await jsonRequest(control + '/start', { body: {}, signal: AbortSignal.any(signals) });
            if (state.waiting !== true) return state;
            await delay(2_000, undefined, { signal });
          }
        },
        stop: () => jsonRequest(control + '/stop', { body: { idle: true }, signal: AbortSignal.timeout(15_000) }),
        inspect: async () => {
          const durable = inspectPluginWork(plugin.id, root);
          try {
            const current = await jsonRequest(control + '/state', { signal: AbortSignal.timeout(5_000) });
            lifecycle.memory = current.memory_enabled === true ? {
              pod_uid: current.pod_uid, plugin_id: current.plugin_id, instance_id: current.instance_id,
              drain_epoch: current.drain_epoch, memory_current_bytes: current.memory_current_bytes,
            } : undefined;
            if (!lifecycle.starting) { lifecycle.state = current.lifecycle; lifecycle.error = current.error; }
            if (durable.busy || current.lifecycle !== 'ready') return durable;
            return await jsonRequest(pluginEndpoint + '/api/greenroom/lifecycle', { signal: AbortSignal.timeout(5_000) });
          } catch (error) {
            lifecycle.state = 'failed'; lifecycle.error = error.message;
            return { known: false, busy: true, recover: durable.recover !== false && durable.busy };
          }
        },
      });
      const memoryControl = async (phase, epoch, expected) => {
        const identity = expected || await jsonRequest(control + '/state', { signal: AbortSignal.timeout(5_000) });
        return jsonRequest(control + '/' + phase, { body: { epoch, pod_uid: identity.pod_uid,
          plugin_id: identity.plugin_id, instance_id: identity.instance_id }, signal: AbortSignal.timeout(5_000) });
      };
      lifecycle.memoryControl = {
        drain: (epoch, expected) => memoryControl('drain', epoch, expected),
        reopen: (epoch, expected) => memoryControl('reopen', epoch, expected),
      };
      lifecycles.set(plugin.id, lifecycle);
    }
    const capabilities = createCreativeCapabilities({
      root, endpoint: pluginEndpoint, brokerUrl, bridgeUrl: endpoint + '/managed',
      knowledgeRoot: creativeKnowledgeRoot(plugin.id, manifest),
      memberId: process.env.MEMBER_ID, pluginId: plugin.id, lifecycle,
    });
    const adapter = await (await import(pathToFileURL(join(directory, 'adapter.mjs')).href)).createAdapter(capabilities);
    adapters.set(plugin.id, adapter);
    for (const definition of await adapter.listTools()) {
      register(plugin.id, definition, (args, extra) => lifecycle
        ? (extra?.acquiredLifecycle === lifecycle
          ? adapter.callTool(definition.name, args, extra)
          : lifecycle.run(() => adapter.callTool(definition.name, args, extra), { usage: true, signal: extra?.signal }))
        : adapter.callTool(definition.name, args, extra));
    }
  }
  return { adapters, manifests, lifecycles, usage };
}

export function startAdapterRecovery({ adapters, lifecycles, usage, publishedIds, getHuobao, isClosed }) {
  const startup = new Map();
  const startupTimers = new Set();
  for (const [id, adapter] of adapters) {
    startup.set(id, { ready: true });
    const recover = async () => {
      try {
        const lifecycle = lifecycles.get(id);
        if (lifecycle) await lifecycle.recover(() => adapter.restore());
        else await adapter.restore();
        if (!isClosed()) startup.set(id, { ready: true });
      } catch (error) {
        if (isClosed()) return;
        startup.set(id, { ready: false, error: formatGenerationError(error.message) });
        const timer = setTimeout(() => { startupTimers.delete(timer); void recover(); }, 10_000);
        timer.unref();
        startupTimers.add(timer);
      }
    };
    void recover();
  }
  let ticking;
  const lifecycleTimer = setInterval(() => ticking ||= (async () => {
    for (const [id, lifecycle] of lifecycles) {
      try { await lifecycle.recover(() => adapters.get(id).restore()); await lifecycle.sleepIfIdle(); }
      catch { /* A pending original task remains durable for the next wake. */ }
    }
  })().finally(() => { ticking = undefined; }), 30_000);
  lifecycleTimer.unref();
  let prewarming;
  const prewarm = () => prewarming ||= (async () => {
    const runtimes = new Map([...lifecycles].filter(([id]) => publishedIds.has(id)));
    const huobao = getHuobao();
    if (huobao) runtimes.set('huobao', huobao);
    const results = [];
    for (const id of usage.top(new Set(runtimes.keys()))) {
      const lifecycle = runtimes.get(id);
      try {
        await lifecycle.ensureStarted({ foreground: false, waitForMemory: false });
        if (adapters.has(id)) await lifecycle.run(() => adapters.get(id).restore(), { foreground: false });
        results.push({ id, ...lifecycle.status() });
      } catch (error) { results.push({ id, ...lifecycle.status(), error: formatGenerationError(error.message) }); }
    }
    return { plugins: results };
  })().finally(() => { prewarming = undefined; });
  return {
    startup,
    prewarm,
    dispose() {
      clearInterval(lifecycleTimer);
      for (const timer of startupTimers) clearTimeout(timer);
    },
  };
}

export const healthPayload = ({ adapters, manifests, startup, lifecycles, huobao }) => pluginCoreHealth([
  ...(huobao ? [{ id: 'huobao', ui: true, ...huobao.status() }] : []),
  ...[...adapters.keys()].map((id) => ({ id, ui: manifests.get(id).ui !== null, ...startup.get(id),
    ...(lifecycles.get(id)?.status() || { lifecycle: startup.get(id)?.ready === false ? 'failed' : 'ready', ...startup.get(id) }) })),
]);
