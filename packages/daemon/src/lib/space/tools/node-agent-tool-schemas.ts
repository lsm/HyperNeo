/**
 * Node Agent MCP Tool Schemas — Zod schemas and TypeScript types for the
 * tools available to node agent sub-sessions.
 *
 * Action tools:
 *   send_message    — channel-validated direct messaging; writes gate data on gated channels
 *   save_artifact   — persist typed data to the workflow run artifact store (replaces save/write_artifact)
 *   create_standalone_task — create a new task in the same Space
 *
 * Discovery tools (read-only):
 *   list_artifacts       — list artifacts for the current workflow run
 *   list_peers           — list other group members with statuses and permitted channels
 *   list_reachable_agents — list all reachable agents/nodes grouped by proximity
 *   list_channels        — list all channels declared in the workflow
 *   list_gates           — list all gates with current runtime data
 *   read_gate            — read current data for a specific gate
 *
 * This file contains only schema definitions — no runtime logic or side effects.
 *
 * Style conventions (matching task-agent-tool-schemas.ts):
 *   - z.string().describe() on every field — .describe() before .optional()
 *   - optional fields use .optional() after .describe()
 */

import { z } from 'zod';
import { ARTIFACT_SHAPES } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// list_peers
// ---------------------------------------------------------------------------

/**
 * Schema for `list_peers` input.
 * Lists all other members of the current workflow node group.
 * No arguments — the group and self are inferred from the node agent context.
 */
export const ListPeersSchema = z.object({});

export type ListPeersInput = z.infer<typeof ListPeersSchema>;

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

/**
 * Schema for `send_message` input.
 *
 * Primary direct messaging tool for node agents. Validates against declared channel
 * topology before routing. Supports four target forms:
 *   - Agent name: `target: 'coder'` — DM to the named agent
 *   - Node name: `target: 'node-name'` — fan-out to all agents in the named node
 *   - Multicast array: `target: ['coder', 'reviewer']` — deliver to multiple agents
 *   - Broadcast to all permitted: `target: '*'`
 *
 * When the target channel is gated, the optional `data` payload is automatically
 * merged into the gate's data store (merge semantics: top-level keys overwrite,
 * other keys survive). Gate re-evaluation fires after the merge — if the gate
 * opens, the message is delivered immediately; otherwise it is held until the
 * gate condition passes.
 */
export const SendMessageSchema = z.object({
  /**
   * Delivery target: an agent name for DM, a node name for fan-out,
   * an array of agent names for multicast, or '*' for broadcast to all topology-permitted targets.
   * - Agent name: delivers to the specific agent (or all agents sharing the name)
   * - Node name: fan-out to all agents in the named node
   * - Array of agent names: multicast to each specified agent (all must be permitted)
   * - '*': broadcast to all permitted targets
   */
  target: z
    .union([z.string(), z.array(z.string())])
    .describe(
      "Delivery target: agent name (DM), node name (fan-out), array of agent names (multicast), or '*' (broadcast to all permitted targets)"
    ),
  /** The message to send to the target(s). */
  message: z.string().min(1).describe('The message content to send to the target peer(s)'),
  /**
   * Optional structured data payload attached to the message.
   * When the target channel is gated, this data is automatically merged into the gate.
   * Also passed through to the target as part of the delivery.
   */
  data: z
    .record(z.string(), z.unknown())
    .describe(
      'Optional structured data payload. Automatically merged into the gate data store when the channel is gated (merge semantics). Also passed through to the target agent.'
    )
    .optional(),
});

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

// ---------------------------------------------------------------------------
// external event subscriptions
// ---------------------------------------------------------------------------

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
        "Omit to use this workflow run's current PR, resolved from gate data / artifacts."
    ),
  label: z.string().describe('Optional label for diagnostics').optional(),
});

export type SubscribePrEventsInput = z.infer<typeof SubscribePrEventsSchema>;

// ---------------------------------------------------------------------------
// get_external_event
// ---------------------------------------------------------------------------

/**
 * Schema for `get_external_event` input.
 *
 * Fetches the full raw record for a single external event by its id — the
 * on-demand deep-dive counterpart to the lean "essence" injected into sessions
 * as a message. Use this for the rare (~1%) case where the digested summary is
 * not enough and you need the complete payload (incl. `rawPayload`, `body`,
 * `actor`, `eventType`, source-native fields, etc.).
 */
