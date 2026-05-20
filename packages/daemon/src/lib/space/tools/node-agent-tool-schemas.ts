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
		.describe('Glob pattern matching event topics (e.g. github/lsm/neokai/pull_request.review_*)'),
	label: z.string().describe('Optional label for diagnostics').optional(),
});

export type SubscribeExternalEventInput = z.infer<typeof SubscribeExternalEventSchema>;

export const UnsubscribeExternalEventSchema = z.object({
	topicPattern: z.string().min(1).describe('The topic pattern to unsubscribe'),
});

export type UnsubscribeExternalEventInput = z.infer<typeof UnsubscribeExternalEventSchema>;

// ---------------------------------------------------------------------------
// save_artifact
// ---------------------------------------------------------------------------

/**
 * Schema for `save_artifact` input.
 *
 * Persists data to the workflow run artifact store. Replaces the old `save` and
 * `write_artifact` tools with a unified interface.
 *
 * Two modes:
 *   - Overwrite mode (default, `append: false`): upsert on `(nodeId, type, key)`.
 *     Writing the same (type, key) replaces the previous value. Use for progress
 *     tracking, current state, or any data with at most one active record.
 *   - Append mode (`append: true`): always inserts a new row. Key is auto-generated
 *     if not provided. Use for audit trails, cycle records, multi-round reviews, etc.
 *
 * `type` is fully generic — no built-in enum. Use any label that makes sense:
 *   'progress', 'result', 'review', 'pr', 'test_result', 'my-custom-type', etc.
 */
export const SaveArtifactSchema = z.object({
	/**
	 * Category tag for organizing artifacts. Fully generic — no built-in enum.
	 * Use whatever labels make sense for your workflow.
	 * Examples: 'progress', 'result', 'review', 'pr', 'test_result', 'commit'
	 */
	type: z
		.string()
		.min(1)
		.describe(
			"Category tag for organizing artifacts. Fully generic — use whatever makes sense. Examples: 'progress', 'result', 'review', 'pr'"
		),
	/**
	 * Unique key within (node, type) for deduplication.
	 * Same (type, key) = overwrite (upsert). Different key = new record.
	 * Defaults to empty string. When `append: true`, key is auto-generated.
	 */
	key: z
		.string()
		.describe(
			"Unique key within (node, type). Same (type, key) = overwrite. Use 'current' for a single live record. Ignored in append mode (key is auto-generated)."
		)
		.default(''),
	/**
	 * Append mode: when true, always inserts a new row regardless of key.
	 * Key is auto-generated to guarantee uniqueness. Use for audit trails
	 * (multi-round reviews, cycle records, progress history).
	 * Default: false (overwrite/upsert mode).
	 */
	append: z
		.boolean()
		.describe(
			'If true, always inserts a new row (append-only). Key is auto-generated. Use for audit trails. Default: false (upsert/overwrite mode).'
		)
		.default(false),
	/** Human-readable summary of the content. */
	summary: z.string().describe('Human-readable summary of the content or work status.').optional(),
	/**
	 * Structured key-value data payload.
	 * Use for machine-readable artifacts: pr_url, commit_sha, test_results, etc.
	 */
	data: z
		.record(z.string(), z.unknown())
		.describe(
			'Structured key-value data payload. Use for machine-readable artifacts: pr_url, commit_sha, test_results, etc.'
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
	custom_agent_id: z
		.string()
		.describe('ID of a custom Space agent to assign this task to')
		.optional(),
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
	/** Filter by artifact type (generic string, e.g. 'progress', 'result', 'review'). */
	type: z
		.string()
		.describe('Filter by artifact type (e.g. "progress", "result", "review")')
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
	restore_node_agent: RestoreNodeAgentSchema,
	list_tasks: ListTasksSchema,
	get_task: GetTaskSchema,
	list_audit_entries: ListAuditEntriesSchema,
	publish_task: PublishTaskSchema,
	archive_task: ArchiveTaskSchema,
} as const;

export type NodeAgentToolName = keyof typeof NODE_AGENT_TOOL_SCHEMAS;
