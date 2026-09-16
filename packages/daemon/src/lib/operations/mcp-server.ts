import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { createOperationMcpHandler, OperationMcpInvocationSchema } from './mcp-adapter.ts';
import type { InvokeDependenciesSource } from './invoke.ts';
import type { OperationCaller, OperationRegistrySource } from './registry.ts';

export function createOperationMcpServer(
  registry: OperationRegistrySource,
  resolveCaller: () => Omit<OperationCaller, 'source'> | Promise<Omit<OperationCaller, 'source'>>,
  dependencies: InvokeDependenciesSource = {}
) {
  const tools = [
    tool(
      'invoke',
      'Invoke a daemon operation by name. Call operations.list with no input to discover operations, then operations.describe with input {name} for its schema. A message.send acceptance means durable mailbox persistence, not an agent reply.',
      OperationMcpInvocationSchema.shape,
      createOperationMcpHandler(registry, resolveCaller, dependencies)
    ),
  ];
  return { ...createSdkMcpServer({ name: 'operations', tools }), tools };
}