export const GetExternalEventSchema = z.object({
  eventId: z
    .string()
    .min(1)
    .describe('The id of the external event to fetch (as carried in injected event digests)'),
});

export type GetExternalEventInput = z.infer<typeof GetExternalEventSchema>;

// ---------------------------------------------------------------------------
// save_artifact
// ---------------------------------------------------------------------------

/**
 * Schema for `save_artifact` input.
 *
 * Persists data to the workflow run artifact store as a generic SHAPE from a
 * closed, domain-agnostic vocabulary: `link`, `commit_set`, `check`, `metric`,
 * `decision`, `note`. A SHAPE is structure (infra vocabulary); a KIND is a
 * freeform semantic label the domain supplies (e.g. `pr`, `issue`, `preview`,
 * `ci`, `review`). Infra never enumerates domain kinds.
 *
 * Identity is shape-aware and derived automatically (see examples below), so a
 * `note` is a single rolling status that upserts in place (no per-round growth),
 * a `link` is one-per-kind, and a `decision` is single-terminal unless you pass
 * an explicit multi-round `key` (e.g. 'round-0').
 *
 *   PR / preview / doc:   save_artifact({ shape: 'link', kind: 'pr',    data: { url, title } })
 *   CI / tests:           save_artifact({ shape: 'check',                data: { name: 'ci', status: 'pass', counts } })
 *   Review verdict:       save_artifact({ shape: 'decision', kind:'review', data: { recommendation: 'approve', summary } })
 *   Multi-round history:  save_artifact({ shape: 'decision', kind:'review', key: 'round-0', data: {...} })
 *   Rolling status:       save_artifact({ shape: 'note',                 data: { text: 'writing tests' } })
 */
export const SaveArtifactSchema = z.object({
  /**
   * STRUCTURE — closed vocabulary. One of the values in ARTIFACT_SHAPES.
   * Validated against the set; unknown values are rejected. Required.
   */
  shape: z
    .enum(ARTIFACT_SHAPES)
    .describe(
      "Structured shape from the closed set: 'link' | 'commit_set' | 'check' | 'metric' | 'decision' | 'note'. Required."
    ),
  /**
   * SEMANTIC hint (freeform, domain-extensible). Supplies the icon/label in
   * the UI and folds into the identity key for `link`/`decision` so one kind
   * never overwrites another. Examples: 'pr', 'issue', 'preview', 'ci', 'review'.
   */
  kind: z
    .string()
    .min(1)
    .describe(
      "Semantic hint (freeform): 'pr', 'issue', 'preview', 'ci', 'review', etc. Used for the UI label/icon and folds into the identity key."
    )
    .optional(),
  /**
   * Identity override. Defaults are derived from the shape (note→'current',
   * link→kind, check/metric→name, decision→key|kind|'current'). Pass an
   * explicit key only for multi-round history (e.g. decision 'round-0').
   */
  key: z
    .string()
    .describe(
      "Identity key override. Derived from the shape by default. Pass an explicit value only for multi-round history (e.g. decision key: 'round-0')."
    )
    .optional(),
  /** ≤1 sentence human note. Stored under data.summary (note/decision). */
  summary: z
    .string()
    .describe('Short human note (≤1 sentence). Stored as data.summary for note/decision shapes.')
    .optional(),
  /**
   * Shape-specific structured payload. Required fields depend on the shape
   * (e.g. link needs `url`; check needs `name`+`status`; decision needs
   * `recommendation`). Validated by save_artifact.
   */
  data: z
    .record(z.string(), z.unknown())
    .describe(
      'Shape-specific structured payload. Required fields vary by shape (link.url, check.name+status, decision.recommendation, etc.).'
    )
    .optional(),
});

export type SaveArtifactInput = z.infer<typeof SaveArtifactSchema>;

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

/**
 * Schema for `list_tasks` input.
 * Lists tasks in the current space. Filterable by status.
 */
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

// ---------------------------------------------------------------------------
// get_task
// ---------------------------------------------------------------------------

/**
 * Schema for `get_task` input.
 * Retrieves detailed information about a specific task by UUID or numeric task number.
 */
export const GetTaskSchema = z.object({
  task_id: z.string().describe('UUID of the task to retrieve').optional(),
  task_number: z
    .number()
    .describe('Numeric task ID (e.g. 5 for task #5) — preferred over task_id')
    .optional(),
});

export type GetTaskInput = z.infer<typeof GetTaskSchema>;

// ---------------------------------------------------------------------------
// list_audit_entries
// ---------------------------------------------------------------------------

