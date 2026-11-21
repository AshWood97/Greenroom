// Unwired DSH in-process adapter preparation. No factory or recovery on pending.
// ctx/authority/journal must come from the trusted host, never plugin arguments.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createActivationClient } from './activation-client.mjs';
import { startupUnit } from './activation-startup-unit.mjs';

// Observe immediately, without changing the original Promise's rejection.
// A settled failure is observable as unknown, never permission to release work.
export function observeActivationCompletion(completion) {
  const outcome = Promise.resolve(completion).then(
    value => ({ state: 'constructed', value, business_ready: false, release_allowed: false }),
    error => ({ state: 'unknown', error, business_ready: false, release_allowed: false }),
  );
  return Object.freeze({ completion, outcome });
}

export async function prepareAidAdapter({ ctx, binding, authority = null, journal = null,
  importConsumer = url => import(url) } = {}) {
  const unit = startupUnit('aid-studio.adapter');
  if (binding?.startup_unit !== unit.id || unit.kind !== 'adapter') throw new TypeError('Wrong AID startup unit');
  // Equality is a mismatch check, not proof of authentication or ctx provenance.
  if (!ctx || typeof ctx !== 'object' || ctx.memberId !== binding.member_id) throw new TypeError('AID ctx member mismatch');
  // Deliberately fail closed until the actual passive AID API and protected
  // second-stage recovery contract are delivered. Even injected positive
  // authority cannot enable the old factory/timer via this helper.
  const activation = createActivationClient({ binding });
  const consumer = await importConsumer(pathToFileURL(join(unit.cwd, unit.consumer)).href);
  if (typeof consumer.listTools !== 'function' || typeof consumer.createActivatedAdapter !== 'function') {
    throw new TypeError('Missing AID metadata/activation consumer');
  }
  const metadata = consumer.listTools(); // Actual pure export, never a temporary factory.
  let completion, preparationError, preparationFailed = false;
  try {
    completion = consumer.createActivatedAdapter(ctx, activation); // Preserve exact capabilities object.
  } catch (error) {
    // The current public AID entry explicitly refuses unverified binding before
    // construction. Preserve that refusal; never call a private/legacy fallback.
    preparationError = error;
    preparationFailed = true;
    completion = Promise.reject(error);
  }
  const observed = observeActivationCompletion(completion);
  // Never await completion here: pending must not block core preparation.
  const status = () => ({ ...activation.status(),
    ...(preparationFailed ? { phase: preparationError?.code === 'AID_ACTIVATION_BINDING_UNAVAILABLE' ? 'blocked' : 'unknown' } : {}),
    recovery_enabled: false,
    blocked_reason: preparationError?.code === 'AID_ACTIVATION_BINDING_UNAVAILABLE'
      ? 'consumer_binding_unavailable' : preparationFailed ? 'consumer_preparation_failed'
      : 'passive_api_and_protected_recovery_not_integrated' });
  const refresh = async () => { await activation.refresh(); return status(); };
  return Object.freeze({ unit, metadata, ...observed, refresh, status });
}
