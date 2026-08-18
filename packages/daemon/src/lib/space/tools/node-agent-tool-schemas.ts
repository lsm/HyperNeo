import { z } from 'zod';
import { ARTIFACT_SHAPES } from '@hyperneo/shared';

export const ListPeersSchema = z.object({});

export type ListPeersInput = z.infer<typeof ListPeersSchema>;

export const SendMessageSchema = z.object({
  target: z
    .union([z.string(), z.array(z.string())])
    .describe(
      "Delivery target: agent name (DM), node name (fan-out), array of agent names (multicast), or '*' (broadcast to all permitted targets)"
    ),
  message: z.string().min(1).describe('The message content to send to the target peer(s)'),
  data: z
    .record(z.string(), z.unknown())
    .describe(
      'Optional structured data payload. Passed through to the target agent and available to send_message hooks.'
    )
    .optional(),
});

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

export const SubscribeExternalEventSchema = z.object({
  topicPattern: z
    .string()
    .min(1)
    .describe(
      'Glob pattern matching event topics (e.g. github/lsm/neokai/pull_request/*.review_*)'
    ),
  label: z.string().describe('Optional label for diagnostics').optional(),
});

export type SubscribeExternalEventInput = z.infer<typeof SubscribeExternalEventSchema>;

export const UnsubscribeExternalEventSchema = z.object({
  topicPattern: z.string().min(1).describe('The topic pattern to unsubscribe'),
});

export type UnsubscribeExternalEventInput = z.infer<typeof UnsubscribeExternalEventSchema>;

export const SubscribePrEventsSchema = z.object({
  prUrl: z
    .string()
    .optional()
    .describe(
      "GitHub PR URL to scope events to (e.g. 'https://github.com/owner/repo/pull/123'). " +
        "Omit to use this workflow run's current PR, resolved from hook state / artifacts."
    ),
  label: z.string().describe('Optional label for diagnostics').optional(),
});

export type SubscribePrEventsInput = z.infer<typeof SubscribePrEventsSchema>;

export const GetExternalEventSchema = z.object({
  eventId: z
    .string()
    .min(1)
    .describe('The id of the external event to fetch (as carried in injected event digests)'),
});

export type GetExternalEventInput = z.infer<typeof GetExternalEventSchema>;

export const ListDeliveriesSchema = z.object({
  workflowRunId: z
    .string()
    .min(1)
    .describe(
      'Filter to a single workflow run (the delivery `workflow_run_id`). ' +
        'Defaults to this workflow run. Pass an explicit value to inspect another run in the same Space.'
    )
    .optional(),
  nodeId: z
    .string()
    .min(1)
    .describe('Filter to deliveries targeting a single workflow node (`node_id`).')
    .optional(),
  state: z
    .enum(['pending', 'delivered', 'failed'])
    .describe('Filter by delivery state: pending / delivered / failed.')
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .describe('Maximum deliveries to return (1-200, default 50)')
    .optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .describe('Number of deliveries to skip for pagination (default 0)')
    .optional(),
});

export type ListDeliveriesInput = z.infer<typeof ListDeliveriesSchema>;

export const ListSubscriptionsSchema = z.object({
  workflowRunId: z
    .string()
    .min(1)
    .describe(
      'Filter to a single workflow run. Defaults to this workflow run. ' +
        'Pass an explicit value to inspect another run in the same Space.'
    )
    .optional(),
  nodeId: z
    .string()
    .min(1)
    .describe('Filter to a single workflow node (matches declared/persisted/active entries).')
    .optional(),
});

export type ListSubscriptionsInput = z.infer<typeof ListSubscriptionsSchema>;

export const SaveArtifactSchema = z.object({
  shape: z
    .enum(ARTIFACT_SHAPES)
    .describe(
      "Structured shape from the closed set: 'link' | 'commit_set' | 'check' | 'metric' | 'decision' | 'note'. Required."
    ),
  kind: z
    .string()
    .min(1)
    .describe(
      "Semantic hint (freeform): 'pr', 'issue', 'preview', 'ci', 'review', etc. Used for the UI label/icon and folds into the identity key."
    )
    .optional(),
  key: z
    .string()
    .describe(
      "Identity key override. Derived from the shape by default. Pass an explicit value only for multi-instance shapes — multi-round history (decision key: 'round-0') or per-attempt audit trails (note key: 'attempt-0')."
    )
    .optional(),
  summary: z
    .string()
    .describe('Short human note (≤1 sentence). Stored as data.summary for note/decision shapes.')
    .optional(),
  data: z
    .record(z.string(), z.unknown())
    .describe(
      'Shape-specific structured payload. Required fields vary by shape (link.url, check.name+status, decision.recommendation, etc.).'
    )
    .optional(),
});

export type SaveArtifactInput = z.infer<typeof SaveArtifactSchema>;

