import type { MessageHub } from '@hyperneo/shared';
import type { InvokeDependenciesSource } from '../operations/invoke.ts';
import type { OperationRegistrySource } from '../operations/registry.ts';
import { createOperationRpcHandler } from '../operations/rpc-adapter.ts';

export function setupOperationHandlers(
  messageHub: MessageHub,
  registry: OperationRegistrySource,
  dependencies: InvokeDependenciesSource = {}
) {
  return messageHub.onRequest(
    'operation.invoke',
    createOperationRpcHandler(registry, () => ({}), dependencies)
  );
}
