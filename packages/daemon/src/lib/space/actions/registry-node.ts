import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import { wrapHandlerWithHooks } from '../runtime/workflow-hook-engine.ts';
import {
  createNodeAgentToolHandlers,
  type NodeAgentToolsConfig,
} from '../tools/node-agent-tools.ts';
import {
  ApproveTaskSchema,
  MarkCompleteSchema,
  SubmitForApprovalSchema,
} from '../tools/task-agent-tool-schemas.ts';
import {
  ArchiveTaskSchema,
  CreateStandaloneTaskSchema,
  GetExternalEventSchema,
  GetTaskSchema,
  ListArtifactsSchema,
  ListAuditEntriesSchema,
  ListChannelsSchema,
  ListDeliveriesSchema,
  ListPeersSchema,
  ListReachableAgentsSchema,
  ListSubscriptionsSchema,
  ListTasksSchema,
  PublishTaskSchema,
  RestoreNodeAgentSchema,
  SaveArtifactSchema,
  SendMessageSchema,
  SubscribeExternalEventSchema,
  SubscribePrEventsSchema,
  UnsubscribeExternalEventSchema,
} from '../tools/node-agent-tool-schemas.ts';
import type { ToolResult } from '../tools/tool-result.ts';
import { type ActionDefinition, defineAction, type ActionEntry } from './registry.ts';

function nodeAction<P>(entry: Omit<ActionEntry<P>, 'family'>): ActionDefinition {
  return defineAction({ ...entry, family: 'node' });
}

