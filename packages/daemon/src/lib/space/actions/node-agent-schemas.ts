import { ARTIFACT_SHAPES } from '@hyperneo/shared';
import { z } from 'zod';

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
  workspace: z
    .string()
    .optional()
    .describe(
      'Optional workspace for this task, given as the label or absolute path of a workspace registered in this space. Omit to use the space primary workspace; in a multi-workspace space whose primary is not a git repository, omitting it is rejected and an explicit workspace is required. Unknown labels or paths are rejected with the list of registered workspaces.'
    ),
});

export type CreateStandaloneTaskInput = z.infer<typeof CreateStandaloneTaskSchema>;

export const ListArtifactsSchema = z.object({
  nodeId: z.string().describe('Filter by node ID').optional(),
  type: z
    .string()
    .describe('Filter by artifact shape (e.g. "link", "decision", "note")')
    .optional(),
});

export type ListArtifactsInput = z.infer<typeof ListArtifactsSchema>;
