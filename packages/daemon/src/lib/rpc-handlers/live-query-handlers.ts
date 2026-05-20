/**
 * LiveQuery RPC Handlers
 *
 * Defines the server-side named-query registry for the liveQuery.subscribe /
 * liveQuery.unsubscribe RPC protocol.  Clients send a query name + parameters;
 * the daemon resolves it to a pre-registered SQL template and row mapper.
 * Clients never send raw SQL.
 */

import { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub } from '@neokai/shared';
import { createEventMessage, parseJson, parseJsonOptional } from '@neokai/shared';
import type {
	LiveQuerySubscribeRequest,
	LiveQuerySubscribeResponse,
	LiveQueryUnsubscribeRequest,
	LiveQueryUnsubscribeResponse,
	LiveQuerySnapshotEvent,
	LiveQueryDeltaEvent,
} from '@neokai/shared';
import type { LiveQueryEngine, LiveQueryHandle, QueryDiff } from '../../storage/live-query';
import type { TableChangeScope } from '../../storage/reactive-database';
import { Logger } from '../logger';

// ============================================================================
// Named-query registry types
// ============================================================================

export interface NamedQuery {
	/** Parameterised SQL that will be executed by LiveQueryEngine */
	sql: string;
	/** Number of positional parameters the SQL expects */
	paramCount: number;
	/**
	 * Optional debounce for table-change reevaluation. Use only for expensive
	 * feeds fed by high-frequency writes, where latest-state delivery matters
	 * more than one event per row mutation.
	 */
	debounceMs?: number;
	/**
	 * Optional row transformer applied after every query execution.
	 * Must return a plain object whose keys match the frontend TypeScript types.
	 */
	mapRow?: (row: Record<string, unknown>) => Record<string, unknown>;
	/**
	 * Optional hook to extract metadata from raw query results (before mapRow).
	 * Called once per query evaluation; result is attached to snapshot/delta events.
	 *
	 * The bound query parameters are forwarded as a second argument so handlers
	 * that need to run a sidecar prepared statement (e.g., `spaceTaskMessages.
	 * byTask.compact`'s active-turn aggregation) can reuse the same param values
	 * the live query was subscribed with — they aren't otherwise visible to
	 * `mapResult`.
	 */
	mapResult?: (
		rawRows: Record<string, unknown>[],
		params: ReadonlyArray<unknown>
	) => Record<string, unknown> | undefined;
	/**
	 * Optional scope filter builder. Called once per subscribe RPC with the
	 * subscription's params; returns a `(scope) => boolean` closure that
	 * decides whether a scoped table-change event is relevant to this
	 * particular subscription.
	 *
	 * When the closure returns `false`, re-evaluation is skipped entirely.
	 * When no closure is provided (or the event has no scope), the query is
	 * re-evaluated as usual (backward-compatible fallback).
	 *
	 * @param params  The positional parameters the live query was subscribed with.
	 * @param db      The raw Bun SQLite database for membership lookups.
	 */
	buildScopeFilter?: (
		params: ReadonlyArray<unknown>,
		db: BunDatabase
	) => ((scope: TableChangeScope) => boolean) | undefined;
}

const DEBOUNCE_SDK_MESSAGES_MS = 100;
const DEBOUNCE_SESSION_GROUP_MESSAGES_MS = 150;
const DEBOUNCE_SESSION_LIST_MS = 150;
const DEBOUNCE_SPACE_SESSIONS_MS = 150;
const DEBOUNCE_SPACE_TASK_FEEDS_MS = 250;

// ============================================================================
// Row mappers
// ============================================================================

/**
 * Map canonical task timeline rows into the SessionGroupMessage shape expected by the web client.
 * For SDK rows, inject `_taskMeta` directly into JSON content so TaskConversationRenderer can
 * render role/session context without relying on runtime mirroring.
 */
function mapSessionGroupMessageRow(row: Record<string, unknown>): Record<string, unknown> {
	const sourceType = row.sourceType;
	const groupId = String(row.groupId ?? '');
	const sessionId = typeof row.sessionId === 'string' ? row.sessionId : null;
	const role = String(row.role ?? 'system');
	const messageType = String(row.messageType ?? 'status');
	const createdAt = Number(row.createdAt ?? Date.now());
	const rawId = row.id;
	const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : `row-${createdAt}`;
	const parentToolUseId = typeof row.parentToolUseId === 'string' ? row.parentToolUseId : null;
	const turnUserMessageId =
		typeof row.turnUserMessageId === 'string' ? row.turnUserMessageId : null;

	let content = typeof row.content === 'string' ? row.content : String(row.content ?? '');

	if (sourceType === 'sdk') {
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			// turnId is the user message's own ID — every non-user row inherits the
			// most recent user-row id within its session, so all rows belonging to
			// the same turn share a stable, content-derived turn key. Rows that
			// precede any user message in their session fall back to their own id.
			const turnId = turnUserMessageId ?? String(id);
			const enriched = {
				...parsed,
				_taskMeta: {
					authorRole: role,
					authorSessionId: sessionId ?? '',
					turnId,
				},
			};
			content = JSON.stringify(enriched);
		} catch {
			// Keep original content if parsing fails.
		}
	}

	return {
		id,
		groupId,
		sessionId,
		role,
		messageType,
		content,
		createdAt,
		parentToolUseId,
	};
}

/**
 * Map a raw SQLite row from `spaceTaskMessages.byTask` into a web-friendly
 * message envelope that preserves agent/task attribution.
 */
function parseProjectionRef(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'string' || value.length === 0) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		return parsed;
	} catch {
		return null;
	}
}

function mapActorMessageProjectionRow(row: Record<string, unknown>): Record<string, unknown> {
	const createdAt = Number(row.createdAt ?? Date.now());
	return {
		id: String(row.id ?? `projection-${createdAt}`),
		scope: row.scope === 'workflow_log' ? 'workflow_log' : 'task_timeline',
		eventKind: String(row.eventKind ?? 'system'),
		taskId: typeof row.taskId === 'string' ? row.taskId : null,
		taskTitle: typeof row.taskTitle === 'string' ? row.taskTitle : null,
		workflowRunId: typeof row.workflowRunId === 'string' ? row.workflowRunId : null,
		messageId: typeof row.messageId === 'string' ? row.messageId : null,
		eventRef: typeof row.eventRef === 'string' ? row.eventRef : null,
		from: parseProjectionRef(row.fromActor) ?? { kind: 'system', label: 'System' },
		target: parseProjectionRef(row.targetActor),
		targetResolution: typeof row.targetResolution === 'string' ? row.targetResolution : null,
		deliveryState: typeof row.deliveryState === 'string' ? row.deliveryState : null,
		title: String(row.title ?? 'Event'),
		summary: String(row.summary ?? ''),
		details: typeof row.details === 'string' ? row.details : null,
		severity: typeof row.severity === 'string' ? row.severity : null,
		createdAt,
	};
}

function mapSpaceTaskMessageRow(row: Record<string, unknown>): Record<string, unknown> {
	const sessionId = typeof row.sessionId === 'string' ? row.sessionId : null;
	const role = String(row.role ?? 'system');
	const label = String(row.label ?? 'Agent');
	const kind =
		row.kind === 'github' ? 'github' : row.kind === 'task_agent' ? 'task_agent' : 'node_agent';
	const taskId = String(row.taskId ?? '');
	const taskTitle = String(row.taskTitle ?? '');
	const messageType = String(row.messageType ?? 'status');
	const createdAt = Number(row.createdAt ?? Date.now());
	const rawId = row.id;
	const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : `row-${createdAt}`;
	const parentToolUseId = typeof row.parentToolUseId === 'string' ? row.parentToolUseId : null;
	const turnUserMessageId =
		typeof row.turnUserMessageId === 'string' ? row.turnUserMessageId : null;
	const origin = typeof row.origin === 'string' ? row.origin : null;
	const deliveryState =
		messageType === 'user' ? (row.deliveryState === 'failed' ? 'failed' : 'delivered') : null;
	// Optional backward-compat field from older compact-query variants.
	// Current compact SQL no longer emits this, but keep tolerant parsing so
	// historical rows/tests and alternate query variants remain safe.
	const sessionMessageCount =
		typeof row.sessionMessageCount === 'number' && Number.isFinite(row.sessionMessageCount)
			? Number(row.sessionMessageCount)
			: undefined;
	const turnIndex =
		typeof row.turnIndex === 'number' && Number.isFinite(row.turnIndex)
			? Number(row.turnIndex)
			: undefined;
	const turnHiddenMessageCount =
		typeof row.turnHiddenMessageCount === 'number' && Number.isFinite(row.turnHiddenMessageCount)
			? Number(row.turnHiddenMessageCount)
			: undefined;

	let content = typeof row.content === 'string' ? row.content : String(row.content ?? '');

	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		// turnId = the id of the user-message that started this turn. SQL emits
		// `turnUserMessageId` per row by carrying forward the most recent user-row
		// id within the session via a window function. Rows that precede any
		// user message in their session fall back to their own id, giving every
		// row a stable, content-derived turn key without depending on
		// session-group iteration metadata.
		const turnId = turnUserMessageId ?? String(id);
		content = JSON.stringify({
			...parsed,
			_taskMeta: {
				authorRole: role,
				authorLabel: label,
				authorKind: kind,
				authorSessionId: sessionId ?? '',
				taskId,
				taskTitle,
				turnId,
			},
		});
	} catch {
		// Keep original content when sdk_message is not valid JSON.
	}

	const mapped: Record<string, unknown> = {
		id,
		sessionId,
		kind,
		role,
		label,
		taskId,
		taskTitle,
		messageType,
		content,
		createdAt,
		origin,
		deliveryState,
		parentToolUseId,
	};
	if (sessionMessageCount !== undefined) {
		mapped.sessionMessageCount = sessionMessageCount;
	}
	if (turnIndex !== undefined) {
		mapped.turnIndex = turnIndex;
	}
	if (turnHiddenMessageCount !== undefined) {
		mapped.turnHiddenMessageCount = turnHiddenMessageCount;
	}
	return mapped;
}

// ============================================================================
// SQL definitions
// ============================================================================

const MCP_SERVERS_GLOBAL_SQL = `
SELECT
  id,
  name,
  description,
  source_type  AS sourceType,
  command,
  args,
  env,
  url,
  headers,
  enabled,
  created_at   AS createdAt,
  updated_at   AS updatedAt
FROM app_mcp_servers
ORDER BY name, id ASC
`.trim();

/**
 * Map a raw SQLite row from the `app_mcp_servers` table to the AppMcpServer
 * shape expected by the frontend.
 *
 * JSON blob columns: `args`, `env`, `headers`.
 * Boolean coercion: `enabled` — SQLite stores 0/1; convert to JS boolean.
 * snake_case mapping: `source_type` → `sourceType` (handled via AS alias in SQL).
 */
function mapMcpServerRow(row: Record<string, unknown>): Record<string, unknown> {
	// Mirror the repository's rowToServer logic: omit optional fields entirely when the
	// SQLite column is NULL rather than spreading null into the AppMcpServer object.
	// This keeps the LiveQuery path type-consistent with the RPC handler path.
	return {
		id: row.id,
		name: row.name,
		sourceType: row.sourceType,
		enabled: row.enabled === 1,
		...(row.description != null ? { description: row.description } : {}),
		...(row.command != null ? { command: row.command } : {}),
		...(row.url != null ? { url: row.url } : {}),
		...(row.args != null ? { args: JSON.parse(row.args as string) as string[] } : {}),
		...(row.env != null ? { env: JSON.parse(row.env as string) as Record<string, string> } : {}),
		...(row.headers != null
			? { headers: JSON.parse(row.headers as string) as Record<string, string> }
			: {}),
		...(row.createdAt != null ? { createdAt: row.createdAt } : {}),
		...(row.updatedAt != null ? { updatedAt: row.updatedAt } : {}),
	};
}

const SKILLS_LIST_SQL = `
SELECT
  id,
  name,
  display_name        AS displayName,
  description,
  source_type         AS sourceType,
  config,
  enabled,
  built_in            AS builtIn,
  validation_status   AS validationStatus,
  created_at          AS createdAt
FROM skills
ORDER BY built_in DESC, created_at ASC, id ASC
`.trim();

/**
 * Map a raw SQLite row from the `skills` table to the AppSkill shape expected
 * by the frontend.
 *
 * JSON blob column: `config` — parsed to JS object; omitted when NULL.
 * Boolean coercion: `enabled`, `builtIn` — SQLite stores 0/1; convert to JS boolean.
 */
function mapSkillRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		id: row.id,
		name: row.name,
		displayName: row.displayName,
		description: row.description,
		sourceType: row.sourceType,
		...(row.config != null ? { config: JSON.parse(row.config as string) as unknown } : {}),
		enabled: row.enabled === 1,
		builtIn: row.builtIn === 1,
		validationStatus: row.validationStatus,
		...(row.createdAt != null ? { createdAt: row.createdAt } : {}),
	};
}