export function createNodeRegistryEntries(config: NodeAgentToolsConfig): ActionDefinition[] {
  const handlers = createNodeAgentToolHandlers({ ...config, disableAuditLogWrites: true });
  const {
    onSubmitForApproval,
    onMarkComplete,
    onSubscribeExternalEvent,
    onUnsubscribeExternalEvent,
    onListSubscriptions,
    externalEventStore,
    artifactRepo,
    onCreateStandaloneTask,
    onPublishTask,
    onArchiveTask,
    onApproveTask,
    taskRepo,
    auditLogRepo,
    hookEngine,
  } = config;
  const externalEventSubscriptions = Boolean(
    onSubscribeExternalEvent && onUnsubscribeExternalEvent
  );
  const hookMeta = {
    sessionId: config.mySessionId,
    agentName: config.myAgentName,
    nodeId: config.workflowNodeId,
    taskId: config.taskId,
  };
  const handlerMap = handlers as unknown as Record<
    string,
    (...args: unknown[]) => Promise<ToolResult>
  >;

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
      auditRedactKeys: ['message', 'data'],
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
    ...(artifactRepo
      ? [
          nodeAction({
            name: 'save_artifact',
            safetyClass: 'mutate',
            description:
              'Persist a structured fact to the run artifact store as one of link/commit_set/check/metric/decision/note.',
            paramsDoc: 'shape, kind?, key?, summary?, data?',
            auditRedactKeys: ['data'],
            paramsSchema: SaveArtifactSchema,
            handler: handlers.save_artifact,
          }),
          nodeAction({
            name: 'list_artifacts',
            safetyClass: 'read',
            description:
              'List artifacts for the current run, optionally filtered by nodeId or shape.',
            paramsDoc: 'nodeId?, type?',
            paramsSchema: ListArtifactsSchema,
            handler: handlers.list_artifacts,
          }),
        ]
      : []),
    ...(onCreateStandaloneTask
      ? [
          nodeAction({
            name: 'create_standalone_task',
            safetyClass: 'mutate',
            description:
              'Create a task request in this space with optional priority, workflow, dependencies, and draft flag.',
            paramsDoc:
              'title, description, priority?, custom_agent_id?, workflow_id?, depends_on?, draft?',
            auditRedactKeys: ['description'],
            paramsSchema: CreateStandaloneTaskSchema,
            handler: handlers.create_standalone_task,
          }),
        ]
      : []),
    ...(onPublishTask
      ? [
          nodeAction({
            name: 'publish_task',
            safetyClass: 'mutate',
            description: 'Publish a draft task (draft to open) so orchestration can pick it up.',
            paramsDoc: 'task_id',
            paramsSchema: PublishTaskSchema,
            handler: handlers.publish_task,
          }),
        ]
      : []),
    ...(onArchiveTask
      ? [
          nodeAction({
            name: 'archive_task',
            safetyClass: 'destructive',
            description:
              'Archive a task; archived tasks are excluded from most queries and cannot be reactivated.',
            paramsDoc: 'task_id',
            paramsSchema: ArchiveTaskSchema,
            autonomyRequirement: 4,
            handler: handlers.archive_task,
          }),
        ]
      : []),
    ...(onApproveTask
      ? [
          nodeAction({
            name: 'approve_task',
            safetyClass: 'mutate',
            description:
              'Self-approve THIS task as done and close the loop (terminal); autonomy must meet the workflow completion level.',
            paramsDoc: 'none',
            paramsSchema: ApproveTaskSchema,
            autonomyRequirement: config.workflow?.completionAutonomyLevel ?? 5,
            handler: handlers.approve_task,
          }),
        ]
      : []),
    ...(onSubmitForApproval
      ? [
          nodeAction({
            name: 'submit_for_approval',
            safetyClass: 'mutate',
            description: 'Request human sign-off for THIS task completion (terminal).',
            paramsDoc: 'reason?',
            paramsSchema: SubmitForApprovalSchema,
            handler: wrapHandlerWithHooks(
              'submit_for_approval',
              onSubmitForApproval,
              hookEngine,
              handlerMap,
              hookMeta
            ),
          }),
        ]
      : []),
    ...(onMarkComplete
      ? [
          nodeAction({
            name: 'mark_complete',
            safetyClass: 'mutate',
            description:
              'Finish post-approval work: transition THIS task from approved to done (routed post-approval session only).',
            paramsDoc: 'goal_update? (legacy, optional)',
            auditRedactKeys: ['goal_update'],
            paramsSchema: MarkCompleteSchema,
            handler: wrapHandlerWithHooks(
              'mark_complete',
              onMarkComplete,
              hookEngine,
              handlerMap,
              hookMeta
            ),
          }),
        ]
      : []),
    ...(taskRepo
      ? [
          nodeAction({
            name: 'list_tasks',
            safetyClass: 'read',
            description: 'List tasks in this space with optional status filter and compact mode.',
            paramsDoc: 'status?, compact?, limit?, offset?',
            paramsSchema: ListTasksSchema,
            handler: handlers.list_tasks,
          }),
          nodeAction({
            name: 'get_task',
            safetyClass: 'read',
            description: 'Read one task with status, result, and metadata.',
            paramsDoc: 'task_number? or task_id? (one required)',
            taskIdPreference: 'task_number',
            paramsSchema: GetTaskSchema,
            handler: handlers.get_task,
          }),
        ]
      : []),
    ...(auditLogRepo
      ? [
          nodeAction({
            name: 'list_audit_entries',
            safetyClass: 'read',
            description:
              'List MCP audit log entries for this space, optionally filtered by task or session.',
            paramsDoc: 'task_id?, session_id?, limit?, offset?',
            auditExempt: true,
            paramsSchema: ListAuditEntriesSchema,
            handler: handlers.list_audit_entries,
          }),
        ]
      : []),
  ];
}

const WORKER_SPACE_ACTION_ALLOWLIST = new Set([
  'get_external_event',
  'get_scheduled_task',
  'get_session_detail',
  'get_session_messages',
  'get_workflow_detail',
  'get_workflow_run',
  'inactivity_config_get',
  'list_scheduled_tasks',
  'list_sessions',
  'list_workflows',
  'suggest_workflow',
]);

export function composeRoleActionEntries(
  role: SpaceMcpSessionRole,
  spaceEntries: readonly ActionDefinition[],
  nodeEntries: readonly ActionDefinition[]
): ActionDefinition[] {
  const workerOnlyNodeNames = new Set(['approve_task', 'submit_for_approval', 'mark_complete']);
  const withSpaceFamily = (entry: ActionDefinition) => ({ ...entry, family: 'space' as const });

  if (role !== 'workflow_worker') {
    return spaceEntries.map(withSpaceFamily);
  }

  const nodeNames = new Set(nodeEntries.map((entry) => entry.name));
  const isWorkerSpaceAllowed = (entry: ActionDefinition) =>
    WORKER_SPACE_ACTION_ALLOWLIST.has(entry.name) && !workerOnlyNodeNames.has(entry.name);

  return [
    ...nodeEntries,
    ...spaceEntries
      .filter((entry) => !nodeNames.has(entry.name) && isWorkerSpaceAllowed(entry))
      .map(withSpaceFamily),
  ];
}
