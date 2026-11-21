// Same-process runner primitive, not a CLI and not wired to production commands.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createActivationClient } from './activation-client.mjs';
import { startupUnit } from './activation-startup-unit.mjs';

export async function prepareStartupUnit({ unitId, binding, authority = null, journal = null,
  importConsumer = url => import(url) } = {}) {
  const unit = startupUnit(unitId);
  if (binding?.startup_unit !== unit.id) throw new TypeError('Runner unit binding mismatch');
  // One client per unit/runner instance, never one shared connector client.
  const activation = createActivationClient({ binding, authority, journal });
  // #27 consumer imports no backend until its callback is authorized. This
  // injection seam is for offline tests, not a plugin-supplied production API.
  const consumer = await importConsumer(pathToFileURL(join(unit.cwd, unit.consumer)).href);
  if (typeof consumer?.start !== 'function') throw new TypeError('Missing startup consumer');
  const completion = consumer.start(activation);
  return Object.freeze({ unit, completion, refresh: activation.refresh, status: activation.status });
}
