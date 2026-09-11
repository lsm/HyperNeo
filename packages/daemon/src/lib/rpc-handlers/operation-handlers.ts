import type { MessageHub } from '@hyperneo/shared';
import type { OperationRegistrySource } from '../operations/registry.ts';
import { createOperationRpcHandler } from '../operations/rpc-adapter.ts';

export function setupOperationHandlers(messageHub: MessageHub, registry: OperationRegistrySource) {
  return messageHub.onRequest(
    'operation.invoke',
    createOperationRpcHandler(registry, () => ({}))
  );
}
