import type { OperationRegistrySource } from '../../operations/registry.ts';
import {
  ListAgentEventSubscriptionsSchema,
  SubscribeAgentEventSchema,
  UnsubscribeAgentEventSchema,
} from './space-agent-schemas.ts';
import { createSpaceAgentToolHandlers, type SpaceAgentToolsConfig } from './space-handlers.ts';
import { type ActionDefinition, defineAction } from './registry.ts';

export function createSpaceRegistryEntries(
  config: SpaceAgentToolsConfig,
  _operations?: OperationRegistrySource
): ActionDefinition[] {
  const handlers = createSpaceAgentToolHandlers({ ...config, auditLogRepo: undefined });

  if (!config.db) return [];

  return [
    defineAction({
      name: 'subscribe_agent_event',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Record an external-event topic subscription for a long-horizon agent; returns the subscription record.',
      paramsDoc: 'agent_id, topic_pattern (glob), label?',
      paramsSchema: SubscribeAgentEventSchema,
      handler: (args) => handlers.subscribe_agent_event(args),
    }),
    defineAction({
      name: 'unsubscribe_agent_event',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Remove an external-event topic subscription from a long-horizon agent; returns success.',
      paramsDoc: 'agent_id, topic_pattern, label?',
      paramsSchema: UnsubscribeAgentEventSchema,
      handler: (args) => handlers.unsubscribe_agent_event(args),
    }),
    defineAction({
      name: 'list_agent_event_subscriptions',
      family: 'agents',
      safetyClass: 'read',
      description:
        'List external-event subscriptions for a long-horizon agent; returns subscription records.',
      paramsDoc: 'agent_id',
      paramsSchema: ListAgentEventSubscriptionsSchema,
      handler: (args) => handlers.list_agent_event_subscriptions(args),
    }),
  ];
}
