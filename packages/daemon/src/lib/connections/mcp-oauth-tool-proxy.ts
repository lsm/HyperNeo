import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { type createMcpOAuthRowClient, RowFailure } from './mcp-oauth-row-client.ts';

const maxResultBytes = 32768;
const maxResultItems = 32;
const truncated = { type: 'text', text: '[truncated]' } as const;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function capResult(result: CallToolResult): CallToolResult {
  if (result.content.length <= maxResultItems && size(result) <= maxResultBytes) return result;
  const content: CallToolResult['content'] = [truncated];
  for (const item of result.content.slice(0, maxResultItems - 1)) {
    content.splice(-1, 0, item);
    if (size({ content }) <= maxResultBytes) continue;
    content.splice(-2, 1);
    if (item.type === 'text') {
      const characters = Array.from(item.text);
      let low = 0;
      let high = Math.min(maxResultBytes, characters.length);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const part = { type: 'text', text: characters.slice(0, mid).join('') };
        if (size({ content: [...content, part] }) <= maxResultBytes) low = mid;
        else high = mid - 1;
      }
      if (low) content.splice(-1, 0, { type: 'text', text: characters.slice(0, low).join('') });
    }
    break;
  }
  return { content };
}

const reason = (error: unknown) => (error instanceof RowFailure ? error.message : 'request_failed');

export function createMcpOAuthToolProxy(
  client: ReturnType<typeof createMcpOAuthRowClient>,
  id: string,
  name: string
) {
  const config = createSdkMcpServer({ name });
  const { server } = config.instance;
  server.registerCapabilities({ tools: {} });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const { tools, nextCursor } = await client.listTools(id);
      if (
        nextCursor !== undefined ||
        tools.length > 128 ||
        size(tools) > 65536 ||
        tools.some((tool) => Buffer.byteLength(tool.description ?? '') > 16384)
      )
        throw new RowFailure('response_too_large');
      return { tools };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, reason(error));
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      return capResult(
        await client.callTool(id, { name: params.name, arguments: params.arguments })
      );
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: reason(error) }] };
    }
  });
  return config;
}
