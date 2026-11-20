import { createHmac, timingSafeEqual } from 'node:crypto';

export function bridgeKey(workspaceKey, plugin) {
  return createHmac('sha256', workspaceKey).update('plugin:' + plugin).digest('base64url');
}

export function bearerMatches(header, key) {
  if (typeof header !== 'string') return false;
  const supplied = Buffer.from(header);
  const expected = Buffer.from('Bearer ' + key);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
