import type { MessageHub } from '@hyperneo/shared';
import type { OperationRegistrySource } from '../operations/registry.ts';
import { createOperationRpcHandler } from '../operations/rpc-adapter.ts';
import type { UpgradeIdentity } from '../pairing/upgrade-auth.ts';

export function setupOperationHandlers(
  messageHub: MessageHub,
  registry: OperationRegistrySource,
  deviceOf: (clientId: string) => UpgradeIdentity | null
) {
  const invoke = createOperationRpcHandler(registry, (context) => {
    const device = context.clientId ? deviceOf(context.clientId) : null;
    return device ? { device } : {};
  });
  const unregisterUnarchive = messageHub.onRequest('session.unarchive', (input, context) =>
    invoke({ name: 'neo.session.unarchive', input }, context)
  );
  const unregisterInvoke = messageHub.onRequest('operation.invoke', invoke);
  return () => {
    unregisterUnarchive();
    unregisterInvoke();
  };
}
