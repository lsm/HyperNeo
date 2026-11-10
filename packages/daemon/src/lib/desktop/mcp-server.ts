import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { createDesktopProxy } from './mcp-proxy.ts';
import type { createDriverTransport } from './driver-transport.ts';

export async function serveDesktopMcp(
  proxy: ReturnType<typeof createDesktopProxy>,
  driver: ReturnType<typeof createDriverTransport>
) {
  const server = createDesktopMcpServer(proxy);
  server.onclose = driver.close;
  void driver.closed.then(() => server.close());
  process.once('SIGTERM', driver.close);
  process.once('SIGINT', driver.close);
  process.stdin.once('end', driver.close);
  process.stdin.once('error', driver.close);
  await server.connect(new StdioServerTransport());
}

export function createDesktopMcpServer(proxy: ReturnType<typeof createDesktopProxy>) {
  const server = new Server(
    { name: 'hyperneo-desktop', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await proxy.list() }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    proxy.call(request.params.name, request.params.arguments ?? {})
  );
  return server;
}
