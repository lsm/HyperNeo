import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { createDesktopProxy } from './mcp-proxy.ts';

export async function serveDesktopMcp(proxy: ReturnType<typeof createDesktopProxy>) {
  const server = createDesktopMcpServer(proxy);
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  const close = () => void server.close();
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  process.stdin.once('end', close);
  process.stdin.once('error', close);
  await server.connect(new StdioServerTransport());
  await closed;
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
  const connect = server.connect.bind(server);
  server.connect = (transport) => {
    const start = transport.start.bind(transport);
    transport.start = async () => {
      const onmessage = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if (
          'method' in message &&
          message.method === 'tools/call' &&
          !CallToolRequestSchema.safeParse(message).success
        ) {
          const name = typeof message.params?.name === 'string' ? message.params.name : '';
          void proxy.call(name, null).then(
            () => onmessage?.(message, extra),
            () => server.close()
          );
        } else onmessage?.(message, extra);
      };
      await start();
    };
    return connect(transport);
  };
  return server;
}
