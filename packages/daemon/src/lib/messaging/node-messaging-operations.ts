import type { OperationDefinition } from '../operations/registry.ts';
import { createListNodeChannelsOperation } from './node-channels-list.ts';
import type { NodeMessagingDependencies } from './node-messaging-context.ts';
import { createListNodeReachableAgentsOperation } from './node-reachable-agents-list.ts';

export function createNodeMessagingOperations(
  deps: NodeMessagingDependencies
): OperationDefinition[] {
  return [createListNodeReachableAgentsOperation(deps), createListNodeChannelsOperation(deps)];
}
