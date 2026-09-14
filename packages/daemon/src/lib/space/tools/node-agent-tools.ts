import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  createNodeAgentToolHandlers,
  type NodeAgentToolsConfig,
} from '../actions/node-handlers.ts';
import { wrapHandlerWithHooks } from '../runtime/workflow-hook-engine.ts';
import { instrumentTypedTelemetryAtMcpBoundary } from './mcp-typed-telemetry-boundary.ts';
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
} from './node-agent-tool-schemas.ts';
import type { SubmitForApprovalInput } from './task-agent-tool-schemas.ts';
import {
  ApproveTaskSchema,
  MarkCompleteSchema,
  SubmitForApprovalSchema,
} from './task-agent-tool-schemas.ts';
import type { ToolResult } from './tool-result.ts';

export { createNodeAgentToolHandlers };
export type { NodeAgentToolsConfig, ToolResult };
export function createNodeAgentMcpServer(config: NodeAgentToolsConfig) {
  const handlers = createNodeAgentToolHandlers(config);
  async function submitForApproval(args: SubmitForApprovalInput): Promise<ToolResult> {
    return config.onSubmitForApproval!(args);
  }

  let wrappedSubmitForApproval = submitForApproval;
  let wrappedMarkComplete = config.onMarkComplete;
  if (config.hookEngine) {
    const meta = {
      sessionId: config.mySessionId,
      agentName: config.myAgentName,
      nodeId: config.workflowNodeId,
      taskId: config.taskId,
    };

    wrappedSubmitForApproval = wrapHandlerWithHooks(
      'submit_for_approval',
      submitForApproval,
      config.hookEngine,
      handlers as unknown as Record<string, (...args: unknown[]) => Promise<ToolResult>>,
      meta
    );

    if (wrappedMarkComplete) {
      wrappedMarkComplete = wrapHandlerWithHooks(
        'mark_complete',
        wrappedMarkComplete,
        config.hookEngine,
        handlers as unknown as Record<string, (...args: unknown[]) => Promise<ToolResult>>,
        meta
      );
    }
  }

  const tools = [
    tool(
      'list_peers',
      'List all other agents in this workflow node group with their agent names, statuses, session IDs, ' +
        'permitted channel connections, and output state from node executions. ' +
        'Use this to discover which peers are active, what direct messaging channels are available, ' +
        'and what output peers have saved (including their summaries).',
      ListPeersSchema.shape,
      (args) => handlers.list_peers(args)
    ),
    tool(
      'list_reachable_agents',
      'List all agents and nodes this agent can reach, grouped as within-node peers ' +
        '(agents in the same workflow node) and cross-node targets (agents/nodes on other nodes). ' +
        'Use this before sending a message to understand who you can reach.',
      ListReachableAgentsSchema.shape,
      (args) => handlers.list_reachable_agents(args)
    ),
    tool(
      'list_channels',
      'List all channels declared in this workflow. ' +
        'Channels define the messaging topology — which agents can communicate. Use this to ' +
        'understand the full channel map for this workflow run.',
      ListChannelsSchema.shape,
      (args) => handlers.list_channels(args)
    ),
    tool(
      'send_message',
      'Send a message to a peer agent by name (DM), a node by name (fan-out), or broadcast to all permitted targets. ' +
        "Use agent name for DM (e.g. 'coder'), node name for fan-out, or '*' for broadcast. " +
        'Validates against declared channel topology — returns an error with available targets if not permitted. ' +
        'The optional `data` payload is passed to any send_message hooks for validation.',
      SendMessageSchema.shape,
      (args) => handlers.send_message(args)
    ),
    ...(config.onSubscribeExternalEvent && config.onUnsubscribeExternalEvent
      ? [
          tool(
            'subscribe_external_event',
            'Subscribe to external events matching a topic pattern (e.g. github/*/*/pull_request/*.*). ' +
              'Use this during execution to receive matching events directly in this node-agent session.',
            SubscribeExternalEventSchema.shape,
            (args) => handlers.subscribe_external_event(args)
          ),
          tool(
            'unsubscribe_external_event',
            'Unsubscribe from external events for this node-agent session.',
            UnsubscribeExternalEventSchema.shape,
            (args) => handlers.unsubscribe_external_event(args)
          ),
          tool(
            'subscribe_pr_events',
            "Subscribe to GitHub PR events scoped to this workflow run's PR (reviews, comments, reactions). " +
              "Resolves the run's current PR automatically; pass `prUrl` to target a different PR. " +
              'Events are delivered to this node-agent session as messages. The coder node typically calls this.',
            SubscribePrEventsSchema.shape,
            (args) => handlers.subscribe_pr_events(args)
          ),
        ]
      : []),
    ...(config.onListSubscriptions
      ? [
          tool(
            'list_subscriptions',
            "Read-only diagnostic: snapshot this workflow run's external-event subscriptions across three layers — " +
              'declared (static interests in the workflow definition, durable), persisted (the dynamic subscription ' +
              'table, durable), and active (in-memory trie, a live cross-check only). Use this to confirm whether ' +
              'a node is actually wired to receive a class of events, and to surface declared-vs-active drift. ' +
              'The durable layers are the source of truth; the trie is never the answer. Defaults to this ' +
              'workflow run; pass `nodeId` to scope to one node.',
            ListSubscriptionsSchema.shape,
            (args) => handlers.list_subscriptions(args)
          ),
        ]
      : []),
    ...(config.externalEventStore
      ? [
          tool(
            'get_external_event',
            'Fetch the full raw record for a single external event by id — the on-demand deep-dive counterpart to ' +
              'the lean event summary injected into your session as a message. Use this for the rare case where the ' +
              'summary is not enough and you need the complete payload (incl. `rawPayload`, `body`, `actor`, ' +
              '`eventType`, source-native fields such as review `state`, check-run `conclusion`, diff `path`/`line`, etc.). ' +
              'Returns a not-found result for unknown ids.',
            GetExternalEventSchema.shape,
            (args) => handlers.get_external_event(args)
          ),
          tool(
            'list_deliveries',
            'Read-only diagnostic: list recent per-subscription external-event deliveries for a workflow run/node, ' +
              'joined to their source events. Use this to investigate why an event was or was not delivered ' +
              '(delivery state: pending / delivered / failed) and to see the event essence (topic, source, summary, url). ' +
              'Always scoped to the current space; defaults to this workflow run. ' +
              'These tables are space-scoped, so db_query cannot reach them — this tool is the surface for that state.',
            ListDeliveriesSchema.shape,
            (args) => handlers.list_deliveries(args)
          ),
        ]
      : []),
    tool(
      'restore_node_agent',
      'Self-heal primitive — call when you suspect the node-agent MCP server is unhealthy ' +
        '(e.g. a previous mcp__node-agent__send_message returned "No such tool available"). ' +
        'The fact that this call succeeds proves node-agent is registered for your session. ' +
        'The handler also re-attaches the server on the daemon side as a belt-and-braces ' +
        'measure and emits a structured log line for diagnosis. After calling, retry the ' +
        'failed tool once.',
      RestoreNodeAgentSchema.shape,
      (args) => handlers.restore_node_agent(args)
    ),
    ...(config.artifactRepo
      ? [
          tool(
            'save_artifact',
            'Persist a STRUCTURED FACT to the workflow run artifact store as a generic SHAPE from a ' +
              'closed set: `link`, `commit_set`, `check`, `metric`, `decision`, `note` — plus a freeform ' +
              '`kind` semantic hint (e.g. pr, issue, preview, ci, review). Provide `shape`, optional `kind`/' +
              '`key`, and at least one of `summary` or `data`. The shape drives structure and identity: ' +
              '`note` is a single rolling-status upsert; `link` is one per kind; `check`/`metric` keyed by name; ' +
              '`decision` is single-terminal or multi-round via `key`. Save structured facts (PR/preview/doc → ' +
              'link, CI/tests → check, review verdict → decision, current status → note), NOT a re-narration of ' +
              'the thread. Keep prose in chat; only structured facts belong here.',
            SaveArtifactSchema.shape,
            (args) => handlers.save_artifact(args)
          ),
          tool(
            'list_artifacts',
            'List artifacts for the current workflow run, optionally filtered by nodeId or shape ' +
              '(link/commit_set/check/metric/decision/note). Legacy type filters (progress/result/review/pr) ' +
              'are mapped to their shapes for compatibility.',
            ListArtifactsSchema.shape,
            (args) => handlers.list_artifacts(args)
          ),
        ]
      : []),
    ...(config.onCreateStandaloneTask
      ? [
          tool(
            'create_standalone_task',
            'Create a task request in this Space. Runtime may attach and execute a workflow for this task during orchestration. Supports structured task dependencies via depends_on — the task will be blocked until every listed dependency reaches status=done, and cascade-cancelled if a dependency is cancelled.',
            CreateStandaloneTaskSchema.shape,
            (args) => handlers.create_standalone_task(args)
          ),
        ]
      : []),
    ...(config.onPublishTask
      ? [
          tool(
            'publish_task',
            'Publish a draft task, transitioning it from draft to open status. Published tasks become eligible for orchestration by the runtime tick loop. Only valid for tasks currently in draft status.',
            PublishTaskSchema.shape,
            (args) => handlers.publish_task(args)
          ),
        ]
      : []),
    ...(config.onArchiveTask
      ? [
          tool(
            'archive_task',
            "Archive a task. Archived tasks are excluded from most queries and cannot be reactivated. Valid from any status that allows the 'archived' transition (e.g. draft, done, cancelled, blocked, review, approved).",
            ArchiveTaskSchema.shape,
            (args) => handlers.archive_task(args)
          ),
        ]
      : []),
    ...(config.onApproveTask
      ? [
          tool(
            'approve_task',
            'Close this task as done (self-approval). TERMINAL final action: do not send messages after calling. ' +
              'Only use when work is approved/QA-passed, all blocking findings are resolved, required review/artifact evidence is saved, and space autonomy meets workflow completionAutonomyLevel. ' +
              'If autonomy is too low, use submit_for_approval instead. Never use while findings, QA failures, or dispatch work remain open.',
            ApproveTaskSchema.shape,
            (args) => handlers.approve_task(args)
          ),
        ]
      : []),
    ...(config.onSubmitForApproval
      ? [
          tool(
            'submit_for_approval',
            "Request human sign-off for this task's completion. TERMINAL final action: do not send messages after calling. " +
              'Same approval semantic and preconditions as approve_task: use only when work is approved/QA-passed, all findings are resolved, and required review/artifact evidence is saved. ' +
              'Use when autonomy blocks self-close or risk warrants human sign-off. Never use to defer judgment while findings, QA failures, or dispatch work remain open.',
            SubmitForApprovalSchema.shape,
            wrappedSubmitForApproval
          ),
        ]
      : []),
    ...(wrappedMarkComplete
      ? [
          tool(
            'mark_complete',
            'Finish post-approval work and transition the task from `approved` to `done`. ' +
              'Call this after the post-approval instructions (e.g. merging a PR, ' +
              'publishing a release) have been carried out. Takes no arguments — the ' +
              'task is inferred from your session context. Distinct from `approve_task`: ' +
              '`approve_task` handles `in_progress → approved`; `mark_complete` handles ' +
              '`approved → done`. Rejected if the task is not currently in `approved`.',
            MarkCompleteSchema.shape,
            (args) => wrappedMarkComplete!(args)
          ),
        ]
      : []),
    ...(config.taskRepo
      ? [
          tool(
            'list_tasks',
            'List tasks in this space. Filterable by status. Use compact:true to reduce payload size. ' +
              'Use this to discover existing tasks before creating new ones or to check on task progress.',
            ListTasksSchema.shape,
            (args) => handlers.list_tasks(args)
          ),
          tool(
            'get_task',
            'Retrieve detailed information about a specific task including its status, result, and metadata. ' +
              'Provide either task_number (numeric ID like 5 for task #5, preferred) or task_id (UUID).',
            GetTaskSchema.shape,
            (args) => handlers.get_task(args)
          ),
        ]
      : []),
    ...(config.auditLogRepo
      ? [
          tool(
            'list_audit_entries',
            'List MCP audit log entries for this space. Filter by task_id or session_id. ' +
              'Returns entries ordered by timestamp descending (newest first). ' +
              'Use this to inspect the audit trail of tool operations performed by agents.',
            ListAuditEntriesSchema.shape,
            (args) => handlers.list_audit_entries(args)
          ),
        ]
      : []),
  ];

  const server = createSdkMcpServer({ name: 'node-agent', tools });
  instrumentTypedTelemetryAtMcpBoundary(server, config);
  return { ...server, tools };
}

export type NodeAgentMcpServer = ReturnType<typeof createNodeAgentMcpServer>;
