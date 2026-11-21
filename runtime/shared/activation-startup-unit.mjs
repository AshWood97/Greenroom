// Platform-owned fixed registry; not writable via plugin input or environment.
import { readFileSync } from 'node:fs';
const units = JSON.parse(readFileSync(new URL('./activation-startup-units.json', import.meta.url), 'utf8'));
export function startupUnit(id) {
  if (typeof id !== 'string' || !Object.hasOwn(units, id)) throw new TypeError('Unknown startup unit');
  return Object.freeze({ id, ...units[id] });
}
export function validateUnitBinding(binding) {
  const unit = startupUnit(binding?.startup_unit);
  if (binding.component !== unit.component) throw new TypeError('Wrong parent component for startup unit');
  return unit;
}
