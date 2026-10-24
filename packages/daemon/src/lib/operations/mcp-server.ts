import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import {
  createOperationMcpHandler,
  OperationMcpInvocationSchema,
  type OperationRefusal,
} from './mcp-adapter.ts';
import type { CallerIdentity } from './caller.ts';
import type { OperationRegistrySource } from './registry.ts';

export function createOperationMcpServer(
  registry: OperationRegistrySource,
  resolveCaller: () => CallerIdentity | Promise<CallerIdentity>,
  signatures = '',
  recordRefusal?: (refusal: OperationRefusal) => void | Promise<void>
) {
  const tools = [
    tool(
      'invoke',
      `Invoke a daemon operation by name. Core operation input fields are included below when available. operations.list discovers other operations; operations.describe {name} returns their schemas. A message.send acceptance means durable mailbox persistence, not an agent reply.${signatures ? `\n\nInput fields of the core operations (? marks optional); call operations.describe only for others:\n${signatures}` : ''}`,
      OperationMcpInvocationSchema.shape,
      createOperationMcpHandler(registry, resolveCaller, recordRefusal)
    ),
  ];
  return createSdkMcpServer({ name: OPERATIONS_MCP_SERVER_NAME, tools });
}
