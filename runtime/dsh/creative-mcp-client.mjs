import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export const CREATIVE_MCP_ENDPOINT = 'http://127.0.0.1:18767/mcp';
export const CREATIVE_PLUGINS_RESOURCE = 'greenroom://plugins';

export async function connectCreativeMcp(name) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(CREATIVE_MCP_ENDPOINT)));
  return client;
}
