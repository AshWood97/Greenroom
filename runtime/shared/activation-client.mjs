// Unwired in-process consumer protocol. No HTTP client, timer, ENV authorization
// or production caller. Injection is NOT proof of trusted transport/admission.
import { validateUnitBinding } from './activation-startup-unit.mjs';
const keys = ['startup_unit', 'parent_instance_id', 'member_id', 'wake_epoch', 'pod_uid', 'component', 'instance_id', 'activation_id'];
export function createActivationClient({ binding, authority = null, journal = null } = {}) {
  if (!binding || Object.keys(binding).sort().join(',') !== [...keys].sort().join(',')
      || !Number.isSafeInteger(binding.wake_epoch) || binding.wake_epoch < 1
      || keys.filter(key => key !== 'wake_epoch').some(key => typeof binding[key] !== 'string'
        || !binding[key].trim() || [...binding[key]].length > 512)) throw new TypeError('Invalid activation binding');
  validateUnitBinding(binding);
  const scope = Object.freeze({ ...binding });
  const matches = value => value && keys.every(key => value[key] === scope[key])
    && Object.keys(value).length === keys.length;
  let callback, promise, resolve, reject, refreshPromise;
  let phase = 'pending', attempted = false, attemptId = null;
  const status = () => ({ phase, binding: { ...scope }, attempt_id: attemptId,
    business_ready: false, action: 'none' });
  const uncertain = async () => {
    phase = 'unknown';
    if (attemptId && typeof journal?.markUnknown === 'function') {
      try { await journal.markUnknown({ binding: { ...scope }, attempt_id: attemptId }); }
      catch { /* Never retry callback or free protection after a lost receipt. */ }
    }
  };
  async function advance() {
    if (!callback || attempted || phase === 'imported') return status();
    if (typeof authority?.read !== 'function' || typeof journal?.claim !== 'function'
        || typeof journal?.markImported !== 'function') return status();
    let authorization;
    try { authorization = await authority.read({ ...scope }); }
    catch { phase = 'pending'; return status(); }
    if (!authorization || authorization.protocol !== 1 || authorization.phase !== 'activating'
        || authorization.initialize !== true || !matches(authorization.binding)) {
      phase = 'pending'; return status();
    }
    // Once claim is sent, even a lost response may mean its durable write took
    // effect. No automatic second claim/callback is made by this instance.
    attempted = true;
    phase = 'claiming';
    let receipt;
    try { receipt = await journal.claim({ binding: { ...scope } }); }
    catch { await uncertain(); return status(); }
    if (!receipt || !matches(receipt.binding) || typeof receipt.attempt_id !== 'string'
        || !receipt.attempt_id || receipt.disposition !== 'fresh') {
      // Includes an existing attempted/imported record after process restart.
      phase = 'unknown'; return status();
    }
    attemptId = receipt.attempt_id;
    phase = 'executing';
    try {
      const value = await callback();
      const result = await journal.markImported({ binding: { ...scope }, attempt_id: attemptId });
      if (!result || !matches(result.binding) || result.attempt_id !== attemptId || result.state !== 'imported')
        throw new Error('Import receipt unconfirmed');
      phase = 'imported';
      resolve(value); // Module import only; readiness and guard release are separate.
    } catch (error) {
      await uncertain();
      reject(error);
    }
    return status();
  }
  const refresh = () => {
    if (!refreshPromise) refreshPromise = advance().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };
  return Object.freeze({
    runStartupOnce(fn) {
      if (typeof fn !== 'function') throw new TypeError('Expected startup callback');
      if (!promise) {
        callback = fn;
        promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        // No implicit I/O or polling; the future trusted runner calls refresh.
      }
      return promise;
    },
    refresh,
    status,
  });
}
