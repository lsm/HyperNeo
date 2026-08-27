import {
  createNodeAgentToolHandlers,
  type NodeAgentToolsConfig,
} from '../tools/node-agent-tools.ts';
import {
  GetExternalEventSchema,
  ListChannelsSchema,
  ListDeliveriesSchema,
  ListPeersSchema,
  ListReachableAgentsSchema,
  ListSubscriptionsSchema,
  RestoreNodeAgentSchema,
  SendMessageSchema,
  SubscribeExternalEventSchema,
  SubscribePrEventsSchema,
  UnsubscribeExternalEventSchema,
} from '../tools/node-agent-tool-schemas.ts';
import { type ActionDefinition, defineAction, type ActionEntry } from './registry.ts';

function nodeAction<P>(entry: Omit<ActionEntry<P>, 'family'>): ActionDefinition {
  return defineAction({ ...entry, family: 'node' });
}

export function createNodeRegistryEntries(config: NodeAgentToolsConfig): ActionDefinition[] {
  const handlers = createNodeAgentToolHandlers({ ...config, auditLogRepo: undefined });
  const {
    onSubscribeExternalEvent,
    onUnsubscribeExternalEvent,
    onListSubscriptions,
    externalEventStore,
  } = config;
  const externalEventSubscriptions = Boolean(
    onSubscribeExternalEvent && onUnsubscribeExternalEvent
  );

  return [
    nodeAction({
      name: 'list_peers',
      safetyClass: 'read',
      description:
        'List node-group peers with statuses, session ids, permitted direct-message targets, and saved output state.',
      paramsDoc: 'none',
      paramsSchema: ListPeersSchema,
      handler: handlers.list_peers,
    }),
    nodeAction({
      name: 'list_reachable_agents',
      safetyClass: 'read',
      description:
        'List within-node peers and cross-node targets reachable over declared channels, plus the space-agent escalation target.',
      paramsDoc: 'none',
      paramsSchema: ListReachableAgentsSchema,
      handler: handlers.list_reachable_agents,
    }),
    nodeAction({
      name: 'list_channels',
      safetyClass: 'read',
      description: 'List the channels declared in this workflow — the full messaging topology.',
      paramsDoc: 'none',
      paramsSchema: ListChannelsSchema,
      handler: handlers.list_channels,
    }),
    nodeAction({
      name: 'send_message',
      safetyClass: 'mutate',
      description:
        'Send a DM by agent name, fan out by node name, multicast by array, or broadcast with "*"; validates against channel topology.',
      paramsDoc: 'target (agent | node | agent[] | "*"), message, data?',
      paramsSchema: SendMessageSchema,
      handler: handlers.send_message,
    }),
    ...(externalEventSubscriptions
      ? [
          nodeAction({
            name: 'subscribe_external_event',
            safetyClass: 'mutate',
            description:
              'Subscribe this node-agent session to external events matching a topic glob.',
            paramsDoc: 'topicPattern, label?',
            paramsSchema: SubscribeExternalEventSchema,
            handler: handlers.subscribe_external_event,
          }),
          nodeAction({
            name: 'unsubscribe_external_event',
            safetyClass: 'mutate',
            description: 'Remove this session external-event subscription for a topic pattern.',
            paramsDoc: 'topicPattern',
            paramsSchema: UnsubscribeExternalEventSchema,
            handler: handlers.unsubscribe_external_event,
          }),
          nodeAction({
            name: 'subscribe_pr_events',
            safetyClass: 'mutate',
            description:
              "Subscribe to GitHub PR events scoped to this run's PR (or an explicit prUrl).",
            paramsDoc: 'prUrl?, label?',
            paramsSchema: SubscribePrEventsSchema,
            handler: handlers.subscribe_pr_events,
          }),
        ]
      : []),
    ...(onListSubscriptions
      ? [
          nodeAction({
            name: 'list_subscriptions',
            safetyClass: 'read',
            description:
              'Snapshot this run external-event subscriptions across the declared, persisted, and active layers.',
            paramsDoc: 'workflowRunId?, nodeId?',
            paramsSchema: ListSubscriptionsSchema,
            handler: handlers.list_subscriptions,
          }),
        ]
      : []),
    ...(externalEventStore
      ? [
          nodeAction({
            name: 'get_external_event',
            safetyClass: 'read',
            description: 'Fetch the full raw record for one external event by id.',
            paramsDoc: 'eventId',
            paramsSchema: GetExternalEventSchema,
            handler: handlers.get_external_event,
          }),
          nodeAction({
            name: 'list_deliveries',
            safetyClass: 'read',
            description:
              'List recent external-event deliveries for a run/node with delivery state and event essence.',
            paramsDoc: 'workflowRunId?, nodeId?, state?, limit?, offset?',
            paramsSchema: ListDeliveriesSchema,
            handler: handlers.list_deliveries,
          }),
        ]
      : []),
    nodeAction({
      name: 'restore_node_agent',
      safetyClass: 'mutate',
      description:
        'Self-heal: re-attach the node MCP server, confirm registration, then retry the failed tool once.',
      paramsDoc: 'reason?',
      paramsSchema: RestoreNodeAgentSchema,
      handler: handlers.restore_node_agent,
    }),
  ];
}