/**
 * SQL for `mcpEnablement.bySpace`. Returns a row per registry entry, with the
 * per-space override (if any) applied. Columns match SpaceMcpEntry so the
 * frontend can use the LiveQuery result without a separate RPC roundtrip.
 *
 * `overridden` is 1 when the entry has an explicit `mcp_enablement` row for
 * this (space, server) pair, else 0. `enabled` is the effective state:
 * override if present, else the registry's global `enabled` flag.
 */
const MCP_ENABLEMENT_BY_SPACE_SQL = `
SELECT
  ams.id                                                       AS serverId,
  ams.name                                                     AS name,
  ams.description                                              AS description,
  ams.source_type                                              AS sourceType,
  ams.source                                                   AS source,
  ams.source_path                                              AS sourcePath,
  ams.enabled                                                  AS globallyEnabled,
  CASE WHEN me.enabled IS NOT NULL THEN 1 ELSE 0 END           AS overridden,
  COALESCE(me.enabled, ams.enabled)                            AS enabled
FROM app_mcp_servers ams
LEFT JOIN mcp_enablement me
  ON me.server_id = ams.id
 AND me.scope_type = 'space'
 AND me.scope_id = ?
ORDER BY ams.source ASC, ams.created_at IS NULL, ams.created_at ASC, ams.id ASC
`.trim();

function mapMcpEnablementBySpaceRow(row: Record<string, unknown>): Record<string, unknown> {
	const sourceRaw = typeof row.source === 'string' ? row.source : null;
	const normalisedSource =
		sourceRaw === 'builtin' || sourceRaw === 'imported' || sourceRaw === 'user'
			? sourceRaw
			: 'user';
	const out: Record<string, unknown> = {
		serverId: row.serverId,
		name: row.name,
		sourceType: row.sourceType,
		source: normalisedSource,
		globallyEnabled: row.globallyEnabled === 1,
		overridden: row.overridden === 1,
		enabled: row.enabled === 1,
	};
	if (row.description != null) out.description = row.description;
	if (row.sourcePath != null) out.sourcePath = row.sourcePath;
	return out;
}

