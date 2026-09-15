import type { MessageHub } from '@hyperneo/shared';
import {
  NO_CALLER_SCOPE,
  resolveTransportCallerIdentity,
  type CallerScopeResolver,
} from '../operations/caller.ts';
import type { OperationRegistrySource } from '../operations/registry.ts';
import { createOperationRpcHandler } from '../operations/rpc-adapter.ts';

export function setupOperationHandlers(
  messageHub: MessageHub,
  registry: OperationRegistrySource,
  resolveScope: CallerScopeResolver = NO_CALLER_SCOPE
) {
  return messageHub.onRequest(
    'operation.invoke',
    createOperationRpcHandler(registry, (context) =>
      resolveTransportCallerIdentity(resolveScope, context.sessionId)
    )
  );
}
