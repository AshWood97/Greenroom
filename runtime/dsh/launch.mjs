// Preserve the official WebUI; capture its loopback token without logging it.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync('/run/dsh', { recursive: true });
const env = { ...process.env, DSH_DEFAULT_WORKSPACE: '/workspace' };
if (env.GREENROOM_DSH_NATIVE !== '1') env.DSH_PERMISSION_MODE = 'read-only';
if (env.GREENROOM_DSH_NATIVE === '1' && env.GREENROOM_DSH_EXPERIMENTS === '1') {
  const { OPTIONAL_BUNDLES, PROFILE_TEMPLATES } = await import('@deepseek-ai/dsh-official-bundles');
  const directory = join(env.DSH_HOME, 'profiles', 'web');
  const file = join(directory, 'package.json');
  const profile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
    name: 'dsh-profile-web', private: true, type: 'module', dependencies: {},
  };
  profile.dsh ??= {};
  profile.dsh.profile ??= {};
  const configured = profile.dsh.profile.bundles ?? PROFILE_TEMPLATES.web.bundles;
  const bundles = [...new Set([...configured, ...OPTIONAL_BUNDLES])];
  if (!existsSync(file) || bundles.length !== configured.length) {
    mkdirSync(directory, { recursive: true });
    profile.dsh.profile.bundles = bundles;
    writeFileSync(file + '.tmp', JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
}
const child = spawn('node', ['/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--patch', '/etc/dsh/greenroom.patch.yml', '--host', '127.0.0.1', '--port', '3080', '--no-open'], {
  stdio: ['ignore', 'pipe', 'pipe'], cwd: '/workspace',
  env,
});
let pending = '';
function consume(chunk) {
  pending += chunk.toString();
  for (;;) {
    const index = pending.indexOf('\n');
    if (index < 0) break;
    const line = pending.slice(0, index); pending = pending.slice(index + 1);
    const token = line.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token) {
      writeFileSync('/run/dsh/launch-token.tmp', token, { mode: 0o640 });
      renameSync('/run/dsh/launch-token.tmp', '/run/dsh/launch-token');
      process.stdout.write('Official DSH WebUI started on loopback port 3080\n');
    } else {
      process.stdout.write(line.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')+'\n');
    }
  }
}
child.stdout.on('data', consume); child.stderr.on('data', consume);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
