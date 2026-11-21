#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { connectCreativeMcp, CREATIVE_PLUGINS_RESOURCE } from './creative-mcp-client.mjs';

const usage = 'greenroom-mcp plugins list | tools list [--plugin ID] | tools describe NAME | call NAME [--json JSON | --json-file PATH]';

async function main(argv) {
  const [command, action, ...options] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(usage + '\n');
    return;
  }
  const flag = (name) => {
    const index = options.indexOf(name);
    if (index < 0) return undefined;
    if (index !== 0 || options.length !== 2) throw new Error(usage);
    return options[1];
  };
  const rawName = (name) => name?.replace(/^mcp__greenroom__/, '');
  if (!(command === 'plugins' && action === 'list' && !options.length)
      && !(command === 'tools' && action === 'list' && (!options.length || flag('--plugin')))
      && !(command === 'tools' && action === 'describe' && options.length === 1)
      && !(command === 'call' && action && (!options.length || flag('--json') !== undefined || flag('--json-file') !== undefined))) {
    throw new Error(usage);
  }
  const client = await connectCreativeMcp('greenroom-member-cli');
  try {
    let result;
    if (command === 'plugins') {
      const resource = await client.readResource({ uri: CREATIVE_PLUGINS_RESOURCE });
      result = JSON.parse(resource.contents.find((item) => item.text !== undefined).text);
    } else if (command === 'tools') {
      const { tools } = await client.listTools();
      if (action === 'describe') {
        result = tools.find((tool) => tool.name === rawName(options[0]));
        if (!result) throw new Error('业务工具不存在或尚未开放：' + options[0]);
      } else {
        const plugin = flag('--plugin');
        result = { tools: plugin ? tools.filter((tool) => tool._meta?.greenroom?.pluginId === plugin) : tools };
      }
    } else {
      const source = flag('--json') ?? (flag('--json-file') === undefined ? '{}' : await readFile(flag('--json-file'), 'utf8'));
      const args = JSON.parse(source);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须为 JSON 对象');
      result = await client.callTool({ name: rawName(action), arguments: args,
        ...(process.env.GREENROOM_MCP_INVOCATION ? { _meta: { greenroomInvocation: process.env.GREENROOM_MCP_INVOCATION } } : {}) },
      { timeout: 2_147_483_647 });
      if (result.isError) process.exitCode = 1;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    await client.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