/**
 * Schema for `list_audit_entries` input.
 * Lists MCP audit log entries for the current space, filtered by task or session.
 */
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

// ---------------------------------------------------------------------------
// create_standalone_task
// ---------------------------------------------------------------------------

/**
 * Schema for `create_standalone_task` input.
 *
 * Mirrors the Space Agent tool so workflow node agents can dispatch follow-up
 * work without needing the broader space-agent-tools MCP namespace.
 */
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

// ---------------------------------------------------------------------------
// list_reachable_agents
// ---------------------------------------------------------------------------

/**
 * Schema for `list_reachable_agents` input.
 * Lists all agents and nodes this agent can reach, grouped by within-node peers
 * and cross-node targets. Includes gate status for cross-node targets.
 * No arguments — the reachability graph is inferred from the agent's context.
 */
export const ListReachableAgentsSchema = z.object({});

export type ListReachableAgentsInput = z.infer<typeof ListReachableAgentsSchema>;

// ---------------------------------------------------------------------------
// list_channels
// ---------------------------------------------------------------------------

/**
 * Schema for `list_channels` input.
 * Lists all channels declared in the current workflow.
 * No arguments — channels are derived from the workflow run context.
 */
export const ListChannelsSchema = z.object({});

export type ListChannelsInput = z.infer<typeof ListChannelsSchema>;

// ---------------------------------------------------------------------------
// list_gates
// ---------------------------------------------------------------------------

/**
 * Schema for `list_gates` input.
 * Lists all gates declared in the current workflow with their current data.
 * No arguments — gates are derived from the workflow run context.
 */
export const ListGatesSchema = z.object({});

export type ListGatesInput = z.infer<typeof ListGatesSchema>;

// ---------------------------------------------------------------------------
// read_gate
// ---------------------------------------------------------------------------

/**
 * Schema for `read_gate` input.
 * Reads the current runtime data for a specific gate from the gate_data table.
 */
export const ReadGateSchema = z.object({
  /** The ID of the gate to read data for. */
  gateId: z.string().min(1).describe('The gate ID to read current data for'),
});

export type ReadGateInput = z.infer<typeof ReadGateSchema>;

// ---------------------------------------------------------------------------
// list_artifacts
// ---------------------------------------------------------------------------

/**
 * Schema for `list_artifacts` input.
 * Lists artifacts for the current workflow run, optionally filtered.
 */
export const ListArtifactsSchema = z.object({
  /** Filter by originating node ID. */
  nodeId: z.string().describe('Filter by node ID').optional(),
  /** Filter by artifact shape from the closed vocabulary (link/commit_set/check/metric/decision/note). */
  type: z
    .string()
    .describe('Filter by artifact shape (e.g. "link", "decision", "note")')
    .optional(),
});

export type ListArtifactsInput = z.infer<typeof ListArtifactsSchema>;

// ---------------------------------------------------------------------------
// restore_node_agent
// ---------------------------------------------------------------------------

/**
 * Schema for `restore_node_agent` input.
 *
 * Self-heal primitive — invoked by a sub-session agent when it detects (or
 * suspects) that node-agent tools are unavailable. The fact that this tool
 * call succeeds is itself proof that node-agent is registered for the
 * current session; the handler additionally re-attaches node-agent on the
 * server side as a belt-and-braces measure and returns the visible MCP
 * server names so the agent can confirm its environment.
 *
 * Use this when:
 *   - A previous `mcp__node-agent__send_message` (or other node-agent tool)
 *     unexpectedly returned "No such tool available".
 *   - You want to verify the node-agent environment before performing a
 *     critical handoff.
 */
export const RestoreNodeAgentSchema = z.object({
  /** Optional human-readable reason for the restore — recorded in logs. */
  reason: z
    .string()
    .describe(
      'Optional human-readable reason for invoking restore (recorded in logs for diagnosis)'
    )
    .optional(),
});

export type RestoreNodeAgentInput = z.infer<typeof RestoreNodeAgentSchema>;

// ---------------------------------------------------------------------------
// publish_task
// ---------------------------------------------------------------------------

/**
 * Schema for `publish_task` input.
 *
 * Transitions a draft task to open status so the runtime's tick loop can
 * pick it up for orchestration. Only valid when the task is in `draft` status.
 */
export const PublishTaskSchema = z.object({
  /** UUID of the task to publish. */
  task_id: z.string().describe('UUID of the draft task to publish (draft → open)'),
});

