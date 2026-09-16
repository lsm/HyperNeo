import type { OperationDefinition } from '../operations/registry.ts';
import { createListNodeChannelsOperation } from './node-channels-list.ts';
import type { NodeMessagingDependencies } from './node-messaging-context.ts';
import { createListNodePeersOperation } from './node-peers-list.ts';
import { createNodeSendMessageOperation } from './node-send-message.ts';
import { createListNodeReachableAgentsOperation } from './node-reachable-agents-list.ts';

export function createNodeMessagingOperations(
  deps: NodeMessagingDependencies
): OperationDefinition[] {
  return [
    createListNodePeersOperation(deps),
    createListNodeReachableAgentsOperation(deps),
    createListNodeChannelsOperation(deps),
    createNodeSendMessageOperation(deps),
  ];
}