export const ListTasksSchema = z.object({
  status: z
    .enum([
      'draft',
      'open',
      'in_progress',
      'review',
      'approved',
      'done',
      'blocked',
      'cancelled',
      'archived',
    ])
    .describe('Filter by task status')
    .optional(),
  compact: z
    .boolean()
    .describe(
      'Return only summary fields (id, title, status, priority, createdAt) to reduce payload size'
    )
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe('Maximum number of tasks to return (1-100, default 20)')
    .optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .describe('Number of tasks to skip for pagination (default 0)')
    .optional(),
});

export type ListTasksInput = z.infer<typeof ListTasksSchema>;

export const GetTaskSchema = z.object({
  task_id: z.string().describe('UUID of the task to retrieve').optional(),
  task_number: z
    .number()
    .describe('Numeric task ID (e.g. 5 for task #5) — preferred over task_id')
    .optional(),
});

export type GetTaskInput = z.infer<typeof GetTaskSchema>;

export const ListAuditEntriesSchema = z.object({
  task_id: z.string().describe('Filter by task ID').optional(),
  session_id: z.string().describe('Filter by session ID').optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe('Maximum number of entries to return (1-100, default 20)')
    .optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .describe('Number of entries to skip for pagination (default 0)')
    .optional(),
});

export type ListAuditEntriesInput = z.infer<typeof ListAuditEntriesSchema>;

export const CreateStandaloneTaskSchema = z.object({
  title: z.string().describe('Short title for the task'),
  description: z.string().describe('Detailed description of the work to be done'),
  priority: z
    .enum(['low', 'normal', 'high', 'urgent'])
    .describe('Task priority (default: normal)')
    .optional(),
  custom_agent_id: z.string().describe('ID of a worker agent to assign this task to').optional(),
  workflow_id: z
    .string()
    .describe(
      'ID of the workflow to use for this task. When provided, the runtime uses this workflow instead of auto-selecting one.'
    )
    .optional(),
  depends_on: z
    .array(z.string())
    .describe(
      'List of task IDs this task depends on. All must be in the same space. The task will be blocked until every dependency reaches status=done.'
    )
    .optional(),
  draft: z
    .boolean()
    .describe(
      'When true, create the task in draft status. Draft tasks are never auto-started by the runtime, even with a workflow and priority assigned. Must be explicitly published (draft → open) before orchestration picks it up.'
    )
    .optional(),
});

export type CreateStandaloneTaskInput = z.infer<typeof CreateStandaloneTaskSchema>;

export const ListReachableAgentsSchema = z.object({});

export type ListReachableAgentsInput = z.infer<typeof ListReachableAgentsSchema>;

export const ListChannelsSchema = z.object({});

export type ListChannelsInput = z.infer<typeof ListChannelsSchema>;

export const ListArtifactsSchema = z.object({
  nodeId: z.string().describe('Filter by node ID').optional(),
  type: z
    .string()
    .describe('Filter by artifact shape (e.g. "link", "decision", "note")')
    .optional(),
});

export type ListArtifactsInput = z.infer<typeof ListArtifactsSchema>;

export const RestoreNodeAgentSchema = z.object({
  reason: z
    .string()
    .describe(
      'Optional human-readable reason for invoking restore (recorded in logs for diagnosis)'
    )
    .optional(),
});

export type RestoreNodeAgentInput = z.infer<typeof RestoreNodeAgentSchema>;

export const PublishTaskSchema = z.object({
  task_id: z.string().describe('UUID of the draft task to publish (draft → open)'),
});

export type PublishTaskInput = z.infer<typeof PublishTaskSchema>;

export const ArchiveTaskSchema = z.object({
  task_id: z.string().describe('UUID of the task to archive'),
});

export type ArchiveTaskInput = z.infer<typeof ArchiveTaskSchema>;

export const NODE_AGENT_TOOL_SCHEMAS = {
  list_peers: ListPeersSchema,
  send_message: SendMessageSchema,
  save_artifact: SaveArtifactSchema,
  create_standalone_task: CreateStandaloneTaskSchema,
  list_artifacts: ListArtifactsSchema,
  list_reachable_agents: ListReachableAgentsSchema,
  list_channels: ListChannelsSchema,
  subscribe_external_event: SubscribeExternalEventSchema,
  unsubscribe_external_event: UnsubscribeExternalEventSchema,
  subscribe_pr_events: SubscribePrEventsSchema,
  get_external_event: GetExternalEventSchema,
  list_deliveries: ListDeliveriesSchema,
  list_subscriptions: ListSubscriptionsSchema,
  restore_node_agent: RestoreNodeAgentSchema,
  list_tasks: ListTasksSchema,
  get_task: GetTaskSchema,
  list_audit_entries: ListAuditEntriesSchema,
  publish_task: PublishTaskSchema,
  archive_task: ArchiveTaskSchema,
} as const;

export type NodeAgentToolName = keyof typeof NODE_AGENT_TOOL_SCHEMAS;