function formatTaskActivityLabel(value: unknown, fallback: string): string {
	if (typeof value !== 'string' || value.trim() === '') return fallback;
	return value
		.split(/[_-\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function mapSpaceTaskActivityRow(row: Record<string, unknown>): Record<string, unknown> {
	const kind =
		row.kind === 'github' ? 'github' : row.kind === 'task_agent' ? 'task_agent' : 'node_agent';
	const rawRole =
		typeof row.role === 'string' ? row.role : kind === 'task_agent' ? 'task-agent' : kind;
	const rawLabel = typeof row.label === 'string' ? row.label : rawRole;

	return {
		...row,
		kind,
		nodeExecution:
			kind === 'node_agent'
				? {
						nodeExecutionId: row.nodeExecutionId,
						nodeId: row.workflowNodeId,
						agentName: row.agentName,
						status: row.executionStatus,
						result: row.executionResult ?? null,
					}
				: null,
		label:
			kind === 'task_agent'
				? 'Task Agent'
				: kind === 'github'
					? 'GitHub'
					: formatTaskActivityLabel(rawLabel, 'Agent'),
		role: rawRole,
		messageCount: Number(row.messageCount ?? 0),
	};
}

/**
 * Node executions by workflow run — returns all node execution records
 * for a given workflow run, ordered by creation time ascending.
 *
 * Used by the frontend to show per-node execution status in the workflow canvas.
 */
const NODE_EXECUTIONS_BY_RUN_SQL = `
SELECT
  id,
  workflow_run_id  AS workflowRunId,
  workflow_node_id AS workflowNodeId,
  agent_name       AS agentName,
  agent_id         AS agentId,
  agent_session_id AS agentSessionId,
  status,
  result,
  created_at       AS createdAt,
  started_at       AS startedAt,
  completed_at     AS completedAt,
  updated_at       AS updatedAt
FROM node_executions
WHERE workflow_run_id = ?
ORDER BY created_at ASC, id ASC
`.trim();

const WORKFLOW_RUN_ARTIFACTS_BY_RUN_SQL = `
SELECT
  id,
  run_id        AS runId,
  node_id       AS nodeId,
  artifact_type AS artifactType,
  artifact_key  AS artifactKey,
  data,
  created_at    AS createdAt,
  updated_at    AS updatedAt
FROM workflow_run_artifacts
WHERE run_id = ?
ORDER BY created_at ASC, id ASC
`.trim();

const ACTOR_MESSAGES_BY_TASK_SQL = `
WITH target_task AS (
  SELECT * FROM space_tasks WHERE id = ?
),
sdk_rows AS (
  SELECT
    'msg:' || sm.id AS id,
    'task_timeline' AS scope,
    CASE
      WHEN sm.message_type = 'user' AND sm.origin = 'human' THEN 'question'
      WHEN sm.message_type = 'user' THEN 'handoff'
      WHEN sm.message_type = 'result' THEN 'status'
      WHEN sm.message_type = 'assistant' THEN 'answer'
      ELSE 'system'
    END AS eventKind,
    tt.id AS taskId,
    tt.title AS taskTitle,
    tt.workflow_run_id AS workflowRunId,
    sm.id AS messageId,
    NULL AS eventRef,
    json_object(
      'kind', CASE WHEN sm.origin = 'human' THEN 'human' WHEN sm.origin = 'system' THEN 'system' ELSE 'worker' END,
      'label', CASE WHEN sm.origin = 'human' THEN 'Human' WHEN sm.origin = 'system' THEN 'System' ELSE COALESCE(sa.name, ne.agent_name, 'Agent') END,
      'role', CASE WHEN sm.origin = 'human' THEN 'human' WHEN sm.origin = 'system' THEN 'system' ELSE COALESCE(ne.agent_name, 'agent') END,
      'sessionId', sm.session_id,
      'nodeExecutionId', ne.id
    ) AS fromActor,
    CASE
      WHEN sm.message_type = 'user' THEN json_object(
        'kind', 'worker',
        'label', COALESCE(sa.name, ne.agent_name, 'Agent'),
        'role', COALESCE(ne.agent_name, 'agent'),
        'sessionId', sm.session_id,
        'nodeExecutionId', ne.id
      )
      ELSE NULL
    END AS targetActor,
    CASE WHEN sm.message_type = 'user' THEN 'inferred' ELSE NULL END AS targetResolution,
    CASE
      WHEN sm.message_type = 'user' AND sm.send_status = 'failed' THEN 'failed'
      WHEN sm.message_type = 'user' THEN 'delivered'
      ELSE NULL
    END AS deliveryState,
    CASE
      WHEN sm.message_type = 'user' AND sm.origin = 'human' THEN 'Question'
      WHEN sm.message_type = 'user' THEN 'Handoff'
      WHEN sm.message_type = 'result' THEN 'Status'
      WHEN sm.message_type = 'assistant' THEN 'Answer'
      ELSE 'System event'
    END AS title,
    CASE
      WHEN sm.message_type = 'result' THEN 'Agent turn finished'
      WHEN sm.message_type = 'assistant' THEN 'Agent response recorded'
      WHEN sm.message_type = 'user' AND sm.origin = 'human' THEN 'Human message delivered'
      WHEN sm.message_type = 'user' THEN 'Actor message delivered'
      ELSE sm.message_type
    END AS summary,
    NULL AS details,
    CASE WHEN sm.message_type = 'user' AND sm.send_status = 'failed' THEN 'error' ELSE 'info' END AS severity,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt
  FROM target_task tt
  JOIN sdk_messages sm ON sm.task_id = tt.id
  LEFT JOIN node_executions ne
    ON ne.workflow_run_id = tt.workflow_run_id
   AND ne.agent_session_id = sm.session_id
  LEFT JOIN space_agents sa ON sa.id = ne.agent_id
  WHERE (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
),
pending_rows AS (
  SELECT
    'delivery:' || pm.id AS id,
    'task_timeline' AS scope,
    'handoff' AS eventKind,
    tt.id AS taskId,
    tt.title AS taskTitle,
    pm.workflow_run_id AS workflowRunId,
    NULL AS messageId,
    pm.id AS eventRef,
    json_object('kind', 'worker', 'label', pm.source_agent_name, 'role', pm.source_agent_name) AS fromActor,
    json_object('kind', CASE WHEN pm.target_kind = 'space_agent' THEN 'agent' ELSE 'worker' END, 'label', pm.target_agent_name, 'role', pm.target_agent_name, 'sessionId', pm.delivered_session_id) AS targetActor,
    CASE WHEN pm.status = 'pending' THEN 'queued' ELSE 'direct' END AS targetResolution,
    CASE WHEN pm.status = 'pending' THEN 'queued' ELSE pm.status END AS deliveryState,
    CASE WHEN pm.status = 'pending' THEN 'Queued delivery' WHEN pm.status = 'delivered' THEN 'Delivered message' WHEN pm.status = 'expired' THEN 'Expired delivery' ELSE 'Failed delivery' END AS title,
    pm.message AS summary,
    pm.last_error AS details,
    CASE WHEN pm.status IN ('failed', 'expired') THEN 'error' WHEN pm.status = 'delivered' THEN 'success' ELSE 'info' END AS severity,
    pm.created_at AS createdAt
  FROM target_task tt
  JOIN pending_agent_messages pm ON pm.task_id = tt.id
),
github_rows AS (
  SELECT
    'github:' || ge.id AS id,
    'task_timeline' AS scope,
    'github' AS eventKind,
    tt.id AS taskId,
    tt.title AS taskTitle,
    tt.workflow_run_id AS workflowRunId,
    NULL AS messageId,
    ge.id AS eventRef,
    json_object('kind', 'github', 'label', ge.actor, 'role', ge.actor_type) AS fromActor,
    json_object('kind', 'system', 'label', 'Task timeline', 'role', 'task') AS targetActor,
    'external' AS targetResolution,
    'delivered' AS deliveryState,
    'GitHub activity' AS title,
    ge.summary AS summary,
    ge.external_url AS details,
    CASE WHEN ge.state = 'failed' THEN 'error' ELSE 'info' END AS severity,
    ge.occurred_at AS createdAt
  FROM target_task tt
  JOIN space_github_events ge ON ge.task_id = tt.id
  WHERE ge.state IN ('routed', 'delivered', 'failed')
)
SELECT * FROM sdk_rows
UNION ALL SELECT * FROM pending_rows
UNION ALL SELECT * FROM github_rows
ORDER BY createdAt ASC, id ASC
`.trim();

const ACTOR_MESSAGES_BY_WORKFLOW_RUN_SQL = `
WITH node_rows AS (
  SELECT
    'node:' || ne.id || ':' || ne.status AS id,
    'workflow_log' AS scope,
    CASE WHEN ne.status = 'in_progress' THEN 'handoff' ELSE 'status' END AS eventKind,
    st.id AS taskId,
    st.title AS taskTitle,
    ne.workflow_run_id AS workflowRunId,
    NULL AS messageId,
    ne.id AS eventRef,
    json_object('kind', 'system', 'label', 'Workflow runtime', 'role', 'runtime') AS fromActor,
    json_object('kind', 'worker', 'label', COALESCE(sa.name, ne.agent_name), 'role', ne.agent_name, 'sessionId', ne.agent_session_id, 'nodeExecutionId', ne.id) AS targetActor,
    'system' AS targetResolution,
    NULL AS deliveryState,
    CASE WHEN ne.status = 'in_progress' THEN 'Node handoff' WHEN ne.status = 'done' THEN 'Node completed' ELSE 'Node status' END AS title,
    ne.agent_name || ' is ' || ne.status AS summary,
    ne.result AS details,
    CASE WHEN ne.status IN ('blocked', 'cancelled') THEN 'warning' WHEN ne.status = 'done' THEN 'success' ELSE 'info' END AS severity,
    COALESCE(ne.updated_at, ne.created_at) AS createdAt
  FROM node_executions ne
  LEFT JOIN space_agents sa ON sa.id = ne.agent_id
  LEFT JOIN space_tasks st ON st.workflow_run_id = ne.workflow_run_id
  WHERE ne.workflow_run_id = ?
),
delivery_rows AS (
  SELECT
    'delivery:' || pm.id AS id,
    'workflow_log' AS scope,
    CASE WHEN pm.attempts > 0 AND pm.status = 'pending' THEN 'retry' ELSE 'handoff' END AS eventKind,
    pm.task_id AS taskId,
    st.title AS taskTitle,
    pm.workflow_run_id AS workflowRunId,
    NULL AS messageId,
    pm.id AS eventRef,
    json_object('kind', 'worker', 'label', pm.source_agent_name, 'role', pm.source_agent_name) AS fromActor,
    json_object('kind', CASE WHEN pm.target_kind = 'space_agent' THEN 'agent' ELSE 'worker' END, 'label', pm.target_agent_name, 'role', pm.target_agent_name, 'sessionId', pm.delivered_session_id) AS targetActor,
    CASE WHEN pm.status = 'pending' THEN 'queued' ELSE 'direct' END AS targetResolution,
    CASE WHEN pm.status = 'pending' THEN 'queued' ELSE pm.status END AS deliveryState,
    CASE WHEN pm.status = 'pending' THEN 'Queued delivery' WHEN pm.status = 'delivered' THEN 'Delivered message' WHEN pm.status = 'expired' THEN 'Expired delivery' ELSE 'Failed delivery' END AS title,
    pm.message AS summary,
    pm.last_error AS details,
    CASE WHEN pm.status IN ('failed', 'expired') THEN 'error' WHEN pm.status = 'delivered' THEN 'success' ELSE 'info' END AS severity,
    COALESCE(pm.last_attempt_at, pm.delivered_at, pm.created_at) AS createdAt
  FROM pending_agent_messages pm
  LEFT JOIN space_tasks st ON st.id = pm.task_id
  WHERE pm.workflow_run_id = ?
),
artifact_rows AS (
  SELECT
    'artifact:' || wra.id AS id,
    'workflow_log' AS scope,
    'artifact' AS eventKind,
    st.id AS taskId,
    st.title AS taskTitle,
    wra.run_id AS workflowRunId,
    NULL AS messageId,
    wra.id AS eventRef,
    json_object('kind', 'worker', 'label', wra.node_id, 'role', wra.node_id) AS fromActor,
    json_object('kind', 'system', 'label', 'Artifact store', 'role', 'artifact') AS targetActor,
    'system' AS targetResolution,
    'delivered' AS deliveryState,
    'Artifact saved' AS title,
    wra.artifact_type || CASE WHEN wra.artifact_key = '' THEN '' ELSE ':' || wra.artifact_key END AS summary,
    wra.data AS details,
    'success' AS severity,
    wra.created_at AS createdAt
  FROM workflow_run_artifacts wra
  LEFT JOIN space_tasks st ON st.workflow_run_id = wra.run_id
  WHERE wra.run_id = ?
)
SELECT * FROM node_rows
UNION ALL SELECT * FROM delivery_rows
UNION ALL SELECT * FROM artifact_rows
ORDER BY createdAt ASC, id ASC
`.trim();

function mapArtifactRow(row: Record<string, unknown>): Record<string, unknown> {
	const raw = row.data as string | null;
	let data: Record<string, unknown> = {};
	if (raw) {
		try {
			data = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			log.warn(`Corrupted artifact JSON for id=${row.id} — returning empty data`);
		}
	}
	return { ...row, data };
}

/**
 * Canonical task timeline query (no projection table):
 * - SDK messages are read directly from sdk_messages joined through session_group_members.
 * - Group/system events are read from task_group_events.
 *
 * A single groupId parameter is threaded via `target_group` CTE and consumed by both branches.
 */
const SESSION_GROUP_MESSAGES_BY_GROUP_SQL = `
WITH target_group AS (
  SELECT id
  FROM session_groups
  WHERE id = ?
),
sdk_rows_raw AS (
  SELECT
    sm.id                         AS id,
    tg.id                         AS groupId,
    sm.session_id                 AS sessionId,
    CASE
      WHEN gm.role = 'leader' THEN 'leader'
      WHEN gm.role = 'worker' AND sm.session_id LIKE 'general:%' THEN 'general'
      WHEN gm.role = 'worker' AND sm.session_id LIKE 'planner:%' THEN 'planner'
      WHEN gm.role = 'worker' AND sm.session_id LIKE 'coder:%' THEN 'coder'
      WHEN gm.role = 'worker' THEN 'coder'
      ELSE gm.role
    END                           AS role,
    sm.message_type               AS messageType,
    sm.sdk_message                AS content,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt,
    sm.parent_tool_use_id AS parentToolUseId
  FROM target_group tg
  JOIN session_group_members gm ON gm.group_id = tg.id
  JOIN sdk_messages sm ON sm.session_id = gm.session_id
  WHERE (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
),
sdk_rows_with_pos AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (
      PARTITION BY r.sessionId
      ORDER BY r.createdAt ASC, r.id ASC
    ) AS rowPos
  FROM sdk_rows_raw r
),
user_row_starts AS (
  SELECT
    sessionId,
    rowPos AS userRowPos,
    id AS userMessageId
  FROM sdk_rows_with_pos
  WHERE messageType = 'user'
),
sdk_rows AS (
  SELECT
    p.id,
    p.groupId,
    p.sessionId,
    p.role,
    p.messageType,
    p.content,
    p.createdAt,
    p.parentToolUseId,
    (
      SELECT urs.userMessageId
      FROM user_row_starts urs
      WHERE urs.sessionId = p.sessionId
        AND urs.userRowPos <= p.rowPos
      ORDER BY urs.userRowPos DESC
      LIMIT 1
    ) AS turnUserMessageId
  FROM sdk_rows_with_pos p
)
SELECT
  'sdk' AS sourceType,
  id,
  groupId,
  sessionId,
  role,
  messageType,
  content,
  createdAt,
  turnUserMessageId,
  parentToolUseId
FROM sdk_rows
UNION ALL
SELECT
  'event'                       AS sourceType,
  'event:' || e.id              AS id,
  tg.id                         AS groupId,
  NULL                          AS sessionId,
  'system'                      AS role,
  CASE
    WHEN e.kind = 'leader_summary' THEN 'leader_summary'
    WHEN e.kind = 'rate_limited' THEN 'rate_limited'
    WHEN e.kind = 'model_fallback' THEN 'model_fallback'
    ELSE 'status'
  END                           AS messageType,
  CASE
    WHEN e.kind IN ('rate_limited', 'model_fallback') THEN COALESCE(e.payload_json, e.kind)
    ELSE COALESCE(json_extract(e.payload_json, '$.text'), e.kind)
  END                           AS content,
  e.created_at                  AS createdAt,
  NULL                          AS turnUserMessageId,
  NULL                          AS parentToolUseId
FROM target_group tg
JOIN task_group_events e ON e.group_id = tg.id
ORDER BY createdAt ASC, id ASC
`.trim();

const SPACE_TASK_ACTIVITY_BY_TASK_SQL = `
WITH target_task AS (
  SELECT *
  FROM space_tasks
  WHERE id = ?
),
-- Derive the contributing-session set from the source-of-truth tables —
-- task_agent_session_id on space_tasks and agent_session_id on
-- node_executions for the task's workflow run — so sessions that exist
-- but haven't emitted a message yet (queued / early-processing) are
-- still surfaced in the activity feed. Sourcing from sdk_messages.task_id
-- alone would hide them until the first SDK row is persisted.
contributing_sessions AS (
  SELECT
    tt.task_agent_session_id AS session_id,
    tt.id AS task_id,
    tt.title AS task_title,
    tt.status AS task_status
  FROM target_task tt
  JOIN sessions s ON s.id = tt.task_agent_session_id
  WHERE tt.task_agent_session_id IS NOT NULL
    AND s.type = 'space_task_agent'
  UNION
  SELECT
    ne.agent_session_id AS session_id,
    tt.id AS task_id,
    tt.title AS task_title,
    tt.status AS task_status
  FROM target_task tt
  JOIN node_executions ne
    ON tt.workflow_run_id IS NOT NULL
   AND ne.workflow_run_id = tt.workflow_run_id
   AND ne.agent_session_id IS NOT NULL
),
-- Pick the most relevant node_execution per (task, session): prefer
-- in-progress, then most recently updated. Used to resolve agent_name /
-- workflow_node_id / execution_status / label below. Only applies to
-- node-agent sessions; the Task Agent session has no row here.
session_node_exec AS (
  SELECT cs.task_id, cs.session_id, ne.id AS node_execution_id,
         ne.workflow_node_id, ne.agent_id, ne.agent_name,
         ne.status AS execution_status, ne.result AS execution_result,
         ne.updated_at AS execution_updated_at,
         ROW_NUMBER() OVER (
           PARTITION BY cs.task_id, cs.session_id
           ORDER BY
             CASE ne.status
               WHEN 'in_progress' THEN 0
               WHEN 'waiting_rebind' THEN 1
               WHEN 'blocked' THEN 2
               WHEN 'pending' THEN 3
               ELSE 4
             END,
             ne.updated_at DESC,
             ne.created_at DESC,
             ne.id DESC
         ) AS rn
  FROM contributing_sessions cs
  JOIN target_task tt ON tt.id = cs.task_id
  JOIN node_executions ne
    ON ne.workflow_run_id = tt.workflow_run_id
   AND ne.agent_session_id = cs.session_id
),
all_sessions AS (
  SELECT
    cs.session_id AS session_id,
    -- Task Agent vs node-agent classification: derived from sessions.type.
    -- Using sessions.type (a stable property of the session row) rather than
    -- comparing to the current task_agent_session_id ensures historical rows
    -- stay correctly attributed if the orchestration pointer is rotated or
    -- cleared (rehydrate self-heal, session replacement).
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'task_agent'
      ELSE 'node_agent'
    END AS kind,
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'Task Agent'
      ELSE COALESCE(sa.name, sne.agent_name, 'agent')
    END AS label,
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'task-agent'
      -- Fall back to a stable string when no node_executions row is
      -- available (e.g. workflow-run cleanup detached the row after the
      -- session emitted messages) — otherwise the mapper retypes the
      -- author as 'system', misattributing genuine node-agent activity.
      ELSE COALESCE(sne.agent_name, 'agent')
    END AS role,
    cs.task_id,
    cs.task_title,
    cs.task_status,
    sne.node_execution_id,
    sne.workflow_node_id,
    sne.agent_name,
    sne.execution_status,
    sne.execution_result,
    sne.execution_updated_at
  FROM contributing_sessions cs
  LEFT JOIN sessions s_kind ON s_kind.id = cs.session_id
  LEFT JOIN session_node_exec sne
    ON sne.task_id = cs.task_id
   AND sne.session_id = cs.session_id
   AND sne.rn = 1
  LEFT JOIN space_agents sa ON sa.id = sne.agent_id
),
-- Deduplicate session IDs to prevent fan-out in message_stats JOIN
unique_session_ids AS (
  SELECT DISTINCT session_id FROM all_sessions
),
-- Per-session message count + lastMessageAt. Phrased as two correlated scalar
-- subqueries over unique_session_ids so SQLite picks the (session_id, ...)
-- covering indexes per-session-lookup instead of full-scanning
-- idx_sdk_messages_session_id to satisfy a GROUP BY join. On the live
-- daemon DB the GROUP BY form was ~280 ms (full index scan of 1.68M rows);
-- the per-session lookup form is sub-millisecond.
message_stats AS (
  SELECT
    usi.session_id AS session_id,
    (
      SELECT COUNT(*)
      FROM sdk_messages sm
      WHERE sm.session_id = usi.session_id
    ) AS messageCount,
    (
      SELECT MAX(CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER))
      FROM sdk_messages sm
      WHERE sm.session_id = usi.session_id
    ) AS lastMessageAt
  FROM unique_session_ids usi
)
SELECT
  ase.session_id AS id,
  ase.session_id AS sessionId,
  ase.kind AS kind,
  ase.label AS label,
  ase.role AS role,
  CASE
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'done' THEN 'completed'
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'cancelled' THEN 'interrupted'
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'blocked' THEN 'failed'
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'pending' THEN 'queued'
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'in_progress' THEN 'active'
    WHEN ase.task_status = 'done' THEN 'completed'
    WHEN ase.task_status = 'cancelled' THEN 'interrupted'
    WHEN ase.task_status = 'blocked' THEN 'failed'
    WHEN json_extract(s.processing_state, '$.status') = 'processing' THEN 'active'
    WHEN json_extract(s.processing_state, '$.status') = 'queued' THEN 'queued'
    WHEN json_extract(s.processing_state, '$.status') = 'waiting_for_input' THEN 'waiting_for_input'
    WHEN json_extract(s.processing_state, '$.status') = 'rate_limit_cooldown' THEN 'cooldown'
    WHEN json_extract(s.processing_state, '$.status') = 'interrupted' THEN 'interrupted'
    WHEN ase.task_status = 'open' THEN 'queued'
    ELSE 'idle'
  END AS state,
  json_extract(s.processing_state, '$.status') AS processingStatus,
  json_extract(s.processing_state, '$.phase') AS processingPhase,
  COALESCE(ms.messageCount, 0) AS messageCount,
  ase.task_id AS taskId,
  ase.task_title AS taskTitle,
  ase.task_status AS taskStatus,
  ase.node_execution_id AS nodeExecutionId,
  ase.workflow_node_id AS workflowNodeId,
  ase.agent_name AS agentName,
  ase.execution_result AS executionResult,
  ase.task_id AS currentStep,
  NULL AS error,
  NULL AS completionSummary,
  CAST(
    MAX(
      COALESCE(st.updated_at, 0),
      COALESCE(ase.execution_updated_at, 0),
      COALESCE(CAST((julianday(s.last_active_at) - 2440587.5) * 86400000 AS INTEGER), 0)
    ) AS INTEGER
  ) AS updatedAt,
  ms.lastMessageAt AS lastMessageAt
FROM all_sessions ase
LEFT JOIN sessions s ON s.id = ase.session_id
LEFT JOIN space_tasks st ON st.id = ase.task_id
LEFT JOIN message_stats ms ON ms.session_id = ase.session_id
ORDER BY
  CASE WHEN ase.task_id = (SELECT id FROM target_task) THEN 0 ELSE 1 END,
  CASE WHEN ase.kind = 'task_agent' THEN 0 ELSE 1 END,
  updatedAt DESC,
  st.created_at ASC,
  ase.task_id ASC,
  st.id ASC
`.trim();

/**
 * Shared CTE block for `spaceTaskMessages.byTask*` queries.
 *
 * Produces a `joined` row set — one row per (session, sdk_message) pair — that
 * the variant queries then either emit as-is (full) or slice with window
 * functions (compact).
 *
 * The final variant must append its own `SELECT ... FROM ranked|joined ORDER BY`.
 */
const SPACE_TASK_MESSAGES_BASE_CTE = `
WITH target_task AS (
  SELECT *
  FROM space_tasks
  WHERE id = ?
),
github_events AS (
  SELECT
    ge.id AS id,
    NULL AS sessionId,
    'github' AS kind,
    'github' AS role,
    'GitHub' AS label,
    NULL AS nodeExecutionId,
    tt.id AS taskId,
    tt.title AS taskTitle,
    'github_pr_activity' AS messageType,
    json_object(
      'type', 'user',
      'uuid', ge.id,
      'message', json_object(
        'role', 'user',
        'content', json_array(json_object('type', 'text', 'text', '[GitHub] ' || ge.summary || char(10) || ge.external_url))
      )
    ) AS content,
    'system' AS origin,
    'delivered' AS deliveryState,
    ge.occurred_at AS createdAt,
    NULL AS parentToolUseId,
    1 AS isRenderable,
    0 AS isTerminal,
    NULL AS turnUserMessageId
  FROM target_task tt
  JOIN space_github_events ge ON ge.task_id = tt.id
  WHERE ge.state IN ('routed', 'delivered')
),
-- Pick the most relevant node_execution per (task, session) for label /
-- node_execution_id derivation. Same precedence the activity query uses:
-- prefer in-progress, then most-recent. Only relevant for non Task Agent
-- sessions (the Task Agent has no node_executions row).
session_node_exec AS (
  SELECT tt.id AS task_id, ne.agent_session_id AS session_id, ne.id AS node_execution_id,
         ne.agent_id, ne.agent_name,
         ROW_NUMBER() OVER (
           PARTITION BY tt.id, ne.agent_session_id
           ORDER BY
             CASE ne.status
               WHEN 'in_progress' THEN 0
               WHEN 'waiting_rebind' THEN 1
               WHEN 'blocked' THEN 2
               WHEN 'pending' THEN 3
               ELSE 4
             END,
             ne.updated_at DESC,
             ne.created_at DESC,
             ne.id DESC
         ) AS rn
  FROM target_task tt
  JOIN node_executions ne
    ON ne.workflow_run_id = tt.workflow_run_id
   AND ne.agent_session_id IS NOT NULL
),
sdk_rows_raw AS (
  SELECT
    sm.id AS id,
    sm.session_id AS sessionId,
    -- Task Agent vs node-agent classification — derived from sessions.type
    -- (a stable property of the session row), not from the task's current
    -- task_agent_session_id pointer. Pointer rotation/clearing must not
    -- retype historical rows.
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'task_agent'
      ELSE 'node_agent'
    END AS kind,
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'task-agent'
      -- Fall back to a stable string when no node_executions row is
      -- available — otherwise the mapper retypes the author as 'system',
      -- misattributing genuine node-agent messages.
      ELSE COALESCE(sne.agent_name, 'agent')
    END AS role,
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'Task Agent'
      ELSE COALESCE(sa.name, sne.agent_name, 'agent')
    END AS label,
    sne.node_execution_id AS nodeExecutionId,
    tt.id AS taskId,
    tt.title AS taskTitle,
    sm.message_type AS messageType,
    sm.sdk_message AS content,
    sm.origin AS origin,
    CASE WHEN sm.message_type = 'user' AND sm.send_status = 'failed' THEN 'failed' WHEN sm.message_type = 'user' THEN 'delivered' ELSE NULL END AS deliveryState,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt,
    sm.parent_tool_use_id AS parentToolUseId,
    sm.is_renderable AS isRenderable,
    sm.is_terminal AS isTerminal
  FROM target_task tt
  JOIN sdk_messages sm ON sm.task_id = tt.id
  LEFT JOIN sessions s_kind ON s_kind.id = sm.session_id
  LEFT JOIN session_node_exec sne
    ON sne.task_id = tt.id
   AND sne.session_id = sm.session_id
   AND sne.rn = 1
  LEFT JOIN space_agents sa ON sa.id = sne.agent_id
  WHERE (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
),
sdk_rows_numbered AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (
      PARTITION BY r.sessionId
      ORDER BY r.createdAt ASC, r.id ASC
    ) AS rowPos
  FROM sdk_rows_raw r
),
sdk_rows_with_pos AS (
  -- Mark this row's own rowPos as the carry-forward sentinel when it's a
  -- user row; otherwise NULL. Combined with the MAX() window below this
  -- lets us forward-fill the latest user-row position per session without
  -- a per-row correlated subquery or a second ROW_NUMBER() pass.
  SELECT
    n.*,
    CASE WHEN n.messageType = 'user' THEN n.rowPos ELSE NULL END AS thisUserRowPos
  FROM sdk_rows_numbered n
),
-- Forward-fill the latest user-row position seen in each session up to and
-- including the current row. SQLite ignores NULLs in MAX(), so this carries
-- the most recent user thisUserRowPos through subsequent rows.
sdk_rows_with_turn AS (
  SELECT
    p.*,
    MAX(p.thisUserRowPos) OVER (
      PARTITION BY p.sessionId
      ORDER BY p.rowPos
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS turnUserRowPos
  FROM sdk_rows_with_pos p
),
user_row_starts AS (
  -- For each user row, capture (sessionId, rowPos) and its own id. The
  -- per-row carry-forward is computed in sdk_rows_with_turn; this lookup
  -- maps that rowPos back to the user message id with a single join.
  SELECT
    sessionId,
    rowPos AS userRowPos,
    id AS userMessageId
  FROM sdk_rows_with_pos
  WHERE messageType = 'user'
),
sdk_rows AS (
  SELECT
    t.id,
    t.sessionId,
    t.kind,
    t.role,
    t.label,
    t.nodeExecutionId,
    t.taskId,
    t.taskTitle,
    t.messageType,
    t.content,
    t.origin,
    t.deliveryState,
    t.createdAt,
    t.parentToolUseId,
    t.isRenderable,
    t.isTerminal,
    urs.userMessageId AS turnUserMessageId
  FROM sdk_rows_with_turn t
  LEFT JOIN user_row_starts urs
    ON urs.sessionId = t.sessionId
   AND urs.userRowPos = t.turnUserRowPos
),
joined AS (
  SELECT * FROM github_events
  UNION ALL
  SELECT
    id,
    sessionId,
    kind,
    role,
    label,
    nodeExecutionId,
    taskId,
    taskTitle,
    messageType,
    content,
    origin,
    deliveryState,
    createdAt,
    parentToolUseId,
    isRenderable,
    isTerminal,
    turnUserMessageId
  FROM sdk_rows
)
`.trim();

/**
 * Legacy/full variant — emits every joined row. Used by the verbose renderer
 * and as a fallback when a caller genuinely needs the full history.
 */
const SPACE_TASK_MESSAGES_BY_TASK_SQL = `
${SPACE_TASK_MESSAGES_BASE_CTE}
SELECT
  id,
  sessionId,
  kind,
  role,
  label,
  nodeExecutionId,
  taskId,
  taskTitle,
  messageType,
  content,
  origin,
  deliveryState,
  createdAt,
  turnUserMessageId,
  parentToolUseId
FROM joined
ORDER BY createdAt ASC, id ASC
`.trim();

/** Maximum non-terminal rows to keep per (session, turn) in compact mode. */
export const SPACE_TASK_MESSAGES_COMPACT_NON_TERMINAL_PER_TURN_LIMIT = 5;

/**
 * Compact variant — server-side turn compaction for task threads.
 *
 * Turn model (per session):
 *   - A turn is rows between terminal result messages.
 *   - Turn 1 starts at the first row in the session.
 *   - A terminal row (`messageType = 'result'`) closes the current turn and
 *     belongs to that turn.
 *
 * Visibility:
 *   - Keep ALL terminal rows.
 *   - Keep ALL `system` rows (init / compact_boundary). These carry per-exec
 *     metadata (model, cwd, tools, mcp servers…) that the UI surfaces as
 *     dropdowns or banner cards; they're rare (≤2 per session) so passing
 *     them through unconditionally is cheap, and dropping them on long turns
 *     would silently break the affordance.
 *   - Keep only the last N renderable non-terminal rows per session-turn.
 *   - Rows that are known to render as `null` in compact UI (currently
 *     `user` messages whose content is tool_result blocks) are excluded from
 *     the non-terminal cap and omitted from compact payloads.
 *   - Return rows globally ordered by `(createdAt ASC, id ASC)`.
 */
const SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL = `
${SPACE_TASK_MESSAGES_BASE_CTE},
session_turns AS (
  SELECT
    j.*,
    j.isTerminal AS isTerminalLocal,
    j.isRenderable AS isRenderableLocal,
    COALESCE(
      SUM(j.isTerminal) OVER (
        PARTITION BY j.sessionId
        ORDER BY j.createdAt ASC, j.id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) + 1 AS turnIndex
  FROM joined j
),
ranked AS (
  SELECT
    st.*,
    CASE
      WHEN st.isTerminalLocal = 0 AND st.isRenderableLocal = 1 THEN ROW_NUMBER() OVER (
        PARTITION BY st.sessionId, st.turnIndex, st.isTerminalLocal, st.isRenderableLocal
        ORDER BY st.createdAt DESC, st.id DESC
      )
      ELSE NULL
    END AS nonTerminalRankDesc,
    CASE
      WHEN st.isTerminalLocal = 0 AND st.isRenderableLocal = 1 AND st.messageType = 'user' THEN ROW_NUMBER() OVER (
        PARTITION BY st.sessionId, st.turnIndex, st.isTerminalLocal, st.isRenderableLocal, st.messageType
        ORDER BY st.createdAt ASC, st.id ASC
      )
      ELSE NULL
    END AS userRowRankAsc
  FROM session_turns st
),
scored AS (
  SELECT
    r.*,
    CASE
      WHEN r.isTerminalLocal = 0 AND r.isRenderableLocal = 1 AND r.nonTerminalRankDesc <= ${SPACE_TASK_MESSAGES_COMPACT_NON_TERMINAL_PER_TURN_LIMIT}
        THEN 1
      ELSE 0
    END AS isTailVisible,
    CASE
      WHEN r.isTerminalLocal = 0 AND r.isRenderableLocal = 1 AND r.messageType = 'user' AND r.userRowRankAsc = 1
        THEN 1
      ELSE 0
    END AS isInitialUserVisible,
    -- System rows (init / compact_boundary) are sidecar metadata, not real
    -- messages — exclude them from both the total and visible counts so the
    -- "N hidden" badge reflects user/assistant turns only.
    SUM(CASE WHEN r.isTerminalLocal = 0 AND r.isRenderableLocal = 1 AND r.messageType != 'system' THEN 1 ELSE 0 END) OVER (
      PARTITION BY r.sessionId, r.turnIndex
    ) AS totalRenderableNonTerminalInTurn,
    SUM(
      CASE
        WHEN r.isTerminalLocal = 0 AND r.isRenderableLocal = 1 AND r.messageType != 'system'
          AND (
            (r.nonTerminalRankDesc <= ${SPACE_TASK_MESSAGES_COMPACT_NON_TERMINAL_PER_TURN_LIMIT})
            OR (r.messageType = 'user' AND r.userRowRankAsc = 1)
          )
          THEN 1
        ELSE 0
      END
    ) OVER (
      PARTITION BY r.sessionId, r.turnIndex
    ) AS visibleRenderableNonTerminalInTurn
  FROM ranked r
),
selected AS (
  SELECT
    s.*
  FROM scored s
  WHERE
    s.isTerminalLocal = 1
    -- Always include system rows (init / compact_boundary). Without this they
    -- would be dropped on any non-trivial turn (the system:init row sits at
    -- position 1 of every session, far outside the tail of 5). System rows
    -- are inherently rare so passing them through here is cheap and keeps the
    -- per-exec metadata dropdowns working consistently.
    OR s.messageType = 'system'
    OR (
      s.isTerminalLocal = 0
      AND s.isRenderableLocal = 1
      AND (s.isTailVisible = 1 OR s.isInitialUserVisible = 1)
    )
)
SELECT
  id,
  sessionId,
  kind,
  role,
  label,
  nodeExecutionId,
  taskId,
  taskTitle,
  messageType,
  content,
  origin,
  deliveryState,
  createdAt,
  turnIndex,
  CASE
    WHEN totalRenderableNonTerminalInTurn > visibleRenderableNonTerminalInTurn
      THEN totalRenderableNonTerminalInTurn - visibleRenderableNonTerminalInTurn
    ELSE 0
  END AS turnHiddenMessageCount,
  turnUserMessageId,
  parentToolUseId
FROM selected
ORDER BY createdAt ASC, id ASC
`.trim();

/**
 * SQL for the active-turn activity summary that ships alongside the compact
 * feed.
 *
 * Per the design in task #131: the running roster on the Space task view is
 * supposed to summarise the *currently active* turn — every tool_use, text,
 * thinking block, plus user-row activity (real human input + synthetic
 * agent→agent handoffs). The compact feed query keeps only the last 5
 * non-terminal renderable rows per `(session, turn)`, which is right for the
 * feed but too narrow for the roster.
 *
 * Strategy:
 *   1. Reuse the base CTE chain to identify per-session turns (turnIndex is
 *      the cumulative count of `result` rows preceding each row, plus one).
 *   2. For each session, find the highest turnIndex with no terminal row yet —
 *      that's the *active* turn. Closed turns are intentionally excluded.
 *   3. Walk every row of the active turn (NOT the compacted slice). For
 *      assistant rows, explode the SDK content blocks via `json_each` and
 *      classify each one (`tool_use` / `text` / `thinking`). For user rows,
 *      emit a single entry tagged either `__user_message` (human input) or
 *      `__user_replay` (synthetic handoff) per `isReplay`. Empty/whitespace
 *      `text` and `thinking` blocks are filtered out — they're noise. User
 *      rows whose content is exclusively `tool_result` blocks are dropped
 *      (mirrors the compact-feed transmission filter).
 *   4. Order the union deterministically: `(sessionId, ts, rowId, blockIdx)`
 *      so chronological sequence is preserved across rows AND across
 *      multiple content blocks within a single row.
 *
 * The JS-side `mapResult` hook for `spaceTaskMessages.byTask.compact` runs
 * this SQL with the same `?1 = task_id` param the compact subscription was
 * bound with, then aggregates the per-entry rows by sessionId into the
 * `ActiveTurnSummary[]` shape consumers expect. Closed turns produce zero
 * rows here and so simply don't appear in the metadata payload.
 */
export const SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL = `
${SPACE_TASK_MESSAGES_BASE_CTE},
session_turns AS (
  SELECT
    j.id,
    j.sessionId,
    j.kind,
    j.role,
    j.label,
    j.taskId,
    j.taskTitle,
    j.messageType,
    j.content,
    j.createdAt,
    j.parentToolUseId,
    j.turnUserMessageId,
    j.isTerminal AS isTerminal,
    COALESCE(
      SUM(j.isTerminal) OVER (
        PARTITION BY j.sessionId
        ORDER BY j.createdAt ASC, j.id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) + 1 AS turnIndex
  FROM joined j
),
session_max_turn AS (
  SELECT sessionId, MAX(turnIndex) AS maxTurnIndex
  FROM session_turns
  GROUP BY sessionId
),
active_turn AS (
  -- The latest turn per session that has not yet seen a terminal result row.
  SELECT
    smt.sessionId AS sessionId,
    smt.maxTurnIndex AS turnIndex
  FROM session_max_turn smt
  WHERE NOT EXISTS (
    SELECT 1
    FROM session_turns st
    WHERE st.sessionId = smt.sessionId
      AND st.turnIndex = smt.maxTurnIndex
      AND st.isTerminal = 1
  )
),
active_rows AS (
  SELECT st.*
  FROM session_turns st
  JOIN active_turn at
    ON at.sessionId = st.sessionId
   AND at.turnIndex = st.turnIndex
),
-- One row per assistant content block (tool_use / non-empty text / thinking).
assistant_entries AS (
  SELECT
    ar.sessionId AS sessionId,
    ar.turnIndex AS turnIndex,
    ar.createdAt AS ts,
    ar.id AS rowId,
    CAST(je.key AS INTEGER) AS blockIdx,
    json_extract(ar.content, '$.uuid') AS uuid,
    json_extract(je.value, '$.type') AS blockType,
    json_extract(je.value, '$.name') AS toolName,
    json_extract(je.value, '$.input') AS toolInput,
    json_extract(je.value, '$.text') AS textValue,
    json_extract(je.value, '$.thinking') AS thinkingValue
  FROM active_rows ar,
       json_each(json_extract(ar.content, '$.message.content')) je
  WHERE ar.messageType = 'assistant'
    AND json_type(ar.content, '$.message.content') = 'array'
    AND (
      json_extract(je.value, '$.type') = 'tool_use'
      OR (
        json_extract(je.value, '$.type') = 'text'
        AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
      )
      OR (
        json_extract(je.value, '$.type') = 'thinking'
        AND TRIM(COALESCE(json_extract(je.value, '$.thinking'), '')) != ''
      )
    )
),
-- One row per user-typed message row (real human or synthetic replay).
user_entries AS (
  SELECT
    ar.sessionId AS sessionId,
    ar.turnIndex AS turnIndex,
    ar.createdAt AS ts,
    ar.id AS rowId,
    -1 AS blockIdx,
    json_extract(ar.content, '$.uuid') AS uuid,
    CASE
      WHEN COALESCE(CAST(json_extract(ar.content, '$.isReplay') AS INTEGER), 0) = 1
        THEN '__user_replay'
      ELSE '__user_message'
    END AS blockType,
    NULL AS toolName,
    NULL AS toolInput,
    -- Extract the plain-text body of the message.
    -- - String content → use directly.
    -- - Array content → concatenate text blocks.
    -- - Otherwise → empty string.
    CASE
      WHEN json_type(ar.content, '$.message.content') = 'text'
        THEN json_extract(ar.content, '$.message.content')
      WHEN json_type(ar.content, '$.message.content') = 'array' THEN (
        SELECT GROUP_CONCAT(json_extract(je.value, '$.text'), ' ')
        FROM json_each(json_extract(ar.content, '$.message.content')) je
        WHERE json_extract(je.value, '$.type') = 'text'
          AND COALESCE(json_extract(je.value, '$.text'), '') != ''
      )
      ELSE ''
    END AS textValue,
    NULL AS thinkingValue
  FROM active_rows ar
  WHERE ar.messageType = 'user'
    -- Skip user rows whose content is exclusively tool_result blocks (or
    -- mixes tool_result with empty/whitespace-only text blocks). Such rows
    -- render as null in the compact feed and would otherwise produce a
    -- blank rail entry — the GROUP_CONCAT above already filters empty text,
    -- so the row would survive the filter with textValue = NULL.
    --
    -- Mirrors the assistant-entries filter on lines above, which also
    -- excludes empty-text blocks from contributing to the roster.
    AND NOT (
      json_type(ar.content, '$.message.content') = 'array'
      AND EXISTS (
        SELECT 1
        FROM json_each(json_extract(ar.content, '$.message.content')) je
        WHERE json_extract(je.value, '$.type') = 'tool_result'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(ar.content, '$.message.content')) je
        WHERE json_extract(je.value, '$.type') = 'text'
          AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
      )
    )
)
SELECT
  sessionId || ':' || turnIndex || ':' || rowId || ':' || blockIdx AS id,
  sessionId,
  turnIndex,
  ts,
  rowId,
  blockIdx,
  uuid,
  blockType,
  toolName,
  toolInput,
  textValue,
  thinkingValue
FROM assistant_entries
UNION ALL
SELECT
  sessionId || ':' || turnIndex || ':' || rowId || ':' || blockIdx AS id,
  sessionId,
  turnIndex,
  ts,
  rowId,
  blockIdx,
  uuid,
  blockType,
  toolName,
  toolInput,
  textValue,
  thinkingValue
FROM user_entries
ORDER BY sessionId ASC, ts ASC, rowId ASC, blockIdx ASC, id ASC
`.trim();

// ============================================================================
// Active-turn entry aggregation
// ============================================================================

const ACTIVITY_PREVIEW_MAX_LEN = 200;

/**
 * Collapse arbitrary text into a single line and cap its length so the
 * server-side preview matches what the rail can render without further work.
 * Mirrors the client-side `oneLine` shape so trailing ellipses and whitespace
 * collapsing line up byte-for-byte across server and client.
 */
function activityOneLine(value: string, max = ACTIVITY_PREVIEW_MAX_LEN): string {
	const collapsed = value.replace(/\s+/g, ' ').trim();
	if (collapsed.length === 0) return '';
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function activityStringProp(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	return typeof value === 'string' ? value : '';
}

function activityPathBase(path: string): string {
	const parts = path.split('/').filter(Boolean);
	return parts[parts.length - 1] || path;
}

function activityPreviewFromTodoInput(input: Record<string, unknown>): string {
	const todos = input.todos;
	if (!Array.isArray(todos)) return 'Update todos';
	const todoItems = todos
		.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
		.map((item) => {
			const content = activityStringProp(item, 'content');
			const activeForm = activityStringProp(item, 'activeForm');
			const status = activityStringProp(item, 'status');
			return { content, activeForm, status };
		});
	const running = todoItems.find((item) => item.status === 'in_progress');
	if (running) {
		return activityOneLine(`Running: ${running.activeForm || running.content || 'todo item'}`);
	}
	const completed = [...todoItems].reverse().find((item) => item.status === 'completed');
	if (completed?.content) return activityOneLine(`Marked done: ${completed.content}`);
	const pending = todoItems.find((item) => item.status === 'pending');
	if (pending?.content) return activityOneLine(`Added task: ${pending.content}`);
	const count = todoItems.length;
	return count ? `${count} todo${count !== 1 ? 's' : ''}` : 'Update todos';
}

function activityPreviewFromQuestionInput(input: Record<string, unknown>): string {
	const questions = input.questions;
	if (!Array.isArray(questions) || questions.length === 0) return 'Ask user';
	const firstQuestion = questions.find(
		(question): question is Record<string, unknown> => !!question && typeof question === 'object'
	);
	const text = firstQuestion ? activityStringProp(firstQuestion, 'question') : '';
	if (!text) return `${questions.length} question${questions.length !== 1 ? 's' : ''}`;
	const suffix = questions.length > 1 ? ` (+${questions.length - 1})` : '';
	return `${activityOneLine(text, 60)}${suffix}`;
}

/**
 * Pick a human-friendly preview from a tool_use input object. The branch order
 * mirrors the SDK tool registry summaries where possible so compact roster
 * lines carry the same primary meaning as full chat tool blocks.
 */
function activityPreviewFromToolInput(toolName: string, input: Record<string, unknown>): string {
	if (toolName.startsWith('mcp__')) {
		return '';
	}
	switch (toolName) {
		case 'Bash': {
			const description = activityStringProp(input, 'description');
			if (description) return activityOneLine(description);
			return activityOneLine(activityStringProp(input, 'command'));
		}
		case 'Write':
		case 'Edit': {
			const filePath = activityStringProp(input, 'file_path');
			return filePath ? activityOneLine(activityPathBase(filePath)) : '';
		}
		case 'MultiEdit': {
			const filePath = activityStringProp(input, 'file_path');
			return filePath ? activityOneLine(activityPathBase(filePath)) : '';
		}
		case 'Read': {
			const filePath = activityStringProp(input, 'file_path');
			return filePath ? activityOneLine(activityPathBase(filePath)) : '';
		}
		case 'NotebookEdit': {
			const notebookPath = activityStringProp(input, 'notebook_path');
			return notebookPath ? activityOneLine(activityPathBase(notebookPath)) : '';
		}
		case 'Glob':
		case 'Grep':
			return activityOneLine(activityStringProp(input, 'pattern'), 50);
		case 'WebFetch':
			return activityOneLine(activityStringProp(input, 'url'), 50);
		case 'WebSearch':
			return activityOneLine(activityStringProp(input, 'query'), 50);
		case 'Task':
			return activityOneLine(activityStringProp(input, 'description') || 'Task execution');
		case 'Agent':
			return activityOneLine(activityStringProp(input, 'description') || 'Agent execution');
		case 'TaskOutput':
			return activityOneLine(activityStringProp(input, 'task_id') || 'Task output');
		case 'TaskStop':
			return activityOneLine(
				activityStringProp(input, 'task_id') || activityStringProp(input, 'shell_id') || 'Stop task'
			);
		case 'BashOutput': {
			const bashId = activityStringProp(input, 'bash_id');
			return `Shell: ${bashId.slice(0, 8) || 'unknown'}`;
		}
		case 'KillShell': {
			const shellId = activityStringProp(input, 'shell_id');
			return `Shell: ${shellId.slice(0, 8) || 'unknown'}`;
		}
		case 'TodoWrite':
			return activityPreviewFromTodoInput(input);
		case 'ListMcpResourcesTool':
			return activityOneLine(activityStringProp(input, 'server') || 'All servers');
		case 'ReadMcpResourceTool':
			return activityOneLine(activityStringProp(input, 'uri'), 50);
		case 'AskUserQuestion':
			return activityPreviewFromQuestionInput(input);
		case 'EnterPlanMode':
			return 'Entering plan mode';
		case 'ExitPlanMode':
			return 'Exiting plan mode';
		case 'TimeMachine':
			return activityOneLine(activityStringProp(input, 'message_prefix'), 40);
		default: {
			const keys = Object.keys(input);
			if (keys.length === 0) return '';
			const firstKey = keys[0];
			const firstVal = input[firstKey];
			if (typeof firstVal === 'string') return activityOneLine(firstVal, 40);
			return `${firstKey}: …`;
		}
	}
}

/**
 * Aggregate the per-entry rows produced by `SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL`
 * into the `ActiveTurnSummary[]` payload the client consumes.
 *
 * Each row corresponds to a single activity entry (one assistant content
 * block, or one user-row entry). Rows are already chronologically sorted by
 * the SQL — we only need to group by sessionId and translate the raw
 * `blockType` discriminator into the public `ActivityEntry.kind` shape, while
 * computing previews / unwrapping `tool_use.input` JSON server-side.
 *
 * Exported for unit-test coverage.
 */
export function buildActiveTurnSummariesFromRows(
	rows: Record<string, unknown>[]
): Array<{ sessionId: string; turnIndex: number; entries: Record<string, unknown>[] }> {
	const bySession = new Map<
		string,
		{ sessionId: string; turnIndex: number; entries: Record<string, unknown>[] }
	>();

	for (const row of rows) {
		const sessionId = typeof row.sessionId === 'string' ? row.sessionId : null;
		if (!sessionId) continue;
		const turnIndex = Number(row.turnIndex ?? 0);
		const ts = Number(row.ts ?? 0);
		const uuid = typeof row.uuid === 'string' ? row.uuid : '';
		const blockType = typeof row.blockType === 'string' ? row.blockType : '';

		let entry: Record<string, unknown> | null = null;
		if (blockType === 'tool_use') {
			const toolName = typeof row.toolName === 'string' ? row.toolName : '';
			const rawInput = row.toolInput;
			let parsedInput: Record<string, unknown> = {};
			if (typeof rawInput === 'string') {
				try {
					const maybe = JSON.parse(rawInput);
					if (maybe && typeof maybe === 'object') {
						parsedInput = maybe as Record<string, unknown>;
					}
				} catch {
					// Leave parsedInput empty — preview falls through to `tool_name: …`.
				}
			} else if (rawInput && typeof rawInput === 'object') {
				parsedInput = rawInput as Record<string, unknown>;
			}
			entry = {
				kind: 'tool_use',
				toolName,
				preview: activityPreviewFromToolInput(toolName, parsedInput),
				ts,
				uuid,
			};
		} else if (blockType === 'text') {
			const text = typeof row.textValue === 'string' ? row.textValue : '';
			if (text.trim().length === 0) continue;
			entry = { kind: 'text', text: activityOneLine(text), ts, uuid };
		} else if (blockType === 'thinking') {
			const thinking = typeof row.thinkingValue === 'string' ? row.thinkingValue : '';
			if (thinking.trim().length === 0) continue;
			entry = { kind: 'thinking', preview: thinking.trim(), ts, uuid };
		} else if (blockType === '__user_message') {
			const text = typeof row.textValue === 'string' ? row.textValue : '';
			entry = { kind: 'user_message', text: activityOneLine(text), ts, uuid };
		} else if (blockType === '__user_replay') {
			const text = typeof row.textValue === 'string' ? row.textValue : '';
			entry = { kind: 'agent_handoff', text: activityOneLine(text), ts, uuid };
		}
		if (!entry) continue;

		let summary = bySession.get(sessionId);
		if (!summary) {
			summary = { sessionId, turnIndex, entries: [] };
			bySession.set(sessionId, summary);
		}
		summary.entries.push(entry);
	}

	return Array.from(bySession.values());
}

function mapActiveTurnEntryRow(row: Record<string, unknown>): Record<string, unknown> {
	const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
	const turnIndex = Number(row.turnIndex ?? 0);
	const ts = Number(row.ts ?? 0);
	const uuid = typeof row.uuid === 'string' ? row.uuid : '';
	const blockType = typeof row.blockType === 'string' ? row.blockType : '';
	const rowId = typeof row.rowId === 'string' || typeof row.rowId === 'number' ? row.rowId : '';
	const blockIdx = Number(row.blockIdx ?? -1);
	const rawId = row.id;
	const id = typeof rawId === 'string' ? rawId : `${sessionId}:${turnIndex}:${rowId}:${blockIdx}`;

	let entry: Record<string, unknown> | null = null;
	if (blockType === 'tool_use') {
		const toolName = typeof row.toolName === 'string' ? row.toolName : '';
		const rawInput = row.toolInput;
		let parsedInput: Record<string, unknown> = {};
		if (typeof rawInput === 'string') {
			try {
				const maybe = JSON.parse(rawInput);
				if (maybe && typeof maybe === 'object') parsedInput = maybe as Record<string, unknown>;
			} catch {
				parsedInput = {};
			}
		} else if (rawInput && typeof rawInput === 'object') {
			parsedInput = rawInput as Record<string, unknown>;
		}
		entry = {
			kind: 'tool_use',
			toolName,
			preview: activityPreviewFromToolInput(toolName, parsedInput),
			ts,
			uuid,
		};
	} else if (blockType === 'text') {
		const text = typeof row.textValue === 'string' ? row.textValue : '';
		if (text.trim().length > 0) entry = { kind: 'text', text: activityOneLine(text), ts, uuid };
	} else if (blockType === 'thinking') {
		const thinking = typeof row.thinkingValue === 'string' ? row.thinkingValue : '';
		if (thinking.trim().length > 0) {
			entry = { kind: 'thinking', preview: thinking.trim(), ts, uuid };
		}
	} else if (blockType === '__user_message') {
		const text = typeof row.textValue === 'string' ? row.textValue : '';
		entry = { kind: 'user_message', text: activityOneLine(text), ts, uuid };
	} else if (blockType === '__user_replay') {
		const text = typeof row.textValue === 'string' ? row.textValue : '';
		entry = { kind: 'agent_handoff', text: activityOneLine(text), ts, uuid };
	}

	return {
		id,
		sessionId,
		turnIndex,
		ts,
		entry,
	};
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Server-side named-query registry.
 *
 * Keys are opaque identifiers sent by the client in `LiveQuerySubscribeRequest.queryName`.
 * Each entry specifies the SQL template, expected parameter count, and an optional
 * row mapper that performs post-processing (JSON parsing, type coercion).
 *
 * Exported for use in `liveQuery.subscribe` / `liveQuery.unsubscribe` handlers
 * and for direct inspection in unit tests.
 */

/**
 * SQL for `sessions.list` LiveQuery.
 *
 * Returns all user-visible sessions (excludes internal room/space/agent sessions).
 * Filters out room/space sessions by checking session_context for roomId/spaceId.
 * Includes archived sessions so the client can toggle visibility.
 */
const SESSIONS_LIST_SQL = `
SELECT
  s.id as id,
  s.title as title,
  s.workspace_path as workspacePath,
  s.created_at as createdAt,
  s.last_active_at as lastActiveAt,
  s.status as status,
  s.config as config,
  s.metadata as metadata,
  s.is_worktree as is_worktree,
  s.worktree_path as worktree_path,
  s.main_repo_path as main_repo_path,
  s.worktree_branch as worktree_branch,
  s.git_branch as gitBranch,
  s.sdk_session_id as sdkSessionId,
  s.available_commands as available_commands,
  s.processing_state as processingState,
  s.archived_at as archivedAt,
  s.type as type,
  s.session_context as session_context,
  (SELECT COUNT(*) FROM sessions s2
   WHERE s2.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
   AND json_extract(s2.session_context, '$.roomId') IS NULL
   AND json_extract(s2.session_context, '$.spaceId') IS NULL) as _totalCount,
  (SELECT COUNT(*) FROM sessions s3
   WHERE s3.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
   AND json_extract(s3.session_context, '$.roomId') IS NULL
   AND json_extract(s3.session_context, '$.spaceId') IS NULL
   AND s3.status = 'archived') as _archivedCount
FROM sessions s
WHERE s.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
  AND json_extract(s.session_context, '$.roomId') IS NULL
  AND json_extract(s.session_context, '$.spaceId') IS NULL
  AND (s.status != 'archived' OR ?1 = 1)
ORDER BY s.last_active_at DESC, s.id DESC
`.trim();

/**
 * SQL for counting ALL user-visible sessions regardless of archived status.
 * Used to provide an accurate totalCount even when the visible session list is empty
 * (e.g. when all sessions are archived and showArchived=false).
 */
const SESSIONS_TOTAL_COUNT_SQL = `
SELECT COUNT(*) as cnt FROM sessions s
WHERE s.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
  AND json_extract(s.session_context, '$.roomId') IS NULL
  AND json_extract(s.session_context, '$.spaceId') IS NULL
`.trim();

/**
 * SQL for counting only archived user-visible sessions.
 * Used to provide an accurate archivedCount even when the visible session list is empty.
 */
const SESSIONS_ARCHIVED_COUNT_SQL = `
SELECT COUNT(*) as cnt FROM sessions s
WHERE s.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
  AND json_extract(s.session_context, '$.roomId') IS NULL
  AND json_extract(s.session_context, '$.spaceId') IS NULL
  AND s.status = 'archived'
`.trim();

/**
 * Map a raw SQLite sessions row to a SessionInfo object.
 *
 * Handles:
 * - JSON parsing of config, metadata, session_context, available_commands
 * - Worktree metadata reconstruction from flat columns
 * - Type coercion for is_worktree (integer → boolean)
 */
function mapSessionRow(row: Record<string, unknown>): Record<string, unknown> {
	const isWorktree = row.is_worktree === 1;
	const worktree = isWorktree
		? {
				isWorktree: true as const,
				worktreePath: row.worktree_path as string,
				mainRepoPath: row.main_repo_path as string,
				branch: row.worktree_branch as string,
			}
		: undefined;

	const availableCommands =
		row.available_commands && typeof row.available_commands === 'string'
			? (JSON.parse(row.available_commands) as string[])
			: undefined;

	const sessionContext =
		row.session_context && typeof row.session_context === 'string'
			? parseJsonOptional(row.session_context)
			: undefined;

	return {
		id: row.id,
		title: row.title,
		workspacePath: row.workspacePath,
		createdAt: row.createdAt,
		lastActiveAt: row.lastActiveAt,
		status: row.status,
		config: parseJson(row.config as string, {}),
		metadata: parseJson(row.metadata as string, {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		}),
		worktree,
		gitBranch: (row.gitBranch as string | null) ?? undefined,
		sdkSessionId: (row.sdkSessionId as string | null) ?? undefined,
		availableCommands,
		processingState: (row.processingState as string | null) ?? undefined,
		archivedAt: (row.archivedAt as string | null) ?? undefined,
		type: (row.type as string | null) ?? 'worker',
		context: sessionContext,
	};
}

const SPACE_SESSIONS_BY_SPACE_SQL = `
SELECT
  s.id as id,
  s.title as title,
  s.status as status,
  (unixepoch(s.last_active_at) - 0) * 1000 as lastActiveAt
FROM sessions s
INNER JOIN spaces sp ON sp.id = ?
CROSS JOIN json_each(sp.session_ids) j
WHERE j.value = s.id AND s.status != 'archived' AND s.type != 'space_chat'
ORDER BY s.last_active_at DESC, s.id DESC
`.trim();

/**
 * SQL for `messages.bySession` LiveQuery.
 *
 * Returns SDK messages for a session in the same shape that
 * `SDKMessageRepository.getSDKMessages()` produces:
 *   - Top-level messages (no `parent_tool_use_id`), limited to the most recent
 *     N rows (by timestamp DESC).
 *   - Plus subagent messages (rows whose `parent_tool_use_id` is a tool_use id
 *     emitted by one of those top-level assistant rows).
 *   - User messages with `send_status = 'deferred'` or `'enqueued'` are
 *     excluded, matching the RPC behavior.
 *
 * Parameters (positional, via `?1` / `?2`):
 *   ?1 — session_id (used twice because the CTE references sdk_messages twice)
 *   ?2 — top-level row limit (default 100 from the client)
 *
 * Mapping: the raw row carries the JSON-serialised SDK message in `content`,
 * plus `timestamp` (epoch ms), `sendStatus`, and `origin`.  `mapMessageRow`
 * inflates the JSON and merges the extras to produce a ChatMessage-shaped
 * object.
 */
const MESSAGES_BY_SESSION_SQL = `
WITH top_level AS (
  SELECT
    id,
    sdk_message,
    timestamp,
    send_status,
    origin
  FROM sdk_messages
  WHERE session_id = ?1
    AND parent_tool_use_id IS NULL
    AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
  ORDER BY timestamp DESC, id DESC
  LIMIT ?2
),
tool_use_ids AS (
  SELECT DISTINCT json_extract(je.value, '$.id') AS id
  FROM top_level,
       json_each(json_extract(top_level.sdk_message, '$.message.content')) AS je
  WHERE json_extract(top_level.sdk_message, '$.type') = 'assistant'
    AND json_extract(je.value, '$.type') = 'tool_use'
    AND json_extract(je.value, '$.id') IS NOT NULL
),
subagent AS (
  SELECT
    sm.id AS id,
    sm.sdk_message AS sdk_message,
    sm.timestamp AS timestamp,
    sm.send_status AS send_status,
    sm.origin AS origin
  FROM sdk_messages sm
  WHERE sm.session_id = ?1
    AND sm.parent_tool_use_id IN (SELECT id FROM tool_use_ids)
    AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
)
SELECT
  id,
  sdk_message                                                       AS content,
  CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER)    AS timestamp,
  send_status                                                       AS sendStatus,
  origin                                                            AS origin
FROM top_level
UNION ALL
SELECT
  id,
  sdk_message                                                       AS content,
  CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER)    AS timestamp,
  send_status                                                       AS sendStatus,
  origin                                                            AS origin
FROM subagent
ORDER BY timestamp ASC, id ASC
`.trim();

/**
 * Map a raw `messages.bySession` row into a ChatMessage-shaped object.
 *
 * Mirrors the behaviour of `SDKMessageRepository.getSDKMessages()`:
 *   - Parse the `sdk_message` JSON blob and spread its fields onto the output.
 *   - Override `origin` with the DB column value — explicit `undefined` is
 *     preserved so any SDK-level `origin?: SDKMessageOrigin` object gets
 *     stripped in favour of the app's `MessageOrigin` string.
 *   - Attach `timestamp` (epoch ms, computed SQL-side).
 *   - Attach `sendStatus` only when the DB column equals `'failed'`, so the UI
 *     can render the retry affordance without carrying 'consumed' through the
 *     message stream.
 *   - Attach `id` so client-side LiveQuery diffing is stable even when the
 *     SDK message lacks a `uuid`.
 */
function mapMessageRow(row: Record<string, unknown>): Record<string, unknown> {
	const contentRaw = row.content;
	let parsed: Record<string, unknown> = {};
	if (typeof contentRaw === 'string') {
		try {
			parsed = JSON.parse(contentRaw) as Record<string, unknown>;
		} catch {
			// Corrupted JSON — return a sentinel object so the client doesn't crash.
			parsed = { type: 'unknown', rawContent: contentRaw };
		}
	}

	const extras: Record<string, unknown> = {
		id: row.id,
		timestamp: typeof row.timestamp === 'number' ? row.timestamp : Number(row.timestamp ?? 0),
		origin: row.origin != null ? row.origin : undefined,
	};
	if (row.sendStatus === 'failed') {
		extras.sendStatus = 'failed';
	}

	return { ...parsed, ...extras };
}

/**
 * Build a scope filter for task-scoped queries (`spaceTaskMessages.byTask*`,
 * `spaceTaskActivity.byTask`). Returns `false` when the writing session is
 * not part of the target task, so the live query engine can skip re-evaluation.
 *
 * Membership is derived from three sources:
 *   1. `space_tasks.task_agent_session_id` — the orchestration session
 *   2. `node_executions` for the task's workflow run — node-agent sessions
 *   3. `sdk_messages.task_id` — sessions that have stamped messages for the task
 *
 * Because scoped delete events are emitted *after* the row is removed, a
 * session that just deleted its final task-stamped message would fail the
 * `sdk_messages.task_id` check even though the feed changed. To prevent
 * false negatives we capture the set of sessions that were linked at
 * subscribe time (including those with historical messages) and keep them
 * in-scope for the lifetime of the subscription. New sessions that join
 * after subscribe are caught by the dynamic checks.
 */
function buildTaskScopeFilter(
	params: ReadonlyArray<unknown>,
	db: BunDatabase
): ((scope: TableChangeScope) => boolean) | undefined {
	const taskId = params[0] as string;

	// Capture the set of sessions linked to this task at subscribe time.
	// This prevents the delete-last-message false negative: a session that
	// had messages when the subscription was created stays in-scope even
	// after those messages are deleted.
	const linkedSessions = new Set<string>();
	try {
		const taskAgent = db
			.prepare('SELECT task_agent_session_id FROM space_tasks WHERE id = ?')
			.get(taskId) as { task_agent_session_id: string } | undefined;
		if (taskAgent?.task_agent_session_id) {
			linkedSessions.add(taskAgent.task_agent_session_id);
		}
	} catch {
		// space_tasks may not exist in minimal test schemas
	}
	try {
		const nodeAgents = db
			.prepare(
				`SELECT ne.agent_session_id
				 FROM node_executions ne
				 JOIN space_tasks st ON st.id = ? AND st.workflow_run_id IS NOT NULL
				 WHERE ne.workflow_run_id = st.workflow_run_id
				   AND ne.agent_session_id IS NOT NULL`
			)
			.all(taskId) as Array<{ agent_session_id: string }>;
		for (const row of nodeAgents) {
			if (row.agent_session_id) linkedSessions.add(row.agent_session_id);
		}
	} catch {
		// node_executions may not exist in minimal test schemas
	}
	try {
		const messageSessions = db
			.prepare('SELECT DISTINCT session_id FROM sdk_messages WHERE task_id = ?')
			.all(taskId) as Array<{ session_id: string }>;
		for (const row of messageSessions) {
			if (row.session_id) linkedSessions.add(row.session_id);
		}
	} catch {
		// sdk_messages may not exist in minimal test schemas
	}

	// Dynamic checks for sessions that become linked after subscribe time.
	const messageStmt = db.prepare(
		`SELECT 1 FROM sdk_messages WHERE task_id = ? AND session_id = ? LIMIT 1`
	);
	const taskAgentStmt = db.prepare(
		`SELECT 1 FROM space_tasks WHERE id = ? AND task_agent_session_id = ? LIMIT 1`
	);
	const nodeExecStmt = db.prepare(
		`SELECT 1 FROM node_executions ne
		 JOIN space_tasks st ON st.id = ?
		   AND st.workflow_run_id IS NOT NULL
		   AND ne.workflow_run_id = st.workflow_run_id
		 WHERE ne.agent_session_id = ?
		 LIMIT 1`
	);
	return (scope) => {
		if (scope.taskId) return scope.taskId === taskId;
		if (!scope.sessionId) return true;
		if (linkedSessions.has(scope.sessionId)) return true;
		if (messageStmt.get(taskId, scope.sessionId)) return true;
		if (taskAgentStmt.get(taskId, scope.sessionId)) return true;
		return !!nodeExecStmt.get(taskId, scope.sessionId);
	};
}

// Note: `sessions.list` intentionally has no scope filter. The query only
// watches the `sessions` table, so incoming scopes describe session-level
// writes (createSession / updateSession / deleteSession). The scope reflects
// the *post*-write row, so we cannot tell whether an `updateSession` moved a
// session in or out of the visible chat-sidebar set (e.g. by gaining
// `roomId`/`spaceId`, or being reclassified to an internal type via
// `AgentSession.fromInit`). Skipping such writes leaves stale rows. Session
// writes are infrequent compared to `sdk_messages`, so re-evaluating
// `sessions.list` on every session write is cheap and correct.

function buildSpaceSessionsScopeFilter(
	params: ReadonlyArray<unknown>,
	db: BunDatabase
): (scope: TableChangeScope) => boolean {
	const spaceId = params[0] as string;
	// Re-query membership on every invalidation rather than snapshotting at
	// subscribe time. Snapshotting drops two important update paths:
	//   1. Sessions added to the space *after* subscription would be filtered
	//      out and miss title/status/lastActiveAt changes until the client
	//      reconnects.
	//   2. Sessions removed from the space would remain "in scope" forever,
	//      causing avoidable re-evaluations.
	// Reading the row is a single indexed lookup against `spaces.id`, so
	// the cost is negligible relative to the SQL re-evaluation it gates.
	const memberStmt = db.prepare('SELECT session_ids FROM spaces WHERE id = ?');
	const readMembership = (): Set<string> | null => {
		try {
			const row = memberStmt.get(spaceId) as { session_ids: string | null } | undefined;
			if (!row?.session_ids) return new Set();
			const parsed = JSON.parse(row.session_ids) as unknown;
			if (!Array.isArray(parsed)) return new Set();
			const out = new Set<string>();
			for (const value of parsed) {
				if (typeof value === 'string') out.add(value);
			}
			return out;
		} catch {
			return null;
		}
	};

	return (scope) => {
		// If the scope explicitly tags this write with our spaceId (e.g. the
		// session was just created/updated as a member of this space), accept
		// without an extra DB hit. Covers the new-member case directly.
		if (scope.spaceId === spaceId) return true;

		// No sessionId on the scope (e.g. a `spaces` row was rewritten):
		// we cannot tell what changed, so be conservative.
		if (!scope.sessionId) return true;

		const members = readMembership();
		if (members === null) return true; // membership unreadable: be safe
		// Re-evaluate when the session is currently in this space *or* could
		// have been a member just before the write — we cannot distinguish a
		// just-removed session from an unrelated session here, so accept any
		// scope whose sessionId matches the live set. Sessions outside the
		// live set with no spaceId hint are filtered.
		return members.has(scope.sessionId);
	};
}

export const NAMED_QUERY_REGISTRY = new Map<string, NamedQuery>([
	[
		'sessionGroupMessages.byGroup',
		{
			sql: SESSION_GROUP_MESSAGES_BY_GROUP_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SESSION_GROUP_MESSAGES_MS,
			mapRow: mapSessionGroupMessageRow,
			buildScopeFilter: (params, db) => {
				const groupId = params[0] as string;
				const stmt = db.prepare(
					'SELECT 1 FROM session_group_members WHERE group_id = ? AND session_id = ? LIMIT 1'
				);
				return (scope) => {
					if (!scope.sessionId) return true;
					return !!stmt.get(groupId, scope.sessionId);
				};
			},
		},
	],
	[
		'spaceTaskActivity.byTask',
		{
			sql: SPACE_TASK_ACTIVITY_BY_TASK_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
			mapRow: mapSpaceTaskActivityRow,
			buildScopeFilter: buildTaskScopeFilter,
		},
	],
	[
		'spaceTaskMessages.byTask',
		{
			sql: SPACE_TASK_MESSAGES_BY_TASK_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
			mapRow: mapSpaceTaskMessageRow,
			buildScopeFilter: buildTaskScopeFilter,
		},
	],
	[
		'spaceTaskMessages.byTask.compact',
		{
			sql: SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
			mapRow: mapSpaceTaskMessageRow,
			buildScopeFilter: buildTaskScopeFilter,
		},
	],
	[
		'spaceTaskActiveTurn.byTask',
		{
			sql: SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
			mapRow: mapActiveTurnEntryRow,
			buildScopeFilter: buildTaskScopeFilter,
		},
	],
	[
		'mcpServers.global',
		{
			sql: MCP_SERVERS_GLOBAL_SQL,
			paramCount: 0,
			mapRow: mapMcpServerRow,
		},
	],
	[
		'skills.list',
		{
			sql: SKILLS_LIST_SQL,
			paramCount: 0,
			mapRow: mapSkillRow,
		},
	],
	[
		'mcpEnablement.bySpace',
		{
			sql: MCP_ENABLEMENT_BY_SPACE_SQL,
			paramCount: 1,
			mapRow: mapMcpEnablementBySpaceRow,
		},
	],
	[
		'actorMessages.byTask',
		{
			sql: ACTOR_MESSAGES_BY_TASK_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
			mapRow: mapActorMessageProjectionRow,
			buildScopeFilter: buildTaskScopeFilter,
		},
	],
	[
		'actorMessages.byWorkflowRun',
		{
			sql: ACTOR_MESSAGES_BY_WORKFLOW_RUN_SQL,
			paramCount: 3,
			debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
			mapRow: mapActorMessageProjectionRow,
		},
	],
	[
		'nodeExecutions.byRun',
		{
			sql: NODE_EXECUTIONS_BY_RUN_SQL,
			paramCount: 1,
		},
	],
	[
		'workflowRunArtifacts.byRun',
		{
			sql: WORKFLOW_RUN_ARTIFACTS_BY_RUN_SQL,
			paramCount: 1,
			mapRow: mapArtifactRow,
		},
	],
	[
		'spaceSessions.bySpace',
		{
			sql: SPACE_SESSIONS_BY_SPACE_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SPACE_SESSIONS_MS,
			buildScopeFilter: buildSpaceSessionsScopeFilter,
		},
	],
	[
		'messages.bySession',
		{
			sql: MESSAGES_BY_SESSION_SQL,
			paramCount: 2,
			debounceMs: DEBOUNCE_SDK_MESSAGES_MS,
			mapRow: mapMessageRow,
			buildScopeFilter: (params) => {
				const targetSessionId = params[0] as string;
				return (scope) => {
					if (!scope.sessionId) return true;
					return scope.sessionId === targetSessionId;
				};
			},
		},
	],
	[
		'sessions.list',
		{
			sql: SESSIONS_LIST_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SESSION_LIST_MS,
			mapRow: mapSessionRow,
			// No scope filter — see the comment on the (deleted)
			// `buildSessionsListScopeFilter` site above. Session writes are
			// infrequent and `updateSession` post-write scope can hide
			// transitions that should remove a row from this list.
			mapResult: (rawRows) => {
				if (rawRows.length > 0 && rawRows[0]._totalCount != null) {
					return {
						totalCount: rawRows[0]._totalCount as number,
						archivedCount: (rawRows[0]._archivedCount as number | null) ?? 0,
					};
				}
				return { totalCount: 0, archivedCount: 0 };
			},
		},
	],
]);

// ============================================================================
// Logger
// ============================================================================

const log = new Logger('live-query-handlers');

// ============================================================================
// RPC handler setup
// ============================================================================

/**
 * Register `liveQuery.subscribe` and `liveQuery.unsubscribe` RPC handlers.
 *
 * Returns a cleanup function that disposes all active subscriptions and
 * unregisters the client-disconnect listener.
 */
export function setupLiveQueryHandlers(
	messageHub: MessageHub,
	liveQueries: LiveQueryEngine,
	db: BunDatabase
): () => void {
	// Map<clientId → Map<subscriptionId → LiveQueryHandle>>
	const subscriptions = new Map<string, Map<string, LiveQueryHandle<Record<string, unknown>>>>();

	// Build a local registry that overrides sessions.list with a closure capturing db.
	// This ensures totalCount and archivedCount metadata are accurate even when the
	// visible session list is empty (e.g. all sessions are archived, showArchived=false).
	const stmtSessionsTotalCount = db.prepare(SESSIONS_TOTAL_COUNT_SQL);
	const stmtSessionsArchivedCount = db.prepare(SESSIONS_ARCHIVED_COUNT_SQL);

	const sessionsListBase = NAMED_QUERY_REGISTRY.get('sessions.list')!;
	const activeRegistry = new Map(NAMED_QUERY_REGISTRY);

	activeRegistry.set('sessions.list', {
		...sessionsListBase,
		mapResult: (rawRows) => {
			if (rawRows.length > 0 && rawRows[0]._totalCount != null) {
				return {
					totalCount: rawRows[0]._totalCount as number,
					archivedCount: (rawRows[0]._archivedCount as number | null) ?? 0,
				};
			}
			// When no visible sessions exist (e.g. all archived and showArchived=false),
			// run direct count queries so hasArchivedSessions correctly shows the toggle.
			const totalRow = stmtSessionsTotalCount.get() as { cnt: number } | undefined;
			const archivedRow = stmtSessionsArchivedCount.get() as { cnt: number } | undefined;
			return {
				totalCount: totalRow?.cnt ?? 0,
				archivedCount: archivedRow?.cnt ?? 0,
			};
		},
	});

	// Cache prepared statements once at setup time — compiled once per handler
	// registration, not once per subscribe call (which would add compilation
	// overhead on every subscribe RPC invocation).
	const stmtRoom = db.prepare('SELECT id FROM rooms WHERE id = ?');
	const stmtGroup = db.prepare('SELECT ref_id, group_type FROM session_groups WHERE id = ?');
	const stmtTask = db.prepare('SELECT room_id FROM tasks WHERE id = ?');
	const stmtSpace = db.prepare('SELECT id FROM spaces WHERE id = ?');
	const stmtSession = db.prepare('SELECT id FROM sessions WHERE id = ?');

	// -------------------------------------------------------------------------
	// liveQuery.subscribe
	// -------------------------------------------------------------------------

	messageHub.onRequest('liveQuery.subscribe', (data, context) => {
		const { queryName, params, subscriptionId } = data as LiveQuerySubscribeRequest;
		const { clientId, sessionId } = context;

		// 1. Require WebSocket clientId
		if (!clientId) {
			throw new Error('liveQuery.subscribe requires a WebSocket connection (clientId absent)');
		}

		// 2. Resolve query from registry
		const namedQuery = activeRegistry.get(queryName);
		if (!namedQuery) {
			throw new Error(`Unknown query name: "${queryName}"`);
		}

		// 3. Validate parameter count
		if (params.length !== namedQuery.paramCount) {
			throw new Error(
				`Query "${queryName}" expects ${namedQuery.paramCount} parameter(s), got ${params.length}`
			);
		}

		// 4. Authorization checks
		if (queryName === 'sessionGroupMessages.byGroup') {
			const groupId = params[0] as string;
			const group = stmtGroup.get(groupId) as { ref_id: string; group_type: string } | null;
			if (!group) {
				throw new Error(`Unauthorized: session group "${groupId}" not found`);
			}
			if (group.group_type === 'task') {
				// For task-typed groups, verify the full group → task → room chain.
				// This ensures the requesting client has access to the room the task belongs to.
				const task = stmtTask.get(group.ref_id) as { room_id: string } | null;
				if (!task) {
					throw new Error(`Unauthorized: task "${group.ref_id}" not found`);
				}
				if (!stmtRoom.get(task.room_id)) {
					throw new Error(`Unauthorized: room "${task.room_id}" not found`);
				}
			}
			// Non-task group types (e.g., 'workflow', 'global') are authorized by group
			// existence alone.  All current non-task groups are internal daemon constructs
			// not directly reachable by client-supplied IDs without prior knowledge.
			// If new group types with finer-grained access control are introduced, extend
			// this block with the appropriate chain validation.
		} else if (
			queryName === 'spaceTaskActivity.byTask' ||
			queryName === 'spaceTaskMessages.byTask' ||
			queryName === 'spaceTaskMessages.byTask.compact' ||
			queryName === 'spaceTaskActiveTurn.byTask'
		) {
			const taskId = params[0] as string;
			let spaceTask: { space_id: string } | null = null;
			try {
				spaceTask = db.prepare('SELECT space_id FROM space_tasks WHERE id = ?').get(taskId) as {
					space_id: string;
				} | null;
			} catch {
				spaceTask = null;
			}
			if (!spaceTask) {
				throw new Error(`Unauthorized: space task "${taskId}" not found`);
			}
		} else if (queryName === 'spaceSessions.bySpace' || queryName === 'mcpEnablement.bySpace') {
			const spaceId = params[0] as string;
			if (!stmtSpace.get(spaceId)) {
				throw new Error(`Unauthorized: space "${spaceId}" not found`);
			}
		} else if (queryName === 'messages.bySession') {
			// Verify the session exists. We intentionally do not restrict by
			// session type (users can view their own worker, room_chat, space_chat,
			// task_agent, etc. sessions), and the WebSocket clientId check above
			// already requires an active connection.
			const targetSessionId = params[0] as string;
			if (typeof targetSessionId !== 'string' || targetSessionId.length === 0) {
				throw new Error('Unauthorized: messages.bySession requires a non-empty sessionId');
			}
			if (!stmtSession.get(targetSessionId)) {
				throw new Error(`Unauthorized: session "${targetSessionId}" not found`);
			}
			// Validate the limit parameter is a positive integer so bad input
			// (e.g. NaN, negative numbers) doesn't silently produce an empty result
			// set that the client would interpret as "no messages".
			const limit = params[1];
			if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > 10000) {
				throw new Error(
					`Unauthorized: messages.bySession limit must be an integer in [1, 10000], got ${String(limit)}`
				);
			}
		}

		// 5. Get or create client subscription map
		let clientSubs = subscriptions.get(clientId);
		if (!clientSubs) {
			clientSubs = new Map();
			subscriptions.set(clientId, clientSubs);
		}

		// 6. Handle subscriptionId collision — dispose existing handle silently
		const existing = clientSubs.get(subscriptionId);
		if (existing) {
			log.debug(
				`liveQuery.subscribe: replacing subscription ${subscriptionId} for client ${clientId}`
			);
			existing.dispose();
			clientSubs.delete(subscriptionId);
		}

		// 7. Subscribe to LiveQueryEngine
		const { sql, mapRow } = namedQuery;
		const applyMapRow = (row: Record<string, unknown>) => (mapRow ? mapRow(row) : row);
		const applyMapRows = (rows: Record<string, unknown>[]) => rows.map(applyMapRow);

		// Track whether the synchronous snapshot delivery failed so we can
		// dispose the handle after subscribe() returns.  The snapshot is fired
		// inside liveQueries.subscribe() before it returns the handle, so we
		// cannot call handle.dispose() directly during the callback.
		let snapshotDeliveryFailed = false;

		const handle = liveQueries.subscribe(
			sql,
			params,
			(diff: QueryDiff<Record<string, unknown>>) => {
				const router = messageHub.getRouter();
				if (!router) {
					// Router not yet registered or already torn down.  Mark snapshot
					// as failed so the handle is disposed after subscribe() returns;
					// for deltas this is a no-op since the engine will never fire
					// another callback after the handle is disposed.
					log.warn(
						`liveQuery: router unavailable; skipping event (clientId=${clientId}, subscriptionId=${subscriptionId})`
					);
					if (diff.type === 'snapshot') {
						snapshotDeliveryFailed = true;
					}
					return;
				}

				// Metadata is computed by LiveQueryEngine once per cached query
				// evaluation so identical subscriptions share expensive sidecars
				// like the compact task feed's active-turn aggregation.
				const metadata = diff.metadata;

				let message: ReturnType<typeof createEventMessage>;

				if (diff.type === 'snapshot') {
					const eventData: LiveQuerySnapshotEvent = {
						subscriptionId,
						rows: applyMapRows(diff.rows),
						version: diff.version,
						...(metadata ? { metadata } : {}),
					};
					message = createEventMessage({
						method: 'liveQuery.snapshot',
						data: eventData,
						sessionId,
					});
				} else {
					const eventData: LiveQueryDeltaEvent = {
						subscriptionId,
						added: diff.added ? applyMapRows(diff.added) : undefined,
						removed: diff.removed ? applyMapRows(diff.removed) : undefined,
						updated: diff.updated ? applyMapRows(diff.updated) : undefined,
						version: diff.version,
						...(metadata ? { metadata } : {}),
					};
					message = createEventMessage({
						method: 'liveQuery.delta',
						data: eventData,
						sessionId,
					});
				}

				const sent = router.sendToClient(clientId, message);
				if (!sent) {
					if (diff.type === 'snapshot') {
						// handle not yet assigned; defer cleanup to after subscribe() returns
						snapshotDeliveryFailed = true;
						log.warn(
							`liveQuery: snapshot delivery failed for client ${clientId}; subscription ${subscriptionId} will be disposed`
						);
					} else {
						// Delta: client disconnected — dispose now (handle is assigned)
						log.warn(
							`liveQuery: delta delivery failed for client ${clientId}; disposing subscription ${subscriptionId}`
						);
						handle.dispose();
						const subs = subscriptions.get(clientId);
						if (subs) {
							subs.delete(subscriptionId);
							if (subs.size === 0) subscriptions.delete(clientId);
						}
					}
				}
			},
			{
				debounceMs: namedQuery.debounceMs,
				getMetadata: namedQuery.mapResult,
				scopeFilter: namedQuery.buildScopeFilter?.(params, db),
			}
		);

		// If snapshot delivery failed (no router or client not found), clean up
		// immediately and return ok — this is not a protocol error from the
		// client's perspective.
		if (snapshotDeliveryFailed) {
			handle.dispose();
			return { ok: true } satisfies LiveQuerySubscribeResponse;
		}

		// 8. Track the handle
		clientSubs.set(subscriptionId, handle);
		log.debug(
			`liveQuery.subscribe: registered subscription ${subscriptionId} for client ${clientId}, query=${queryName}`
		);

		return { ok: true } satisfies LiveQuerySubscribeResponse;
	});

	// -------------------------------------------------------------------------
	// liveQuery.unsubscribe
	// -------------------------------------------------------------------------

	messageHub.onRequest('liveQuery.unsubscribe', (data, context) => {
		const { subscriptionId } = data as LiveQueryUnsubscribeRequest;
		const { clientId } = context;

		if (!clientId) {
			throw new Error('liveQuery.unsubscribe requires a WebSocket connection (clientId absent)');
		}

		const clientSubs = subscriptions.get(clientId);
		const handle = clientSubs?.get(subscriptionId);
		if (handle) {
			handle.dispose();
			clientSubs!.delete(subscriptionId);
			if (clientSubs!.size === 0) subscriptions.delete(clientId);
			log.debug(
				`liveQuery.unsubscribe: disposed subscription ${subscriptionId} for client ${clientId}`
			);
		} else {
			log.debug(
				`liveQuery.unsubscribe: subscription ${subscriptionId} not found for client ${clientId}`
			);
		}

		return { ok: true } satisfies LiveQueryUnsubscribeResponse;
	});

	// -------------------------------------------------------------------------
	// Client disconnect cleanup
	// -------------------------------------------------------------------------

	const unsubDisconnect = messageHub.onClientDisconnect((disconnectedClientId) => {
		const clientSubs = subscriptions.get(disconnectedClientId);
		if (!clientSubs || clientSubs.size === 0) return;

		log.debug(
			`liveQuery: client ${disconnectedClientId} disconnected; disposing ${clientSubs.size} subscription(s)`
		);
		for (const [, handle] of clientSubs) {
			handle.dispose();
		}
		subscriptions.delete(disconnectedClientId);
	});

	// -------------------------------------------------------------------------
	// Cleanup function
	// -------------------------------------------------------------------------

	return () => {
		// Dispose all active handles before unregistering the disconnect listener.
		// This ensures handles are cleaned up against the live engine before it
		// may be disposed by the caller (e.g., createDaemonApp shutdown sequence).
		for (const [, clientSubs] of subscriptions) {
			for (const [, handle] of clientSubs) {
				handle.dispose();
			}
		}
		subscriptions.clear();
		unsubDisconnect();
	};
}
