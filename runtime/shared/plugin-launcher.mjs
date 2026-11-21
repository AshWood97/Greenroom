import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function createPluginLauncher({ command, readyUrl, startupMs = 45_000 }) {
  let child, starting, stopping, error;
  let state = 'sleeping';
  const memoryEnabled = /^(1|true|yes|on)$/i.test((process.env.MEMBER_MEMORY_ENABLED || '').trim());
  const podUid = process.env.GREENROOM_POD_UID || '';
  const pluginId = process.env.GREENROOM_PLUGIN_ID || '';
  const instanceId = randomUUID();
  let drainEpoch = 0, reopenEpoch = 0;
  const memoryCurrent = () => {
    try {
      const value = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    } catch { return null; }
  };
  const status = () => ({ ready: true, lifecycle: state, ...(error ? { error } : {}),
    ...(memoryEnabled ? { memory_enabled: true, pod_uid: podUid, plugin_id: pluginId,
      instance_id: instanceId, drain_epoch: drainEpoch, memory_current_bytes: memoryCurrent() } : {}) });
  const requireOpen = () => {
    if (memoryEnabled && drainEpoch) throw new Error('成员运行环境正在调整，请稍后重试');
  };
  const admit = async () => {
    if (!memoryEnabled) return true;
    requireOpen();
    if (!podUid || !pluginId) throw new Error('成员内存配置尚未就绪');
    const response = await fetch('http://127.0.0.1:3081/internal/memory/admit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ podUid, pluginId }), signal: AbortSignal.timeout(45_000),
    });
    const result = await response.json();
    if (response.status === 202 && result.waiting === true) return false;
    if (!response.ok || result.admitted !== true) throw new Error('成员内存申请失败');
    requireOpen();
    return true;
  };
  async function terminate() {
    const running = child;
    if (!running?.pid || running.exitCode !== null) { child = undefined; return; }
    const exited = new Promise((resolve) => running.once('exit', resolve));
    process.kill(-running.pid, 'SIGTERM');
    const timeout = setTimeout(() => { try { process.kill(-running.pid, 'SIGKILL'); } catch {} }, 10_000);
    try { await exited; } finally { clearTimeout(timeout); }
  }
  const start = () => {
    try { requireOpen(); } catch (failure) { return Promise.reject(failure); }
    if (starting) return starting;
    if (stopping) return stopping.then(start);
    if (child && state === 'ready') return admit().then((granted) => granted ? status() : { ...status(), waiting: true });
    state = 'starting'; error = undefined;
    starting = (async () => {
      try {
        if (!await admit()) { state = 'sleeping'; return { ...status(), waiting: true }; }
        requireOpen();
        child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true });
        const running = child;
        let spawnError;
        running.once('error', (failure) => { spawnError = failure; });
        running.once('exit', (code) => {
          if (child !== running) return;
          child = undefined;
          if (!stopping) { state = 'failed'; error = '插件业务进程已退出（' + code + '）'; }
        });
        const deadline = Date.now() + startupMs;
        while (Date.now() < deadline) {
          if (spawnError) throw spawnError;
          if (!child) throw new Error(error || '插件业务进程已退出');
          try {
            const response = await fetch(readyUrl, { signal: AbortSignal.timeout(Math.min(1_000, deadline - Date.now())) });
            await response.body?.cancel();
            if (response.ok) { state = 'ready'; return status(); }
          } catch { /* The original health endpoint is not listening yet. */ }
          await delay(100);
        }
        throw new Error('插件启动超过 ' + startupMs / 1000 + ' 秒');
      } catch (failure) {
        await terminate();
        state = 'failed'; error = failure.message;
        throw failure;
      } finally { starting = undefined; }
    })();
    return starting;
  };
  const stop = () => {
    if (starting) throw new Error('插件正在启动');
    if (stopping) return stopping;
    stopping = terminate().then(() => { state = 'sleeping'; error = undefined; return status(); })
      .finally(() => { stopping = undefined; });
    return stopping;
  };
  const server = createServer(async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.headers.origin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(403, { error: '仅允许成员环境内部访问' });
    if (req.method === 'GET' && ['/health', '/state'].includes(req.url)) return send(200, status());
    try {
      if (req.method === 'POST' && req.url === '/start') return send(200, await start());
      if (req.method === 'POST' && req.url === '/stop') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1024) return send(413, { error: '控制请求过大' }); }
        if (JSON.parse(body || '{}').idle !== true) return send(409, { error: '尚未确认插件空闲' });
        return send(200, await stop());
      }
      if (memoryEnabled && req.method === 'POST' && ['/drain', '/reopen'].includes(req.url)) {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1024) return send(413, {}); }
        const payload = JSON.parse(body || '{}');
        const epoch = payload.epoch;
        if (payload.pod_uid !== podUid || payload.plugin_id !== pluginId || payload.instance_id !== instanceId) return send(409, {});
        if (!Number.isInteger(epoch) || epoch < 1) return send(409, {});
        if (req.url === '/drain') {
          if (epoch < drainEpoch || epoch <= reopenEpoch) return send(409, {});
          drainEpoch = epoch;
          return send(200, { ...status(), epoch, closed: true });
        }
        if ((drainEpoch && epoch <= drainEpoch) || epoch < reopenEpoch) return send(409, {});
        reopenEpoch = epoch; drainEpoch = 0;
        return send(200, { ...status(), epoch, opened: true });
      }
      return send(404, { error: '接口不存在' });
    } catch (failure) { return send(503, { ...status(), error: failure.message }); }
  });
  return { server, start, stop, status, async close() {
    if (starting) await starting.catch(() => {});
    await stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const split = process.argv.indexOf('--');
  const values = process.argv.slice(2, split);
  const port = Number(values[values.indexOf('--port') + 1]);
  const readyUrl = values[values.indexOf('--ready-url') + 1];
  const startupMs = process.env.GREENROOM_PLUGIN_STARTUP_MS;
  const launcher = createPluginLauncher({
    command: process.argv.slice(split + 1), readyUrl,
    startupMs: startupMs ? Number(startupMs) : undefined,
  });
  launcher.server.listen(port, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { launcher.close().then(() => process.exit()); });
}
