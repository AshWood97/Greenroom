import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// One member starts one backend at a time. A foreground request can overtake
// queued login prewarming, but never interrupts a backend already starting.
export function createWarmQueue() {
  const waiting = [];
  let running = false;
  const next = () => {
    if (running || !waiting.length) return;
    waiting.sort((a, b) => a.priority - b.priority);
    const item = waiting.shift();
    running = true;
    Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => { running = false; next(); });
  };
  return {
    enqueue(work, priority = 1) {
      const item = { work, priority };
      item.promise = new Promise((resolve, reject) => Object.assign(item, { resolve, reject }));
      waiting.push(item);
      queueMicrotask(next);
      return item;
    },
    promote(item) { if (item) item.priority = 0; },
  };
}

export const memberWarmQueue = createWarmQueue();

export class PluginLifecycle {
  constructor({ id, start, stop, inspect, probe, queue, now = Date.now, idleMs = 15 * 60_000, recordUse = () => {}, canStart = () => true, waitOpen, admit }) {
    Object.assign(this, { id, start, stop, inspect, probe, queue, now, idleMs, recordUse, canStart, waitOpen, admit });
    this.state = 'sleeping';
    this.active = 0;
    this.confirmedLeases = 0;
    this.lastActivity = now();
    this.work = { known: true, busy: false };
  }
  status() {
    return { lifecycle: this.state, ready: this.state !== 'failed', activeRequests: this.active,
      work: { known: this.work.known, busy: this.work.busy },
      ...(this.wakeMs === undefined ? {} : { startupMs: this.wakeMs }), ...(this.error ? { error: this.error } : {}) };
  }
  requireStart() {
    if (!this.canStart()) throw new Error('成员运行环境正在调整，请稍后重试');
  }
  async waitStarting(signal) {
    const pending = this.starting;
    const controller = this.startController;
    this.startWaiters ||= new Set();
    const waiter = {};
    this.startWaiters.add(waiter);
    let aborted;
    try {
      if (!signal) return await pending;
      if (signal.aborted) throw signal.reason || new Error('操作已取消');
      const cancelled = new Promise((_, reject) => {
        aborted = () => reject(signal.reason || new Error('操作已取消'));
        signal.addEventListener('abort', aborted, { once: true });
      });
      return await Promise.race([pending, cancelled]);
    } finally {
      if (aborted) signal.removeEventListener('abort', aborted);
      this.startWaiters.delete(waiter);
      if (!this.startWaiters.size && this.starting === pending) controller?.abort();
    }
  }
  async ensureStarted({ foreground = true, signal, waitForMemory = true } = {}) {
    this.requireStart();
    if (signal?.aborted) throw signal.reason || new Error('操作已取消');
    if (this.stopping) await this.stopping;
    this.requireStart();
    if (this.starting) {
      if (this.startController?.signal.aborted) {
        await this.starting.catch(() => {});
        return this.ensureStarted({ foreground, signal, waitForMemory });
      }
      if (waitForMemory) this.memoryWaitRequested = true;
      if (foreground) { this.foregroundRequested = true; this.queue.promote(this.queued); }
      return this.waitStarting(signal);
    }
    const controller = new AbortController();
    this.startController = controller;
    this.memoryWaitRequested = waitForMemory;
    this.foregroundRequested = foreground;
    this.starting = (async () => {
      if (this.state === 'ready' || this.state === 'busy') {
        try {
          const current = this.probe ? await this.probe() : { lifecycle: 'ready' };
          this.requireStart();
          if (current.lifecycle === 'ready') {
            if (this.admit) await this.admit(controller.signal, () => this.memoryWaitRequested);
            this.requireStart();
            return;
          }
          this.state = current.lifecycle; this.error = current.error;
        } catch (error) { this.state = 'failed'; this.error = error.message; throw error; }
      }
      this.state = 'starting';
      // Waiting for memory is independent of starting a backend. Do not hold
      // the member's one-at-a-time startup queue while another plugin waits for
      // capacity: a different, already-funded plugin may still be runnable.
      try {
        if (this.admit) await this.admit(controller.signal, () => this.memoryWaitRequested);
        this.requireStart();
        if (controller.signal.aborted) throw controller.signal.reason;
      } catch (error) {
        this.state = 'failed';
        this.error = error.message;
        throw new Error(this.id + ' 插件启动失败：' + error.message);
      }
      this.queued = this.queue.enqueue(async () => {
        if (!this.canStart()) {
          this.state = 'sleeping';
          this.requireStart();
        }
        const started = this.now();
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          await this.start(controller.signal);
          this.wakeMs = this.now() - started;
          this.error = undefined;
          this.state = this.active ? 'busy' : 'ready';
          this.lastActivity = this.now();
        } catch (error) {
          this.state = 'failed';
          this.error = error.message;
          throw new Error(this.id + ' 插件启动失败：' + error.message);
        }
      }, this.foregroundRequested ? 0 : 1);
      return this.queued.promise;
    })().finally(() => { this.starting = undefined; this.startController = undefined; this.queued = undefined; });
    return this.waitStarting(signal);
  }
  async acquire({ foreground = true, usage = false, signal } = {}) {
    for (;;) {
      if (!this.canStart() && this.waitOpen) await this.waitOpen(signal);
      this.requireStart();
      if (signal?.aborted) throw signal.reason || new Error('操作已取消');
      // A confirmed in-process lease already owns this plugin's whole memory
      // limit. Reuse it synchronously instead of repeating the broker request
      // for every page/API/WebSocket request; pending waiters are never enough.
      const existing = this.holdConfirmed({ usage });
      if (existing) return existing;
      this.active++;
      this.lastActivity = this.now();
      try {
        if (usage) { this.recordUse(this.id); usage = false; }
        await this.ensureStarted({ foreground, signal });
        this.requireStart();
        break;
      } catch (error) {
        this.active--;
        if (!this.canStart() && this.waitOpen && !signal?.aborted) {
          await this.waitOpen(signal);
          continue;
        }
        throw error;
      }
    }
    this.state = 'busy';
    this.confirmedLeases++;
    return this.releaseLease();
  }
  holdConfirmed({ usage = false } = {}) {
    if (!this.canStart() || !this.confirmedLeases || this.starting || this.stopping || !['ready', 'busy'].includes(this.state)) return null;
    if (usage) this.recordUse(this.id);
    this.active++;
    this.confirmedLeases++;
    this.lastActivity = this.now();
    return this.releaseLease();
  }
  releaseLease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.confirmedLeases--;
      this.lastActivity = this.now();
      if (this.state !== 'failed') this.state = this.active || this.work.busy ? 'busy' : 'ready';
    };
  }
  async run(work, options) {
    const release = await this.acquire(options);
    try { return await work(); } finally { release(); }
  }
  async hasWork() {
    try { this.work = await this.inspect(); }
    catch (error) { this.work = { known: false, busy: true, error: error.message }; }
    if (this.work.known !== true) this.work.busy = true;
    if (this.work.busy) this.lastActivity = this.now();
    if (this.state === 'ready' || this.state === 'busy') this.state = this.active || this.work.busy ? 'busy' : 'ready';
    return this.work.busy;
  }
  async recover(restore) {
    if (await this.hasWork() && this.work.recover !== false) return this.run(restore, { foreground: false });
  }
  async sleepIfIdle() {
    const failedWithMemory = Boolean(this.admit) && this.state === 'failed';
    if (this.stopping || this.starting || this.active || (!['ready', 'busy'].includes(this.state) && !failedWithMemory)
      || (!failedWithMemory && this.now() - this.lastActivity < this.idleMs)) return false;
    if (await this.hasWork()) return false;
    if (this.active || this.starting || (!failedWithMemory && this.now() - this.lastActivity < this.idleMs)) return false;
    this.stopping = (async () => {
      try {
        await this.stop();
        this.state = 'sleeping';
        this.error = undefined;
        return true;
      } catch (error) {
        this.state = 'failed';
        this.error = error.message;
        return false;
      } finally { this.stopping = undefined; }
    })();
    return this.stopping;
  }
}

// Seven daily counters per runtime, in the member's existing private DSH_HOME.
export function createPluginUsage(path, now = Date.now) {
  let counters;
  try { counters = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; counters = {}; }
  const day = () => Math.floor(now() / 86_400_000);
  const prune = () => {
    for (const [id, days] of Object.entries(counters)) {
      for (const value of Object.keys(days)) if (Number(value) < day() - 6) delete days[value];
      if (!Object.keys(days).length) delete counters[id];
    }
  };
  return {
    record(id) {
      prune();
      counters[id] ||= {};
      counters[id][day()] = (counters[id][day()] || 0) + 1;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path + '.tmp', JSON.stringify(counters), { mode: 0o600 });
      renameSync(path + '.tmp', path);
    },
    top(available) {
      prune();
      const ranked = Object.entries(counters).filter(([id]) => available.has(id))
        .map(([id, days]) => [id, Object.values(days).reduce((sum, count) => sum + count, 0)])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([id]) => id);
      return ranked.length ? ranked : available.has('huobao') ? ['huobao'] : [];
    },
  };
}

export const pluginCoreHealth = (plugins) => ({ ready: true, plugins });
