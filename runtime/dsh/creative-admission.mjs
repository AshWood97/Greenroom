// Short, repeatable preparation requests keep long memory waits out of HTTP and
// WebSocket handshakes. A ticket owns one lifecycle lease until it is claimed,
// cancelled, or the client stops polling. No business operation runs here.
export function createCreativeAdmission(resolveLifecycle, { ttlMs = 30_000 } = {}) {
  const entries = new Map();
  const keyFor = (plugin, ticket) => `${plugin}:${ticket}`;
  const valid = (ticket) => typeof ticket === 'string' && /^[a-f0-9-]{36}$/.test(ticket);
  function expire(entry) {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    clearTimeout(entry.timer);
    entry.controller.abort();
    entry.release?.();
  }
  function touch(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => expire(entry), ttlMs);
    entry.timer.unref?.();
  }
  return {
    prepare(plugin, ticket) {
      if (!valid(ticket)) throw new Error('等待编号无效');
      const key = keyFor(plugin, ticket);
      let entry = entries.get(key);
      if (!entry) {
        const lifecycle = resolveLifecycle(plugin);
        entry = { key, lifecycle, controller: new AbortController(), state: 'waiting' };
        entries.set(key, entry);
        Promise.resolve().then(() => lifecycle ? lifecycle.acquire({ signal: entry.controller.signal }) : () => {})
          .then((release) => {
            if (entries.get(key) !== entry || entry.controller.signal.aborted) return release();
            entry.release = release;
            entry.state = 'ready';
          }, (error) => {
            if (entries.get(key) === entry && !entry.controller.signal.aborted) {
              entry.state = 'failed';
              entry.error = error?.message || '插件准备失败';
            }
          });
      }
      touch(entry);
      return { state: entry.state, ...(entry.error ? { error: entry.error } : {}) };
    },
    claim(plugin, ticket) {
      if (!valid(ticket)) return { state: 'missing' };
      const entry = entries.get(keyFor(plugin, ticket));
      if (!entry) return { state: 'missing' };
      if (entry.state !== 'ready') return { state: entry.state };
      entry.state = 'claimed';
      clearTimeout(entry.timer);
      const release = entry.release;
      entry.release = undefined;
      return { state: 'claimed', lifecycle: entry.lifecycle, release: () => {
        release?.();
        // Retain the claimed identity briefly so a concurrent duplicate cannot
        // be mistaken for a fresh, unexecuted request.
        if (entries.get(entry.key) === entry) touch(entry);
      } };
    },
    cancel(plugin, ticket) {
      if (!valid(ticket)) return false;
      const entry = entries.get(keyFor(plugin, ticket));
      if (!entry || entry.state === 'claimed') return false;
      expire(entry);
      return true;
    },
    close() { for (const entry of entries.values()) expire(entry); },
  };
}
