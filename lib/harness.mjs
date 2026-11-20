import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const version = '0.2.2-rc.5';
const binary = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url));
const bins = fileURLToPath(new URL('../node_modules/.bin', import.meta.url));

export function createHarness({ data, port, token, modelProfile, pluginServers }) {
  const home = join(data, 'dsh');
  const workspace = join(data, 'dsh-workspace');
  const webPort = Number(process.env.GREENROOM_DSH_PORT ?? port + 1);
  const base = 'http://127.0.0.1:' + port;
  let child;
  let starting;
  let state = { status: 'stopped', version };
  const status = () => state;

  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const current = child;
    const timeout = setTimeout(() => current.kill('SIGKILL'), 4000);
    try {
      const exited = once(current, 'exit');
      current.kill('SIGTERM');
      await exited;
    } finally { clearTimeout(timeout); }
  }

  async function boot(restart) {
    if (child && !restart && state.status === 'ready') return state;
    if (!existsSync(binary)) return state = { status: 'error', version, issue: '请先运行 npm ci 安装官方 DSH。' };
    if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535 || webPort === port) {
      return state = { status:'error', version, issue:'GREENROOM_DSH_PORT 无效或与控制台端口相同。' };
    }
    await stop();
    state = { status: 'starting', version };
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const profile = await modelProfile();
    const first = profile.models?.find(model => model.id === 'gpt-6-luna') ?? profile.models?.[0];
    const patch = [{
      id:'greenroom-mcp', name:'@deepseek-ai/dsh-mcp-client',
      config:{ serverName:'greenroom', transport:'streamable-http', url:base + '/mcp',
        headers:{ Authorization:'Bearer ' + token }, toolCallTimeoutMs:170_000 },
    }];
    for (const { id, mcp_url } of pluginServers()) {
      patch.push({
        id:'greenroom-mcp-' + id, name:'@deepseek-ai/dsh-mcp-client',
        config:{ serverName:id, transport:'streamable-http', url:mcp_url, startupTimeoutMs:4000 },
      });
    }
    if (first) {
      patch.push({
        id:'llm-pi-ai',
        config:{ providers:{ 'greenroom':{
          displayName:'Greenroom',
          api: profile.protocol === 'responses' ? 'openai-responses' : 'openai-completions',
          baseURL:base + '/gateway/dsh/v1',
          apiKeyEnv:'GREENROOM_BRIDGE_KEY',
          models:profile.models.map(model => ({ id:model.id })),
        } } },
      }, { id:'agent-default-model', config:{ provider:'greenroom', model:first.id } });
    }
    const patchFile = join(home, 'greenroom.overlay.yml');
    writeFileSync(patchFile, JSON.stringify(patch, null, 2), { mode: 0o600 });

    return new Promise(resolve => {
      const processRef = spawn(process.execPath,
        [binary, '--profile', 'web', '--patch', patchFile, '--host', '127.0.0.1', '--port', String(webPort), '--no-open'],
        { cwd:workspace, env:{ ...process.env, DSH_HOME:home,
          PATH:bins + delimiter + process.env.PATH, GREENROOM_BRIDGE_KEY:token }, stdio:['ignore','pipe','pipe'] });
      child = processRef;
      processRef.stderr.resume();
      const lines = createInterface({ input:processRef.stdout });
      const timer = setTimeout(() => {
        state = { status:'error', version, issue:'官方 DSH 启动超时。检查对应端口和 npm 依赖。' };
        processRef.kill('SIGTERM');
        resolve(state);
      }, 35_000);
      const finish = (issue) => {
        clearTimeout(timer);
        if (child === processRef) {
          child = undefined;
          if (state.status !== 'error') state = { status:'stopped', version, issue };
        }
        resolve(state);
      };
      processRef.once('error', () => finish('无法启动官方 DSH。'));
      processRef.once('exit', code => finish(code ? '官方 DSH 进程已退出。' : undefined));
      lines.on('line', line => {
        const link = line.replace(/\x1b\[[0-9;]*m/g, '').match(/^dsh web:\s+(http:\/\/\S+)$/)?.[1];
        if (!link || state.status !== 'starting' || child !== processRef) return;
        const parsed = new URL(link);
        if (parsed.origin !== 'http://127.0.0.1:' + webPort || parsed.username || parsed.password) return;
        clearTimeout(timer);
        state = { status:'ready', version, url:link, model:first?.id ?? null,
          issue:profile.issue ?? (!first ? '默认网关暂无文本模型。' : undefined) };
        resolve(state);
      });
    });
  }

  return {
    status,
    start: restart => starting ??= boot(restart).finally(() => { starting = undefined; }),
    stop,
  };
}
