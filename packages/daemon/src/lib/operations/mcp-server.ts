import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import {
  createOperationMcpHandler,
  OperationMcpInvocationSchema,
  type OperationRefusal,
} from './mcp-adapter.ts';
import type { CallerIdentity } from './caller.ts';
import {
  resolveOperationRegistry,
  type OperationCallerRole,
  type OperationRegistrySource,
} from './registry.ts';
import { coreOperationSignatures } from './core-signatures.ts';

export function createOperationMcpServer(
  registry: OperationRegistrySource,
  resolveCaller: () => CallerIdentity | Promise<CallerIdentity>,
  recordRefusal?: (refusal: OperationRefusal) => void | Promise<void>,
  descriptionRole?: OperationCallerRole
) {
  const signatures =
    descriptionRole === 'neo' ? coreOperationSignatures(resolveOperationRegistry(registry)) : '';
  const tools = [
    tool(
      'invoke',
      `Invoke {name,input}. operations.list discovers others; operations.describe {name} returns full schemas. message.send acceptance means durable mailbox persistence, not an agent reply.${signatures ? `\n\nCore input shapes:\n${signatures}` : ''}`,
      OperationMcpInvocationSchema.shape,
      createOperationMcpHandler(registry, resolveCaller, recordRefusal)
    ),
  ];
  return createSdkMcpServer({ name: OPERATIONS_MCP_SERVER_NAME, tools });
}