export type PublishTaskInput = z.infer<typeof PublishTaskSchema>;

// ---------------------------------------------------------------------------
// archive_task
// ---------------------------------------------------------------------------

/**
 * Schema for `archive_task` input.
 *
 * Transitions a task to archived status — the true terminal state.
 * Valid from any status that allows the `archived` transition (see
 * VALID_SPACE_TASK_TRANSITIONS). Archived tasks are excluded from most
 * queries and cannot be reactivated.
 */
export const ArchiveTaskSchema = z.object({
  /** UUID of the task to archive. */
  task_id: z.string().describe('UUID of the task to archive'),
});

export type ArchiveTaskInput = z.infer<typeof ArchiveTaskSchema>;

// ---------------------------------------------------------------------------
// post_review
// ---------------------------------------------------------------------------

/**
 * Schema for `post_review` input.
 *
 * Posts a GitHub PR review (APPROVE / REQUEST_CHANGES / COMMENT) with an
 * optional set of anchored line comments, server-side — no shell required.
 * This is the Reviewer's only way to land a review on GitHub now that it has
 * no Bash tool. Returns the review's `html_url` so the caller can emit the
 * `---REVIEW_POSTED---` block and satisfy the `review-posted-gate`.
 *
 * Own-PR fallback: GitHub rejects APPROVE/REQUEST_CHANGES from the PR author.
 * When that happens the tool automatically retries as a COMMENT review and
 * prepends a `Recommendation: <APPROVE|REQUEST_CHANGES>` line to the body, so
 * the verdict still lands visibly. The caller does not need to detect own-PRs.
 */
export const PostReviewSchema = z.object({
  prUrl: z
    .string()
    .optional()
    .describe(
      "GitHub PR URL to review (e.g. 'https://github.com/owner/repo/pull/123'). " +
        "Omit to review this workflow run's current PR, resolved from gate data / artifacts."
    ),
  event: z
    .enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
    .describe('The review event to post. Use COMMENT for informational notes.'),
  body: z
    .string()
    .min(1)
    .describe(
      'The review body (markdown). Include the standard review header and your verdict. ' +
        'On an own-PR APPROVE/REQUEST_CHANGES the tool retries as COMMENT and prepends a ' +
        '`Recommendation:` line automatically.'
    ),
  commitId: z
    .string()
    .optional()
    .describe(
      'Head commit SHA the review targets. Omit to auto-resolve the PR head (recommended).'
    ),
  comments: z
    .array(
      z.object({
        path: z.string().min(1).describe('Repository-relative file path'),
        line: z.number().int().positive().describe('Line number in the diff to anchor the comment'),
        side: z
          .enum(['LEFT', 'RIGHT'])
          .describe('Which side of the diff the line is on (base=LEFT, head=RIGHT)'),
        body: z.string().min(1).describe('Comment body (markdown)'),
        startLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Start line for a multi-line range (must be on the same side)'),
        startSide: z
          .enum(['LEFT', 'RIGHT'])
          .optional()
          .describe('Side of the start line for a multi-line range'),
      })
    )
    .optional()
    .describe('Anchored line comments posted inline with the review'),
});

export type PostReviewInput = z.infer<typeof PostReviewSchema>;

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

/**
 * All node agent tool schemas keyed by tool name.
 */
export const NODE_AGENT_TOOL_SCHEMAS = {
  list_peers: ListPeersSchema,
  send_message: SendMessageSchema,
  save_artifact: SaveArtifactSchema,
  create_standalone_task: CreateStandaloneTaskSchema,
  list_artifacts: ListArtifactsSchema,
  list_reachable_agents: ListReachableAgentsSchema,
  list_channels: ListChannelsSchema,
  list_gates: ListGatesSchema,
  read_gate: ReadGateSchema,
  subscribe_external_event: SubscribeExternalEventSchema,
  unsubscribe_external_event: UnsubscribeExternalEventSchema,
  subscribe_pr_events: SubscribePrEventsSchema,
  get_external_event: GetExternalEventSchema,
  restore_node_agent: RestoreNodeAgentSchema,
  list_tasks: ListTasksSchema,
  get_task: GetTaskSchema,
  list_audit_entries: ListAuditEntriesSchema,
  publish_task: PublishTaskSchema,
  archive_task: ArchiveTaskSchema,
  post_review: PostReviewSchema,
} as const;

export type NodeAgentToolName = keyof typeof NODE_AGENT_TOOL_SCHEMAS;
