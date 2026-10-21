import type { MessageHub } from '@hyperneo/shared';
import type { OperationRegistrySource } from '../operations/registry.ts';
import { createOperationRpcHandler } from '../operations/rpc-adapter.ts';
import type { UpgradeIdentity } from '../pairing/upgrade-auth.ts';

export function setupOperationHandlers(
  messageHub: MessageHub,
  registry: OperationRegistrySource,
  deviceOf: (clientId: string) => UpgradeIdentity | null
) {
  return messageHub.onRequest(
    'operation.invoke',
    createOperationRpcHandler(registry, (context) => {
      const device = context.clientId ? deviceOf(context.clientId) : null;
      return device ? { device } : {};
    })
  );
}
