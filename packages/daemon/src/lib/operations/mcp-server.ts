import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import { createOperationMcpHandler, OperationMcpInvocationSchema } from './mcp-adapter.ts';
import type { CallerIdentity } from './caller.ts';
import type { OperationRegistrySource } from './registry.ts';

export function createOperationMcpServer(
  registry: OperationRegistrySource,
  resolveCaller: () => CallerIdentity | Promise<CallerIdentity>
) {
  const tools = [
    tool(
      'invoke',
      'Invoke a daemon operation by name. Call operations.list with no input to discover operations, then operations.describe with input {name} for its schema. A message.send acceptance means durable mailbox persistence, not an agent reply.',
      OperationMcpInvocationSchema.shape,
      createOperationMcpHandler(registry, resolveCaller)
    ),
  ];
  return { ...createSdkMcpServer({ name: OPERATIONS_MCP_SERVER_NAME, tools }), tools };
}
