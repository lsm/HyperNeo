import type {
  LiveQueryDeltaEvent,
  LiveQuerySnapshotEvent,
  LiveQuerySubscribeRequest,
  LiveQuerySubscribeResponse,
  LiveQueryUnsubscribeRequest,
  LiveQueryUnsubscribeResponse,
  MessageHub,
} from '@hyperneo/shared';
import {
  createEventMessage,
  ErrorCode,
  MessageHubHandlerError,
  parseJson,
  parseJsonOptional,
  sendStatusToDeliveryStatus,
} from '@hyperneo/shared';
import { HIDDEN_SYSTEM_SUBTYPES } from '@hyperneo/shared/sdk/type-guards';
import type { LiveQueryEngine, LiveQueryHandle, QueryDiff } from '../../storage/live-query';
import type { TableChangeScope } from '../../storage/reactive-database';
import type { Database as BunDatabase } from '../../storage/sqlite-compat';
import { Logger } from '../logger';
import { mapActiveTurnEntryRow } from './activity-preview';

export { buildActiveTurnSummariesFromRows } from './activity-preview';

export interface NamedQuery {
  sql: string;
  paramCount: number;
  debounceMs?: number;
  mapRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  mapResult?: (
    rawRows: Record<string, unknown>[],
    params: ReadonlyArray<unknown>
  ) => Record<string, unknown> | undefined;
  buildScopeFilter?: (
    params: ReadonlyArray<unknown>,
    db: BunDatabase
  ) => ((scope: TableChangeScope) => boolean) | undefined;
  rowFingerprint?: (row: Record<string, unknown>) => unknown;
}

const DEBOUNCE_SDK_MESSAGES_MS = 250;
const DEBOUNCE_SESSION_GROUP_MESSAGES_MS = 150;
const DEBOUNCE_SESSION_LIST_MS = 150;
const DEBOUNCE_SPACE_SESSIONS_MS = 150;
const DEBOUNCE_SPACE_TASK_FEEDS_MS = 250;

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
  const insOrder = typeof row.insOrder === 'number' ? row.insOrder : null;
  const messageType = String(row.messageType ?? 'status');
  const createdAt = Number(row.createdAt ?? Date.now());
  const rawId = row.id;
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : `row-${createdAt}`;
  const parentToolUseId = typeof row.parentToolUseId === 'string' ? row.parentToolUseId : null;
  const turnUserMessageId =
    typeof row.turnUserMessageId === 'string' ? row.turnUserMessageId : null;
  const origin = typeof row.origin === 'string' ? row.origin : null;
  const deliveryState =
    messageType === 'user' && typeof row.deliveryState === 'string' ? row.deliveryState : null;
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
    insOrder,
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

function mapMcpServerRow(row: Record<string, unknown>): Record<string, unknown> {
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

  const rateLimitCooldown =
    row.processingStatus === 'rate_limit_cooldown'
      ? buildRateLimitCooldown(row.retryCount, row.maxRetries, row.retryAt)
      : null;

  const sessionError = parseSessionError(row.sessionError);

  const {
    retryCount: _retryCount,
    maxRetries: _maxRetries,
    retryAt: _retryAt,
    sessionError: _sessionErrorRaw,
    completionSummary: _completionSummary,
    ...rest
  } = row;

  return {
    ...rest,
    kind,
    rateLimitCooldown,
    sessionError,
    nodeExecution:
      kind === 'node_agent'
        ? {
            nodeExecutionId: row.nodeExecutionId,
            nodeId: row.workflowNodeId,
            agentName: row.agentName,
            status: row.executionStatus,
            result: row.executionResult ?? null,
            isCurrentPostApproval: row.isCurrentPostApproval === 1,
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

function buildRateLimitCooldown(
  retryCount: unknown,
  maxRetries: unknown,
  retryAt: unknown
): { retryCount: number; maxRetries: number; retryAt: number } | null {
  const rc = toFiniteNumber(retryCount);
  const mr = toFiniteNumber(maxRetries);
  const at = toFiniteNumber(retryAt);
  if (rc === null || mr === null || at === null) return null;
  return { retryCount: rc, maxRetries: mr, retryAt: at };
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseSessionError(value: unknown): {
  category: string;
  message: string;
  providerId?: string | null;
} | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as {
      category?: unknown;
      message?: unknown;
      providerId?: unknown;
    };
    if (typeof parsed.category !== 'string' || !parsed.category) return null;
    return {
      category: parsed.category,
      message: typeof parsed.message === 'string' ? parsed.message : '',
      ...(typeof parsed.providerId === 'string' ? { providerId: parsed.providerId } : {}),
    };
  } catch {
    return null;
  }
}

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
  updated_at       AS updatedAt,
  last_activity_at AS lastActivityAt
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
session_node_exec AS (
  SELECT
    ne.id,
    ne.workflow_run_id,
    ne.agent_session_id,
    ne.agent_id,
    ne.agent_name,
    ne.workflow_node_id,
    ROW_NUMBER() OVER (
      PARTITION BY ne.workflow_run_id, ne.agent_session_id
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
  FROM node_executions ne
  JOIN target_task tt ON tt.workflow_run_id = ne.workflow_run_id
  WHERE ne.agent_session_id IS NOT NULL
),
task_sdk_messages AS MATERIALIZED (
  SELECT
    sm.*,
    COALESCE(sm.sdk_uuid, sm.id) AS resolved_sdk_uuid,
    -- Post-approval worker sessions (e.g. the merger) carry no
    -- node_executions row, so the session_node_exec LEFT JOIN downstream
    -- yields NULL and the row would otherwise collapse to the display
    -- placeholder 'agent'. Their identity is persisted on the session row
    -- under metadata.promptProvenance (agent slot name, node id/name,
    -- agent id) — the canonical runtime identity stamped at spawn — so
    -- extract it here as a fallback for agent name / label / nodeId. NULL
    -- for sessions without provenance (e.g. the Task Agent), which keep
    -- their existing attribution.
    json_extract(s_meta.metadata, '$.promptProvenance.agentName') AS provenance_agent_name,
    json_extract(s_meta.metadata, '$.promptProvenance.agentId') AS provenance_agent_id,
    json_extract(s_meta.metadata, '$.promptProvenance.nodeId') AS provenance_node_id,
    json_extract(s_meta.metadata, '$.promptProvenance.nodeName') AS provenance_node_name
  FROM target_task tt
  JOIN sdk_messages sm ON sm.task_id = tt.id
  LEFT JOIN sessions s_meta ON s_meta.id = sm.session_id
),
task_sessions AS MATERIALIZED (
  SELECT DISTINCT session_id
  FROM task_sdk_messages
),
replacement_edges AS MATERIALIZED (
  SELECT
    replacement.source_message_id AS source_id,
    replacement.session_id,
    replacement.target_uuid,
    CASE replacement.kind WHEN 'retracted' THEN 2 ELSE 1 END AS priority
  FROM task_sessions ts
  JOIN sdk_message_replacements replacement
    ON replacement.session_id = ts.session_id
),
sdk_replacement_status AS (
  SELECT
    sm.id,
    CASE MAX(edge.priority)
      WHEN 2 THEN 'retracted'
      WHEN 1 THEN 'superseded'
      ELSE NULL
    END AS replacementStatus
  FROM task_sdk_messages sm
  LEFT JOIN replacement_edges edge
    ON edge.session_id = sm.session_id
   AND edge.source_id != sm.id
   AND edge.target_uuid = sm.resolved_sdk_uuid
  GROUP BY sm.id
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
      'label', CASE WHEN sm.origin = 'human' THEN 'Human' WHEN sm.origin = 'system' THEN 'System' ELSE COALESCE(sa.name, ne.agent_name, sm.provenance_agent_name, 'Agent') END,
      'role', CASE WHEN sm.origin = 'human' THEN 'human' WHEN sm.origin = 'system' THEN 'system' ELSE COALESCE(ne.agent_name, sm.provenance_agent_name, 'agent') END,
      'sessionId', sm.session_id,
      'nodeExecutionId', ne.id,
      'nodeId', COALESCE(ne.workflow_node_id, sm.provenance_node_id),
      'nodeName', sm.provenance_node_name
    ) AS fromActor,
    CASE
      WHEN sm.message_type = 'user' THEN json_object(
        'kind', 'worker',
        'label', COALESCE(sa.name, ne.agent_name, sm.provenance_agent_name, 'Agent'),
        'role', COALESCE(ne.agent_name, sm.provenance_agent_name, 'agent'),
        'sessionId', sm.session_id,
        'nodeExecutionId', ne.id,
        'nodeId', COALESCE(ne.workflow_node_id, sm.provenance_node_id),
        'nodeName', sm.provenance_node_name
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
      WHEN srs.replacementStatus = 'retracted' THEN 'Retracted ' ||
        CASE
          WHEN sm.message_type = 'user' AND sm.origin = 'human' THEN 'Question'
          WHEN sm.message_type = 'user' THEN 'Handoff'
          WHEN sm.message_type = 'result' THEN 'Status'
          WHEN sm.message_type = 'assistant' THEN 'Answer'
          ELSE 'System event'
        END
      WHEN srs.replacementStatus = 'superseded' THEN 'Superseded ' ||
        CASE
          WHEN sm.message_type = 'user' AND sm.origin = 'human' THEN 'Question'
          WHEN sm.message_type = 'user' THEN 'Handoff'
          WHEN sm.message_type = 'result' THEN 'Status'
          WHEN sm.message_type = 'assistant' THEN 'Answer'
          ELSE 'System event'
        END
      WHEN sm.message_type = 'user' AND sm.origin = 'human' THEN 'Question'
      WHEN sm.message_type = 'user' THEN 'Handoff'
      WHEN sm.message_type = 'result' THEN 'Status'
      WHEN sm.message_type = 'assistant' THEN 'Answer'
      WHEN sm.message_type = 'system' AND sm.message_subtype = 'api_retry' THEN 'API retry'
      WHEN sm.message_type = 'system' AND sm.message_subtype = 'session_state_changed' THEN 'Session state'
      WHEN sm.message_type = 'system' AND sm.message_subtype = 'commands_changed' THEN 'Commands changed'
      WHEN sm.message_type = 'system' AND sm.message_subtype = 'informational' THEN
        CASE
          WHEN (CASE WHEN json_valid(sm.sdk_message) THEN json_extract(sm.sdk_message, '$.level') END) = 'warning' THEN 'Warning'
          WHEN (CASE WHEN json_valid(sm.sdk_message) THEN json_extract(sm.sdk_message, '$.level') END) = 'suggestion' THEN 'Suggestion'
          WHEN (CASE WHEN json_valid(sm.sdk_message) THEN json_extract(sm.sdk_message, '$.level') END) = 'notice' THEN 'Notice'
          ELSE 'Informational'
        END
      ELSE 'System event'
    END AS title,
    CASE
      WHEN sm.message_type = 'result' THEN 'Agent turn finished'
      WHEN sm.message_type = 'assistant' THEN 'Agent response recorded'
      WHEN sm.message_type = 'user' AND sm.send_status = 'failed' AND sm.origin = 'human' THEN 'Human message failed'
      WHEN sm.message_type = 'user' AND sm.send_status = 'failed' THEN 'Actor message failed'
      WHEN sm.message_type = 'user' AND sm.origin = 'human' THEN 'Human message delivered'
      WHEN sm.message_type = 'user' THEN 'Actor message delivered'
      WHEN sm.message_type = 'system' AND sm.message_subtype = 'session_state_changed' THEN
        CASE
          WHEN json_valid(sm.sdk_message) THEN COALESCE(json_extract(sm.sdk_message, '$.state'), 'changed')
          ELSE 'Session state changed'
        END
      WHEN sm.message_type = 'system' AND sm.message_subtype = 'commands_changed' THEN
        CASE
          WHEN json_valid(sm.sdk_message) THEN
            printf(
              '%d slash commands available',
              COALESCE(json_array_length(json_extract(sm.sdk_message, '$.commands')), 0)
            )
          ELSE 'Slash commands changed'
        END
      WHEN sm.message_type = 'system' AND sm.message_subtype = 'informational' THEN
        CASE
          WHEN json_valid(sm.sdk_message) THEN COALESCE(json_extract(sm.sdk_message, '$.content'), 'System notice')
          ELSE 'System notice'
        END
      WHEN sm.message_type = 'system' AND sm.message_subtype = 'api_retry' THEN
        CASE
          WHEN json_valid(sm.sdk_message) THEN
            printf(
              'Attempt %d/%d, delay %dms, status %s%s',
              COALESCE(json_extract(sm.sdk_message, '$.attempt'), 1),
              COALESCE(json_extract(sm.sdk_message, '$.max_retries'), '?'),
              COALESCE(json_extract(sm.sdk_message, '$.retry_delay_ms'), 0),
              COALESCE(json_extract(sm.sdk_message, '$.error_status'), 'unknown'),
              CASE
                WHEN json_valid(sm.sdk_message) AND json_extract(sm.sdk_message, '$.error') IS NOT NULL THEN
                  printf(': %s', SUBSTR(json_extract(sm.sdk_message, '$.error'), 1, 50))
                ELSE ''
              END
            )
          ELSE 'API retry'
        END
      ELSE sm.message_type
    END AS summary,
    CASE
      WHEN srs.replacementStatus = 'retracted' THEN 'Retracted by a later model fallback.'
      WHEN srs.replacementStatus = 'superseded' THEN 'Superseded by a later SDK message.'
      ELSE NULL
    END AS details,
    CASE
      WHEN sm.message_type = 'user' AND sm.send_status = 'failed' THEN 'error'
      WHEN srs.replacementStatus IS NOT NULL THEN 'warning'
      ELSE 'info'
    END AS severity,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt
  FROM target_task tt
  JOIN task_sdk_messages sm ON sm.task_id = tt.id
  LEFT JOIN session_node_exec ne
    ON ne.workflow_run_id = tt.workflow_run_id
   AND ne.agent_session_id = sm.session_id
   AND ne.rn = 1
  -- Resolve the display agent (space_agents.name) via the execution's agent
  -- id when present, else the post-approval worker's provenance agent id, so
  -- the merger shows 'PR Merger' rather than collapsing to 'Agent'.
  LEFT JOIN space_agents sa
    ON sa.id = COALESCE(ne.agent_id, sm.provenance_agent_id)
  LEFT JOIN sdk_replacement_status srs ON srs.id = sm.id
  WHERE (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
    AND (
      sm.message_type != 'system'
      OR sm.message_subtype_norm != 'informational'
      OR NOT json_valid(sm.sdk_message)
      OR COALESCE(
        CASE
          WHEN json_valid(sm.sdk_message) THEN json_extract(sm.sdk_message, '$.level')
        END,
        ''
      ) != 'info'
    )
    AND (
      sm.message_type != 'system'
      OR sm.message_subtype_norm != 'worker_shutting_down'
      OR NOT EXISTS (
        SELECT 1
        FROM sdk_messages newer
        WHERE newer.session_id = sm.session_id
          AND newer.task_id = sm.task_id
          AND newer.parent_tool_use_id IS NULL
          AND (
            newer.timestamp > sm.timestamp
            OR (newer.timestamp = sm.timestamp AND newer.id > sm.id)
          )
          AND (newer.message_type != 'user' OR COALESCE(newer.send_status, 'consumed') IN ('consumed', 'failed'))
      )
    )
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
    COALESCE(pm.last_attempt_at, pm.delivered_at, pm.created_at) AS createdAt
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
    CASE WHEN ge.state = 'failed' THEN 'failed' ELSE 'delivered' END AS deliveryState,
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
WITH node_status_events AS (
  SELECT 'in_progress' AS status, 'handoff' AS eventKind, 'Node handoff' AS title, 0 AS rank
  UNION ALL SELECT 'idle', 'status', 'Node completed', 1
  UNION ALL SELECT 'done', 'status', 'Node completed', 1
  UNION ALL SELECT 'blocked', 'status', 'Node status', 1
  UNION ALL SELECT 'cancelled', 'status', 'Node status', 1
  UNION ALL SELECT 'waiting_rebind', 'retry', 'Node status', 1
  UNION ALL SELECT 'pending', 'status', 'Node status', 0
),
node_rows AS (
  SELECT
    'node:' || ne.id || ':' || nse.status AS id,
    'workflow_log' AS scope,
    nse.eventKind AS eventKind,
    (SELECT st.id FROM space_tasks st WHERE st.workflow_run_id = ne.workflow_run_id ORDER BY st.created_at ASC, st.id ASC LIMIT 1) AS taskId,
    (SELECT st.title FROM space_tasks st WHERE st.workflow_run_id = ne.workflow_run_id ORDER BY st.created_at ASC, st.id ASC LIMIT 1) AS taskTitle,
    ne.workflow_run_id AS workflowRunId,
    NULL AS messageId,
    ne.id AS eventRef,
    json_object('kind', 'system', 'label', 'Workflow runtime', 'role', 'runtime') AS fromActor,
    json_object('kind', 'worker', 'label', COALESCE(sa.name, ne.agent_name), 'role', ne.agent_name, 'sessionId', ne.agent_session_id, 'nodeExecutionId', ne.id) AS targetActor,
    'system' AS targetResolution,
    NULL AS deliveryState,
    nse.title AS title,
    ne.agent_name || ' is ' || nse.status AS summary,
    CASE WHEN nse.status = ne.status THEN ne.result ELSE NULL END AS details,
    CASE WHEN nse.status IN ('blocked', 'cancelled') THEN 'warning' WHEN nse.status IN ('idle', 'done') THEN 'success' ELSE 'info' END AS severity,
    CASE
      WHEN nse.status IN ('idle', 'done', 'blocked', 'cancelled') THEN COALESCE(ne.completed_at, ne.updated_at, ne.created_at)
      WHEN nse.status IN ('waiting_rebind', 'pending') THEN COALESCE(ne.updated_at, ne.started_at, ne.created_at)
      ELSE COALESCE(ne.started_at, ne.created_at)
    END AS createdAt
  FROM node_executions ne
  JOIN node_status_events nse
    ON nse.status = ne.status
    OR (nse.status = 'in_progress' AND ne.status IN ('idle', 'done', 'blocked', 'cancelled', 'waiting_rebind'))
  LEFT JOIN space_agents sa ON sa.id = ne.agent_id
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
    (SELECT st.id FROM space_tasks st WHERE st.workflow_run_id = wra.run_id ORDER BY st.created_at ASC, st.id ASC LIMIT 1) AS taskId,
    (SELECT st.title FROM space_tasks st WHERE st.workflow_run_id = wra.run_id ORDER BY st.created_at ASC, st.id ASC LIMIT 1) AS taskTitle,
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
  WHERE wra.run_id = ?
)
SELECT * FROM node_rows
UNION ALL SELECT * FROM delivery_rows
UNION ALL SELECT * FROM artifact_rows
ORDER BY createdAt ASC, id ASC
`.trim();

const TASK_MILESTONES_BY_TASK_SQL = `
WITH target_task AS (
  SELECT * FROM space_tasks WHERE id = ?
),
session_node_exec AS (
  SELECT
    ne.id,
    ne.workflow_run_id,
    ne.agent_session_id,
    ne.agent_id,
    ne.agent_name,
    ne.workflow_node_id,
    ROW_NUMBER() OVER (
      PARTITION BY ne.workflow_run_id, ne.agent_session_id
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
  FROM node_executions ne
  JOIN target_task tt ON tt.workflow_run_id = ne.workflow_run_id
  WHERE ne.agent_session_id IS NOT NULL
),
task_sdk_messages AS MATERIALIZED (
  SELECT
    sm.*,
    COALESCE(sm.sdk_uuid, sm.id) AS resolved_sdk_uuid,
    -- Post-approval worker sessions (e.g. the merger) carry no
    -- node_executions row, so the session_node_exec LEFT JOIN downstream
    -- yields NULL and the row would otherwise collapse to the display
    -- placeholder 'agent'. Their identity is persisted on the session row
    -- under metadata.promptProvenance (agent slot name, node id/name,
    -- agent id) — the canonical runtime identity stamped at spawn — so
    -- extract it here as a fallback for agent name / label / nodeId. NULL
    -- for sessions without provenance (e.g. the Task Agent), which keep
    -- their existing attribution.
    json_extract(s_meta.metadata, '$.promptProvenance.agentName') AS provenance_agent_name,
    json_extract(s_meta.metadata, '$.promptProvenance.agentId') AS provenance_agent_id,
    json_extract(s_meta.metadata, '$.promptProvenance.nodeId') AS provenance_node_id,
    json_extract(s_meta.metadata, '$.promptProvenance.nodeName') AS provenance_node_name
  FROM target_task tt
  JOIN sdk_messages sm ON sm.task_id = tt.id
  LEFT JOIN sessions s_meta ON s_meta.id = sm.session_id
),
task_sessions AS MATERIALIZED (
  SELECT DISTINCT session_id
  FROM task_sdk_messages
),
replacement_edges AS MATERIALIZED (
  SELECT
    replacement.source_message_id AS source_id,
    replacement.session_id,
    replacement.target_uuid,
    CASE replacement.kind WHEN 'retracted' THEN 2 ELSE 1 END AS priority
  FROM task_sessions ts
  JOIN sdk_message_replacements replacement
    ON replacement.session_id = ts.session_id
),
sdk_replacement_status AS (
  SELECT
    sm.id,
    CASE MAX(edge.priority)
      WHEN 2 THEN 'retracted'
      WHEN 1 THEN 'superseded'
      ELSE NULL
    END AS replacementStatus
  FROM task_sdk_messages sm
  LEFT JOIN replacement_edges edge
    ON edge.session_id = sm.session_id
   AND edge.source_id != sm.id
   AND edge.target_uuid = sm.resolved_sdk_uuid
  GROUP BY sm.id
),
-- Status anchors are derived from the task's lifecycle timestamp columns rather
-- than an append-only event log (none exists — space_goal_events is goal-scoped).
-- Trade-off: when a blocked/cancelled task is resumed, updateTask overwrites
-- started_at and clears completed_at, so the prior terminal milestone drops and
-- the start time moves. This reflects the current snapshot, not full history; a
-- proper transition log is a separate, larger piece of work.
lifecycle AS (
  SELECT
    'task:created' AS id, tt.id AS taskId, 'creation' AS category, 'info' AS tone,
    'Task created' AS title, NULL AS body, tt.created_by AS sourceLabel,
    CASE WHEN tt.created_by IS NULL THEN 'system' ELSE 'agent' END AS sourceKind,
    NULL AS sourceId, tt.created_at AS createdAt
  FROM target_task tt
  UNION ALL
  SELECT
    'task:started', tt.id, 'status', 'progress', 'Work started', NULL,
    NULL, 'system', NULL, tt.started_at
  FROM target_task tt WHERE tt.started_at IS NOT NULL
  UNION ALL
  SELECT
    'task:review', tt.id, 'status', 'warning', 'Submitted for review',
    tt.pending_completion_reason, NULL, 'review', NULL,
    tt.pending_completion_submitted_at
  FROM target_task tt WHERE tt.pending_completion_submitted_at IS NOT NULL
  UNION ALL
  SELECT
    'task:approved', tt.id, 'status', 'success', 'Approved',
    tt.approval_reason, tt.approval_source, 'review', NULL, tt.approved_at
  FROM target_task tt WHERE tt.approved_at IS NOT NULL
  UNION ALL
  SELECT
    'task:completed', tt.id, 'status',
    CASE WHEN tt.status = 'cancelled' THEN 'danger' ELSE 'success' END,
    CASE WHEN tt.status = 'cancelled' THEN 'Cancelled' ELSE 'Completed' END,
    -- A successful completion shows the task's canonical result (SpaceTask.result,
    -- backfilled from reportedSummary); a cancellation shows its reason (the
    -- cancel handler persists the supplied reason in approval_reason).
    CASE
      WHEN tt.status = 'cancelled' THEN NULLIF(SUBSTR(COALESCE(tt.approval_reason, ''), 1, 500), '')
      ELSE NULLIF(SUBSTR(COALESCE(tt.result, ''), 1, 500), '')
    END,
    NULL, 'system', NULL, tt.completed_at
  -- Only emit for statuses the title logic represents. updateTask clears
  -- completed_at only on open/in_progress, so a surviving completed_at during a
  -- non-terminal status (e.g. a blocked→review transition, which is permitted)
  -- must not render a green Completed beside Submitted for review / Approved.
  FROM target_task tt
  WHERE tt.completed_at IS NOT NULL AND tt.status IN ('done', 'cancelled')
  UNION ALL
  SELECT
    'task:blocked', tt.id, 'status', 'warning', 'Blocked', tt.block_reason,
    NULL, 'system', NULL, COALESCE(tt.completed_at, tt.updated_at)
  -- Keyed on status, not completed_at: runtime blocks like prompt-overflow pass
  -- completedAt: null (updateTask applies it after the auto-stamp), so a blocked
  -- task can have completed_at = NULL. Date it at completed_at when present,
  -- else the last update.
  FROM target_task tt WHERE tt.status = 'blocked'
  UNION ALL
  SELECT
    'task:archived', tt.id, 'status', 'neutral', 'Archived', NULL, NULL, 'system', NULL,
    tt.archived_at
  FROM target_task tt WHERE tt.archived_at IS NOT NULL
),
instruction_candidates AS (
  SELECT
    'instruction:' || sm.id AS id,
    tt.id AS taskId,
    'instruction' AS category,
    CASE WHEN sm.send_status = 'failed' THEN 'danger' ELSE 'info' END AS tone,
    CASE WHEN sm.send_status = 'failed' THEN 'Instruction failed to send' ELSE 'Instruction' END AS title,
    SUBSTR(
      CASE
        WHEN json_valid(sm.sdk_message) AND json_type(sm.sdk_message, '$.message.content') = 'text'
          THEN json_extract(sm.sdk_message, '$.message.content')
        WHEN json_valid(sm.sdk_message) AND json_type(sm.sdk_message, '$.message.content') = 'array' THEN (
          SELECT GROUP_CONCAT(json_extract(je.value, '$.text'), ' ')
          FROM json_each(json_extract(sm.sdk_message, '$.message.content')) je
          WHERE json_extract(je.value, '$.type') = 'text'
            AND COALESCE(json_extract(je.value, '$.text'), '') != ''
        )
        ELSE ''
      END,
    1, 500) AS body,
    'Human' AS sourceLabel,
    'human' AS sourceKind,
    NULL AS sourceId,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt
  FROM target_task tt
  JOIN task_sdk_messages sm ON sm.task_id = tt.id
  LEFT JOIN sdk_replacement_status srs ON srs.id = sm.id
  WHERE sm.message_type = 'user'
    -- A human instruction is any non-synthetic user message. The task-panel
    -- send path persists with origin=NULL (not 'human'), so origin alone can't
    -- identify human input; the message's isSynthetic flag is the reliable
    -- discriminator (space.task.sendMessage passes false; agent send_message
    -- and runtime injects pass true). origin != 'system' is a legacy-data
    -- fallback for older synthetic rows that may predate isSynthetic.
    AND COALESCE(sm.origin, '') != 'system'
    -- Guard json_extract: one malformed sdk_message row would otherwise raise
    -- "malformed JSON" and abort the entire query. json_valid short-circuits AND,
    -- so corrupt rows are simply excluded rather than blanking the whole timeline.
    AND json_valid(sm.sdk_message)
    AND COALESCE(CAST(json_extract(sm.sdk_message, '$.isSynthetic') AS INTEGER), 0) = 0
    AND srs.replacementStatus IS NULL
    AND (sm.send_status IS NULL OR sm.send_status IN ('consumed', 'failed'))
),
instruction_rows AS (
  SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt
  FROM instruction_candidates
  WHERE body IS NOT NULL AND body != ''
),
answer_candidates AS (
  SELECT
    'answer:' || sm.id AS id,
    tt.id AS taskId,
    'answer' AS category,
    'neutral' AS tone,
    'Answer' AS title,
    SUBSTR((
      SELECT GROUP_CONCAT(json_extract(je.value, '$.text'), ' ')
      FROM json_each(json_extract(sm.sdk_message, '$.message.content')) je
      WHERE json_extract(je.value, '$.type') = 'text'
        AND COALESCE(json_extract(je.value, '$.text'), '') != ''
    ), 1, 500) AS body,
    COALESCE(sa.name, ne.agent_name, sm.provenance_agent_name, 'Agent') AS sourceLabel,
    'agent' AS sourceKind,
    sm.session_id AS sourceId,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt
  FROM target_task tt
  JOIN task_sdk_messages sm ON sm.task_id = tt.id
  LEFT JOIN session_node_exec ne
    ON ne.workflow_run_id = tt.workflow_run_id
   AND ne.agent_session_id = sm.session_id
   AND ne.rn = 1
  LEFT JOIN space_agents sa
    ON sa.id = COALESCE(ne.agent_id, sm.provenance_agent_id)
  LEFT JOIN sdk_replacement_status srs ON srs.id = sm.id
  WHERE sm.message_type = 'assistant'
    AND json_valid(sm.sdk_message)
    AND json_type(sm.sdk_message, '$.message.content') = 'array'
    -- Top-level answers only: nested subagent (Task/Agent tool) assistant
    -- messages carry a parent_tool_use_id and would flood/misattribute the feed.
    AND sm.parent_tool_use_id IS NULL
    AND srs.replacementStatus IS NULL
),
answer_rows AS (
  SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt
  FROM answer_candidates
  WHERE body IS NOT NULL AND body != ''
),
retry_rows AS (
  SELECT
    'retry:' || sm.id AS id,
    tt.id AS taskId,
    'retry' AS category,
    'warning' AS tone,
    'API retry' AS title,
    CASE WHEN json_valid(sm.sdk_message) THEN
      printf('Attempt %s/%s · status %s',
        COALESCE(json_extract(sm.sdk_message, '$.attempt'), 1),
        COALESCE(json_extract(sm.sdk_message, '$.max_retries'), '?'),
        COALESCE(json_extract(sm.sdk_message, '$.error_status'), 'unknown'))
    ELSE 'API retry' END AS body,
    -- Carry the owning agent so the renderer can scope a retry burst to one
    -- worker instead of folding retries from different sessions together.
    COALESCE(sa.name, ne.agent_name, sm.provenance_agent_name, 'Agent') AS sourceLabel,
    'agent' AS sourceKind,
    sm.session_id AS sourceId,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt
  FROM target_task tt
  JOIN task_sdk_messages sm ON sm.task_id = tt.id
  LEFT JOIN session_node_exec ne
    ON ne.workflow_run_id = tt.workflow_run_id
   AND ne.agent_session_id = sm.session_id
   AND ne.rn = 1
  LEFT JOIN space_agents sa
    ON sa.id = COALESCE(ne.agent_id, sm.provenance_agent_id)
  WHERE sm.message_type = 'system'
    AND sm.message_subtype = 'api_retry'
),
artifact_rows AS (
  SELECT
    'artifact:' || wra.id AS id,
    tt.id AS taskId,
    -- Production artifacts use the canonical SHAPE vocabulary (link / commit_set
    -- / check / metric / decision / note) as artifact_type; legacy type names
    -- (pr/result/progress/review) are mapped to a shape by save_artifact before
    -- persisting, so classify by shape (+ data.kind), not legacy type names.
    CASE
      WHEN wra.artifact_type = 'decision'
        AND json_valid(wra.data)
        AND json_extract(wra.data, '$.kind') = 'review'
      THEN 'review'
      ELSE 'artifact'
    END AS category,
    CASE
      -- Notes that record blockers/warnings warrant a warning tone. Modern
      -- audit notes carry the meaning in kind (merge_blocked / merge_conflict
      -- / cleanup_warning); rows backfilled from the legacy freeform type
      -- system carry it under _legacyType. Match either so old and new data
      -- share the tone.
      WHEN wra.artifact_type = 'note'
        AND json_valid(wra.data)
        AND (
          json_extract(wra.data, '$.kind') IN ('merge_blocked', 'merge_conflict', 'cleanup_warning')
          OR json_extract(wra.data, '$._legacyType') IN (
            'merge_blocked', 'merge_conflict_loop', 'cleanup_warning'
          )
        )
      THEN 'warning'
      WHEN wra.artifact_type = 'note' THEN 'progress'
      WHEN wra.artifact_type = 'link' THEN 'success'
      WHEN wra.artifact_type = 'check'
        AND json_valid(wra.data)
        AND json_extract(wra.data, '$.status') IN ('fail', 'failed', 'error')
      THEN 'danger'
      WHEN wra.artifact_type = 'check'
        AND json_valid(wra.data)
        AND json_extract(wra.data, '$.status') IN ('pass', 'passed', 'success')
      THEN 'success'
      WHEN wra.artifact_type = 'decision'
        AND json_valid(wra.data)
        AND json_extract(wra.data, '$.recommendation') IN ('approve', 'approved')
      THEN 'success'
      WHEN wra.artifact_type = 'decision'
        AND json_valid(wra.data)
        AND json_extract(wra.data, '$.recommendation') IN
          ('reject', 'request_changes', 'changes_requested')
      THEN 'danger'
      ELSE 'neutral'
    END AS tone,
    CASE
      WHEN wra.artifact_type = 'link'
        AND json_valid(wra.data)
        AND json_extract(wra.data, '$.kind') = 'pr'
      THEN 'PR'
      WHEN wra.artifact_type = 'link' THEN 'Link'
      WHEN wra.artifact_type = 'decision'
        AND json_valid(wra.data)
        AND json_extract(wra.data, '$.kind') = 'review'
      THEN 'Review decision'
      WHEN wra.artifact_type = 'decision' THEN 'Decision'
      WHEN wra.artifact_type = 'check' THEN 'Check'
      WHEN wra.artifact_type = 'metric' THEN 'Metric'
      WHEN wra.artifact_type = 'note' THEN 'Progress update'
      WHEN wra.artifact_type = 'commit_set' THEN 'Commits'
      ELSE COALESCE(NULLIF(wra.artifact_type, ''), 'Artifact') || ' recorded'
    END AS title,
    CASE
      WHEN wra.artifact_type = 'metric' AND json_valid(wra.data) THEN
        SUBSTR(
          printf('%s: %s', json_extract(wra.data, '$.name'), json_extract(wra.data, '$.value')),
          1, 500
        )
      WHEN wra.artifact_type = 'check' AND json_valid(wra.data) THEN
        SUBSTR(
          printf('%s: %s', json_extract(wra.data, '$.name'), json_extract(wra.data, '$.status')),
          1, 500
        )
      WHEN wra.artifact_type = 'commit_set' AND json_valid(wra.data) THEN
        SUBSTR(
          printf(
            '%d commits on %s',
            COALESCE(json_array_length(json_extract(wra.data, '$.commits')), 0),
            COALESCE(json_extract(wra.data, '$.branch'), '?')
          ),
          1, 500
        )
      WHEN json_valid(wra.data) THEN
        SUBSTR(
          COALESCE(
            json_extract(wra.data, '$.summary'),
            json_extract(wra.data, '$.text'),
            json_extract(wra.data, '$.recommendation'),
            json_extract(wra.data, '$.url'),
            json_extract(wra.data, '$.title'),
            json_extract(wra.data, '$.merged_pr_url'),
            json_extract(wra.data, '$.review_url'),
            json_extract(wra.data, '$.prUrl'),
            json_extract(wra.data, '$.pr_url'),
            json_extract(wra.data, '$.name')
          ),
          1, 500
        )
      ELSE NULL
    END AS body,
    -- The artifact row carries only node_id (a template id / UUID), which is
    -- not a meaningful agent name — omit the producer chip rather than mislabel
    -- the source. The title/body convey what happened.
    NULL AS sourceLabel,
    CASE
      WHEN wra.artifact_type = 'decision'
        AND json_valid(wra.data)
        AND json_extract(wra.data, '$.kind') = 'review'
      THEN 'review'
      ELSE 'agent'
    END AS sourceKind,
    NULL AS sourceId,
    -- Overwrite-style artifacts (e.g. a rolling note) upsert in place:
    -- created_at stays at first write while updated_at advances. Use the later
    -- of the two so the displayed content is dated when it was recorded.
    CASE WHEN wra.updated_at > wra.created_at THEN wra.updated_at ELSE wra.created_at END AS createdAt
  FROM target_task tt
  JOIN workflow_run_artifacts wra ON wra.run_id = tt.workflow_run_id
),
pending_instruction_rows AS (
  SELECT
    'pending:' || pm.id AS id,
    tt.id AS taskId,
    'instruction' AS category,
    CASE WHEN pm.status = 'pending' THEN 'info' ELSE 'danger' END AS tone,
    CASE WHEN pm.status = 'pending' THEN 'Instruction queued' ELSE 'Instruction failed to deliver' END AS title,
    SUBSTR(COALESCE(pm.message, ''), 1, 500) AS body,
    'Human' AS sourceLabel,
    'human' AS sourceKind,
    NULL AS sourceId,
    COALESCE(pm.last_attempt_at, pm.created_at) AS createdAt
  FROM target_task tt
  JOIN pending_agent_messages pm ON pm.task_id = tt.id
  -- A human instruction targeted at an agent that hasn't started is queued here
  -- (source_agent_name='human'); surface pending + failed/expired states. Once
  -- delivered, the flushed sdk_messages row covers it, so exclude 'delivered'.
  WHERE pm.source_agent_name = 'human' AND pm.status IN ('pending', 'failed', 'expired')
),
github_rows AS (
  SELECT
    'github:' || ee.id AS id,
    tt.id AS taskId,
    'github' AS category,
    CASE
      -- The normalizer only ingests failed CI conclusions (success/
      -- skipped/neutral are dropped) and emits them as .check_failed (check_run),
      -- .suite_failed (check_suite), or .status_failure / .status_error
      -- (external/legacy CI — Jenkins/Travis/custom). So any of those topics IS
      -- a CI failure. ee.state is the event-global state (any failed recipient
      -- delivery flips it), so for non-CI events derive the danger tone from
      -- THIS task's own delivery row, not the global event state.
      WHEN ee.topic LIKE '%.check_failed'
        OR ee.topic LIKE '%.suite_failed'
        OR ee.topic LIKE '%.status_failure'
        OR ee.topic LIKE '%.status_error' THEN 'danger'
      WHEN MAX(CASE WHEN d.state = 'failed' THEN 1 ELSE 0 END) = 1 THEN 'danger'
      ELSE 'neutral'
    END AS tone,
    CASE
      WHEN ee.topic LIKE '%.check_failed'
        OR ee.topic LIKE '%.suite_failed'
        OR ee.topic LIKE '%.status_failure'
        OR ee.topic LIKE '%.status_error' THEN 'CI check failed'
      WHEN ee.topic LIKE '%branch_protection_%' THEN 'Branch protection'
      WHEN ee.topic LIKE '%pull_request%review%' THEN 'PR review'
      WHEN ee.topic LIKE '%pull_request%' THEN 'PR update'
      WHEN ee.topic LIKE '%issue%' THEN 'Issue update'
      WHEN ee.topic LIKE '%push%' THEN 'Push'
      ELSE 'GitHub activity'
    END AS title,
    SUBSTR(COALESCE(ee.summary, ''), 1, 500) AS body,
    NULL AS sourceLabel,
    'github' AS sourceKind,
    NULL AS sourceId,
    ee.occurred_at AS createdAt
  FROM target_task tt
  JOIN space_external_event_deliveries d ON d.task_id = tt.id
  JOIN space_external_events ee ON ee.id = d.event_id
  -- Scope to GitHub events explicitly so a future non-GitHub external-event
  -- source can't leak into the feed as "GitHub activity".
  WHERE ee.source = 'github' AND ee.state NOT IN ('ignored', 'ambiguous')
  GROUP BY ee.id, tt.id
)
SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt
FROM (
  SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt FROM lifecycle
  UNION ALL SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt FROM instruction_rows
  UNION ALL SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt FROM pending_instruction_rows
  UNION ALL SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt FROM answer_rows
  UNION ALL SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt FROM retry_rows
  UNION ALL SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt FROM artifact_rows
  UNION ALL SELECT id, taskId, category, tone, title, body, sourceLabel, sourceKind, sourceId, createdAt FROM github_rows
)
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

function mapTaskMilestoneRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id ?? ''),
    taskId: String(row.taskId ?? ''),
    category: row.category ?? 'artifact',
    tone: row.tone ?? 'neutral',
    title: String(row.title ?? ''),
    body: row.body == null ? null : String(row.body),
    sourceLabel: row.sourceLabel == null ? null : String(row.sourceLabel),
    sourceKind: row.sourceKind ?? null,
    sourceId: row.sourceId == null ? null : String(row.sourceId),
    createdAt: Number(row.createdAt ?? 0),
  };
}

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
  -- Task Agent after pause/cancel: stopActiveWorkflowTaskAgents clears
  -- task_agent_session_id (severing the pointer arm above), and the worker
  -- arms below only admit sessions.type = 'worker'. Recover it from durable
  -- task_id-stamped messages so the orchestrator's history stays in the feed.
  -- Redundant while the pointer is live; UNION dedupes by session_id.
  SELECT DISTINCT
    sm.session_id AS session_id,
    tt.id AS task_id,
    tt.title AS task_title,
    tt.status AS task_status
  FROM target_task tt
  JOIN sdk_messages sm ON sm.task_id = tt.id
  JOIN sessions s ON s.id = sm.session_id
  WHERE s.type = 'space_task_agent'
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
  UNION
  -- Post-approval worker session (e.g. the merger). It is spawned without a
  -- node_executions row (intentional — creating one would entangle workflow
  -- completion / activation / retries), so neither arm above surfaces it. Its
  -- declared identity (agent slot, node) is recovered from the session's
  -- promptProvenance in all_sessions below.
  --
  -- Sourced from DURABLE provenance — the worker's sdk_messages joined to its
  -- session — NOT the transient space_tasks.post_approval_session_id pointer,
  -- which SpaceTaskManager.setTaskStatus clears on the approved→done transition
  -- (mark_complete). The pointer arm would drop the worker + its persisted
  -- messages from the feed the moment it finishes. Normal node-agent sessions
  -- are already covered by arm 2 via their node_executions row, so the
  -- NOT EXISTS excludes them and leaves only execution-less workers.
  SELECT DISTINCT
    sm.session_id AS session_id,
    tt.id AS task_id,
    tt.title AS task_title,
    tt.status AS task_status
  FROM target_task tt
  JOIN sdk_messages sm ON sm.task_id = tt.id
  JOIN sessions s ON s.id = sm.session_id
  WHERE s.type = 'worker'
    AND json_extract(s.metadata, '$.promptProvenance.agentName') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM node_executions ne
      WHERE ne.workflow_run_id = tt.workflow_run_id
        AND ne.agent_session_id = sm.session_id
    )
  UNION
  -- Pointer arm: surface the worker the instant it is spawned, before its
  -- first sdk_message is persisted (the durable arm above requires a message).
  -- Redundant once the worker emits; UNION dedupes by session_id.
  SELECT
    tt.post_approval_session_id AS session_id,
    tt.id AS task_id,
    tt.title AS task_title,
    tt.status AS task_status
  FROM target_task tt
  JOIN sessions s ON s.id = tt.post_approval_session_id
  WHERE tt.post_approval_session_id IS NOT NULL
    AND s.type = 'worker'
    AND json_extract(s.metadata, '$.promptProvenance.agentName') IS NOT NULL
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
      -- Post-approval workers have no node_executions row (sne is NULL), so
      -- fall through to the session's promptProvenance.agentName rather than
      -- the display placeholder 'agent'. sa resolves via provenance.agentId.
      ELSE COALESCE(sa.name, sne.agent_name, json_extract(s_kind.metadata, '$.promptProvenance.agentName'), 'agent')
    END AS label,
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'task-agent'
      -- Fall back to a stable string when no node_executions row is
      -- available (e.g. workflow-run cleanup detached the row after the
      -- session emitted messages) — otherwise the mapper retypes the
      -- author as 'system', misattributing genuine node-agent activity.
      -- promptProvenance.agentName covers execution-less post-approval workers.
      ELSE COALESCE(sne.agent_name, json_extract(s_kind.metadata, '$.promptProvenance.agentName'), 'agent')
    END AS role,
    cs.task_id,
    cs.task_title,
    cs.task_status,
    sne.node_execution_id,
    COALESCE(sne.workflow_node_id, json_extract(s_kind.metadata, '$.promptProvenance.nodeId')) AS workflow_node_id,
    COALESCE(sne.agent_name, json_extract(s_kind.metadata, '$.promptProvenance.agentName')) AS agent_name,
    sne.execution_status,
    sne.execution_result,
    sne.execution_updated_at
  FROM contributing_sessions cs
  LEFT JOIN sessions s_kind ON s_kind.id = cs.session_id
  LEFT JOIN session_node_exec sne
    ON sne.task_id = cs.task_id
   AND sne.session_id = cs.session_id
   AND sne.rn = 1
  -- Resolve the display agent via the execution's agent id when present, else
  -- the post-approval worker's provenance agent id, so its label matches what
  -- it would show with an execution row.
  LEFT JOIN space_agents sa
    ON sa.id = COALESCE(sne.agent_id, json_extract(s_kind.metadata, '$.promptProvenance.agentId'))
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
    WHEN json_extract(s.processing_state, '$.status') = 'idle' THEN 'idle'
    WHEN ase.task_status = 'open' THEN 'queued'
    ELSE 'idle'
  END AS state,
  json_extract(s.processing_state, '$.status') AS processingStatus,
  json_extract(s.processing_state, '$.phase') AS processingPhase,
  json_extract(s.processing_state, '$.retryCount') AS retryCount,
  json_extract(s.processing_state, '$.maxRetries') AS maxRetries,
  json_extract(s.processing_state, '$.retryAt') AS retryAt,
  s.last_error AS sessionError,
  COALESCE(ms.messageCount, 0) AS messageCount,
  ase.task_id AS taskId,
  ase.task_title AS taskTitle,
  ase.task_status AS taskStatus,
  ase.node_execution_id AS nodeExecutionId,
  ase.workflow_node_id AS workflowNodeId,
  ase.agent_name AS agentName,
  -- For execution-less post-approval workers re-approved into multiple
  -- sessions, mark the one the task's post_approval_session_id pointer
  -- currently selects so the composer resolves the exact current session
  -- (historical workers are preserved for overlay viewing). 0 when the pointer
  -- is cleared or the member isn't the current worker.
  CASE
    WHEN ase.session_id = (SELECT post_approval_session_id FROM target_task)
     AND (SELECT post_approval_session_id FROM target_task) IS NOT NULL
    THEN 1 ELSE 0
  END AS isCurrentPostApproval,
  ase.execution_result AS executionResult,
  ase.task_id AS currentStep,
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
    NULL AS turnUserMessageId,
    NULL AS insOrder
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
      -- misattributing genuine node-agent messages. The promptProvenance
      -- fallback attributes execution-less post-approval workers (e.g. the
      -- merger) correctly instead of the display placeholder 'agent'.
      ELSE COALESCE(sne.agent_name, json_extract(s_kind.metadata, '$.promptProvenance.agentName'), 'agent')
    END AS role,
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'Task Agent'
      ELSE COALESCE(sa.name, sne.agent_name, json_extract(s_kind.metadata, '$.promptProvenance.agentName'), 'agent')
    END AS label,
    sne.node_execution_id AS nodeExecutionId,
    tt.id AS taskId,
    tt.title AS taskTitle,
    sm.message_type AS messageType,
    sm.sdk_message AS content,
    sm.origin AS origin,
    CASE
      WHEN sm.message_type != 'user' THEN NULL
      WHEN COALESCE(sm.send_status, 'consumed') = 'failed' THEN 'failed'
      WHEN EXISTS (
             SELECT 1
             FROM job_queue jq
             WHERE jq.queue = 'message_delivery'
               AND jq.status IN ('pending', 'processing')
               AND json_extract(jq.payload, '$.sessionId') = sm.session_id
               AND (json_extract(jq.payload, '$.messageUuid') = sm.sdk_uuid
                 OR EXISTS (
                   SELECT 1 FROM json_each(
                     CASE WHEN json_type(jq.payload, '$.batchUuids') = 'array'
                          THEN json_extract(jq.payload, '$.batchUuids') ELSE '[]' END
                   ) AS je WHERE je.value = sm.sdk_uuid
                 ))
               AND jq.retry_count > 0
           )
      THEN 'retrying'
      WHEN COALESCE(sm.send_status, 'consumed') = 'consumed' THEN 'delivered'
      WHEN COALESCE(sm.send_status, 'consumed') = 'submitted' THEN 'processing'
      ELSE 'queued'
    END AS deliveryState,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt,
    sm.parent_tool_use_id AS parentToolUseId,
    sm.is_renderable AS isRenderable,
    sm.is_terminal AS isTerminal,
    -- Insertion order (implicit rowid) appended last for positional UNION
    -- alignment with github_events. Used as the same-millisecond tiebreak in
    -- turn-boundary computation so a hook_response and the result closing the
    -- same turn don't split across a turn boundary by random UUID id.
    sm.rowid AS insOrder
  FROM target_task tt
  JOIN sdk_messages sm ON sm.task_id = tt.id
  LEFT JOIN sessions s_kind ON s_kind.id = sm.session_id
  LEFT JOIN session_node_exec sne
    ON sne.task_id = tt.id
   AND sne.session_id = sm.session_id
   AND sne.rn = 1
  LEFT JOIN space_agents sa
    ON sa.id = COALESCE(sne.agent_id, json_extract(s_kind.metadata, '$.promptProvenance.agentId'))
  WHERE (
      sm.message_type != 'system'
      OR sm.message_subtype_norm != 'informational'
      OR NOT json_valid(sm.sdk_message)
      OR COALESCE(
        CASE
          WHEN json_valid(sm.sdk_message) THEN json_extract(sm.sdk_message, '$.level')
        END,
        ''
      ) != 'info'
    )
    AND (
      sm.message_type != 'system'
      OR sm.message_subtype_norm != 'worker_shutting_down'
      OR NOT EXISTS (
        SELECT 1
        FROM sdk_messages newer
        WHERE newer.session_id = sm.session_id
          AND newer.task_id = sm.task_id
          AND newer.parent_tool_use_id IS NULL
          AND (
            newer.timestamp > sm.timestamp
            OR (newer.timestamp = sm.timestamp AND newer.id > sm.id)
          )
          AND (newer.message_type != 'user' OR COALESCE(newer.send_status, 'consumed') IN ('consumed', 'failed'))
      )
    )
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
  -- TERMINAL user row (consumed/failed); otherwise NULL. Combined with the
  -- MAX() window below this lets us forward-fill the latest user-row position
  -- per session without a per-row correlated subquery or a second ROW_NUMBER()
  -- pass.
  --
  -- Task #862 (review P2): only settled user rows anchor a conversation turn.
  -- A deferred/enqueued/submitted prompt is emitted (for its delivery badge)
  -- but saveUserMessageCore deliberately withholds a new conversation anchor
  -- until the row becomes consumed/failed, so a pending row must NOT become the
  -- turnId that subsequent assistant rows inherit.
  SELECT
    n.*,
    CASE
      WHEN n.messageType = 'user' AND n.deliveryState IN ('delivered', 'failed')
        THEN n.rowPos
      ELSE NULL
    END AS thisUserRowPos
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
    urs.userMessageId AS turnUserMessageId,
    t.insOrder AS insOrder
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
    turnUserMessageId,
    insOrder
  FROM sdk_rows
)
`.trim();

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

export const SPACE_TASK_MESSAGES_COMPACT_RECENT_TURNS = 100;

export const SPACE_TASK_MESSAGES_COMPACT_TOOL_SUMMARY_LIMIT = 3;

const SPACE_TASK_CONV_BASE_CTE = `
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
    NULL AS turnIndex,
    NULL AS insOrder
  FROM target_task tt
  JOIN space_github_events ge ON ge.task_id = tt.id
  WHERE ge.state IN ('routed', 'delivered')
),
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
-- Recent conversation-turn window (#2338): the last N distinct
-- conversation_turn_index values for this task. Pushed into the sdk_messages
-- scan so the per-segment selection runs over a small set (this is what brings
-- the compact feed under 100ms on 40k+ message tasks).
recent_turns AS (
  SELECT COALESCE(MIN(conversation_turn_index), 0) AS minTurn
  FROM (
    SELECT DISTINCT conversation_turn_index
    FROM sdk_messages
    WHERE task_id = (SELECT id FROM target_task)
      AND conversation_turn_index IS NOT NULL
    ORDER BY conversation_turn_index DESC
    LIMIT ${SPACE_TASK_MESSAGES_COMPACT_RECENT_TURNS}
  )
),
sdk_rows AS (
  SELECT
    sm.id AS id,
    sm.session_id AS sessionId,
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'task_agent'
      ELSE 'node_agent'
    END AS kind,
    CASE
      WHEN s_kind.type = 'space_task_agent' THEN 'task-agent'
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
    CASE
      WHEN sm.message_type != 'user' THEN NULL
      WHEN COALESCE(sm.send_status, 'consumed') = 'failed' THEN 'failed'
      WHEN EXISTS (
             SELECT 1
             FROM job_queue jq
             WHERE jq.queue = 'message_delivery'
               AND jq.status IN ('pending', 'processing')
               AND json_extract(jq.payload, '$.sessionId') = sm.session_id
               AND (json_extract(jq.payload, '$.messageUuid') = sm.sdk_uuid
                 OR EXISTS (
                   SELECT 1 FROM json_each(
                     CASE WHEN json_type(jq.payload, '$.batchUuids') = 'array'
                          THEN json_extract(jq.payload, '$.batchUuids') ELSE '[]' END
                   ) AS je WHERE je.value = sm.sdk_uuid
                 ))
               AND jq.retry_count > 0
           )
      THEN 'retrying'
      WHEN COALESCE(sm.send_status, 'consumed') = 'consumed' THEN 'delivered'
      WHEN COALESCE(sm.send_status, 'consumed') = 'submitted' THEN 'processing'
      ELSE 'queued'
    END AS deliveryState,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt,
    sm.parent_tool_use_id AS parentToolUseId,
    sm.is_renderable AS isRenderable,
    sm.is_terminal AS isTerminal,
    sm.conversation_turn_index AS turnIndex,
    sm.rowid AS insOrder
  FROM target_task tt
  JOIN sdk_messages sm ON sm.task_id = tt.id
  CROSS JOIN recent_turns rt
  LEFT JOIN sessions s_kind ON s_kind.id = sm.session_id
  LEFT JOIN session_node_exec sne
    ON sne.task_id = tt.id
   AND sne.session_id = sm.session_id
   AND sne.rn = 1
  LEFT JOIN space_agents sa ON sa.id = sne.agent_id
  WHERE (
    sm.conversation_turn_index >= rt.minTurn
    OR (
      -- Task #862 (review P2): include active nonterminal user rows
      -- (deferred/enqueued/submitted) independently of the recent-turn cutoff.
      -- A message queued to a dormant agent whose last turn index is old would
      -- otherwise be dropped from the compact feed until it settles, defeating
      -- the delivery-state UI for exactly the long multi-agent case it exists for.
      sm.message_type = 'user'
      AND COALESCE(sm.send_status, 'consumed') NOT IN ('consumed', 'failed')
    )
  )
    AND (
      sm.message_type != 'system'
      OR sm.message_subtype_norm != 'informational'
      OR NOT json_valid(sm.sdk_message)
      OR COALESCE(
        CASE
          WHEN json_valid(sm.sdk_message) THEN json_extract(sm.sdk_message, '$.level')
        END,
        ''
      ) != 'info'
    )
    AND (
      sm.message_type != 'system'
      OR sm.message_subtype_norm != 'worker_shutting_down'
      OR NOT EXISTS (
        SELECT 1
        FROM sdk_messages newer
        WHERE newer.session_id = sm.session_id
          AND newer.task_id = sm.task_id
          AND newer.parent_tool_use_id IS NULL
          AND (
            newer.timestamp > sm.timestamp
            OR (newer.timestamp = sm.timestamp AND newer.id > sm.id)
          )
          AND (newer.message_type != 'user' OR COALESCE(newer.send_status, 'consumed') IN ('consumed', 'failed'))
      )
    )
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
    turnIndex,
    insOrder
  FROM sdk_rows
)
`.trim();

const SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL = `
${SPACE_TASK_CONV_BASE_CTE},
-- Assistant rows with a non-empty text block, ranked newest-first per segment.
assistant_text AS (
  SELECT sessionId, turnIndex, id,
    ROW_NUMBER() OVER (PARTITION BY sessionId, turnIndex ORDER BY createdAt DESC, insOrder DESC) AS rn
  FROM joined
  WHERE messageType = 'assistant'
    AND json_valid(content)
    AND json_type(content, '$.message.content') = 'array'
    AND EXISTS (
      SELECT 1 FROM json_each(content, '$.message.content') b
      WHERE json_extract(b.value, '$.type') = 'text'
        AND TRIM(COALESCE(json_extract(b.value, '$.text'), '')) != ''
    )
),
-- Assistant rows with a non-empty thinking block, ranked newest-first.
assistant_thinking AS (
  SELECT sessionId, turnIndex, id,
    ROW_NUMBER() OVER (PARTITION BY sessionId, turnIndex ORDER BY createdAt DESC, insOrder DESC) AS rn
  FROM joined
  WHERE messageType = 'assistant'
    AND json_valid(content)
    AND json_type(content, '$.message.content') = 'array'
    AND EXISTS (
      SELECT 1 FROM json_each(content, '$.message.content') b
      WHERE json_extract(b.value, '$.type') = 'thinking'
        AND TRIM(COALESCE(json_extract(b.value, '$.thinking'), '')) != ''
    )
),
-- Assistant rows carrying a tool_use block, ranked newest-first.
assistant_tool AS (
  SELECT sessionId, turnIndex, id,
    ROW_NUMBER() OVER (PARTITION BY sessionId, turnIndex ORDER BY createdAt DESC, insOrder DESC) AS rn
  FROM joined
  WHERE messageType = 'assistant'
    AND json_valid(content)
    AND json_type(content, '$.message.content') = 'array'
    AND EXISTS (
      SELECT 1 FROM json_each(content, '$.message.content') b
      WHERE json_extract(b.value, '$.type') = 'tool_use'
    )
),
-- The summary row id(s) per (session, turn): assistant text if any, else
-- thinking if any, else the last N tool rows. NOT EXISTS makes the fallback
-- tiers mutually exclusive per segment.
seg_summary AS (
  SELECT id FROM assistant_text WHERE rn = 1
  UNION ALL
  SELECT t.id FROM assistant_thinking t
  WHERE t.rn = 1
    AND NOT EXISTS (
      SELECT 1 FROM assistant_text a
      WHERE a.sessionId = t.sessionId AND a.turnIndex = t.turnIndex
    )
  UNION ALL
  SELECT tu.id FROM assistant_tool tu
  WHERE tu.rn <= ${SPACE_TASK_MESSAGES_COMPACT_TOOL_SUMMARY_LIMIT}
    AND NOT EXISTS (
      SELECT 1 FROM assistant_text a
      WHERE a.sessionId = tu.sessionId AND a.turnIndex = tu.turnIndex
    )
    AND NOT EXISTS (
      SELECT 1 FROM assistant_thinking th
      WHERE th.sessionId = tu.sessionId AND th.turnIndex = tu.turnIndex
    )
),
selected_ids AS (
  -- Every anchor (renderable user message) — never swallowed.
  SELECT id FROM joined WHERE messageType = 'user' AND isRenderable = 1
  UNION ALL
  -- Every result row (completion / error marker).
  SELECT id FROM joined WHERE isTerminal = 1
  UNION ALL
  -- Non-hook system rows (init / compact_boundary / api_retry / ...).
  SELECT id FROM joined
  WHERE messageType = 'system'
    AND NOT (
      COALESCE(CASE WHEN json_valid(content) THEN json_extract(content, '$.subtype') END, '')
      IN ('hook_started', 'hook_progress', 'hook_response')
    )
  UNION ALL
  -- GitHub activity rows (PR / review / CI events). They sit outside the
  -- conversation-turn model (turnIndex IS NULL, not bounded by the recent-turn
  -- window) but are sparse — state-filtered to ('routed','delivered') — and
  -- legacy compact surfaced them, so keep them visible alongside the thread
  -- (#2338 review). The full byTask feed is the other surface for them.
  SELECT id FROM joined WHERE kind = 'github'
  UNION ALL
  -- HyperNeo-native action prompts (message_type='hyperneo_action', e.g.
  -- sdk_resume_choice). They are renderable, non-terminal, and neither user nor
  -- system nor assistant, so no other branch matches them; legacy compact kept
  -- them via the non-terminal tail. The frontend (SDKResumeChoiceMessage)
  -- renders the unblock card from the feed, so without this branch the card
  -- disappears from the task pane after refresh/reconnect (#2338).
  SELECT id FROM joined WHERE messageType = 'hyperneo_action'
  UNION ALL
  -- File/todo-mutating tool_use rows (Write/Edit/MultiEdit/TodoWrite). The
  -- Artifacts + Todos panel (TaskArtifactsPanel) reads the compact feed and
  -- derives file ops / todos from these via extractFileOperations /
  -- buildThreadEvents; seg_summary only keeps tool rows when a segment has NO
  -- assistant text, so without this branch they vanish in the common case
  -- (agent replies with text AND edits files). Tool names mirror the
  -- extractors in space-task-thread-events.ts (#2338 round 5).
  --
  -- NOT EXISTS seg_summary keeps this complementary: in a no-text turn
  -- seg_summary already keeps the last-N tool rows (which may include these),
  -- so without this guard the UNION ALL would emit them twice. This branch then
  -- only adds mutating tools seg_summary dropped — i.e. the text-turn case it
  -- exists for, plus any beyond the last-N cap (#2338 round 6).
  SELECT id FROM joined
  WHERE messageType = 'assistant'
    AND json_valid(content)
    AND json_type(content, '$.message.content') = 'array'
    AND EXISTS (
      SELECT 1 FROM json_each(content, '$.message.content') b
      WHERE json_extract(b.value, '$.type') = 'tool_use'
        AND json_extract(b.value, '$.name') IN ('Write', 'Edit', 'MultiEdit', 'TodoWrite')
    )
    AND NOT EXISTS (SELECT 1 FROM seg_summary ss WHERE ss.id = joined.id)
  UNION ALL
  -- Per-segment summary (assistant text -> thinking -> last N tools).
  SELECT id FROM seg_summary
)
SELECT
  j.id,
  j.sessionId,
  j.kind,
  j.role,
  j.label,
  j.nodeExecutionId,
  j.taskId,
  j.taskTitle,
  j.messageType,
  j.content,
  j.origin,
  j.deliveryState,
  j.createdAt,
  j.turnIndex,
  j.parentToolUseId,
  j.insOrder AS insOrder
FROM joined j
JOIN selected_ids s ON s.id = j.id
-- Tiebreak same-millisecond rows by insertion order (sm.rowid), not the random
-- UUID id, so e.g. several queued prompts consumed in the same ms render in
-- queue order, not shuffled (#2338).
ORDER BY j.createdAt ASC, j.insOrder ASC
`.trim();

export const SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL = `
${SPACE_TASK_CONV_BASE_CTE},
active_turn AS (
  -- The active roster turn per session = the conversation turn holding the
  -- session's most recent AGENT/operational row, and only when that row is not
  -- a terminal result (the agent is still working). The candidate set mirrors
  -- what the roster can render as activity — assistant + result + the operational
  -- system rows the roster has entry renderers for (api_retry, hook_started /
  -- hook_progress / hook_response) — so:
  --   - a sidecar (hyperneo_action / task_notification / github) after a result
  --     can't reopen the turn: it's not a candidate, so the result stays the
  --     most-recent candidate → closed (round-3 P2#5);
  --   - a retry-only turn (api_retry before any assistant row) is active
  --     (round-8);
  --   - a hook-only turn (a long SessionStart/Setup hook before any assistant
  --     row) is active so hook_entries can surface it;
  --   - a turn where the agent emitted a result then CONTINUED (no new user
  --     anchor — e.g. across an SDK tool_use result) stays active, because the
  --     continuing assistant row is the most-recent candidate and is
  --     non-terminal (NOT "turn has no result", which wrongly hid this);
  --   - a failed user-only turn (markEnqueuedMessageFailed) has no candidate,
  --     so the prior turn's most-recent candidate decides — an idle session
  --     (last candidate = result) stays closed.
  -- Queued user rows are filtered upstream by the sdk_rows send_status gate.
  SELECT c.sessionId AS sessionId, c.turnIndex AS turnIndex
  FROM (
    SELECT
      j.sessionId AS sessionId,
      j.turnIndex AS turnIndex,
      j.isTerminal AS isTerminal,
      ROW_NUMBER() OVER (PARTITION BY j.sessionId ORDER BY j.createdAt DESC, j.insOrder DESC) AS rn
    FROM joined j
    WHERE j.sessionId IS NOT NULL
      AND (
        j.messageType IN ('assistant', 'result')
        OR (
          j.messageType = 'system'
          AND json_valid(j.content)
          AND json_extract(j.content, '$.subtype') IN (
            'api_retry', 'hook_started', 'hook_progress', 'hook_response'
          )
        )
      )
  ) c
  WHERE c.rn = 1
    AND c.isTerminal = 0
    -- The candidate must sit in the session's LATEST conversation turn (the turn
    -- of its most-recent row of any kind). Without this, a newer turn with no
    -- candidate — e.g. a failed-user-only turn (markEnqueuedMessageFailed) after
    -- an older turn that ended without a result — leaves the older non-terminal
    -- candidate as rn=1 and an idle session wrongly reappears in the roster
    -- under its previous turn (#2338).
    AND c.turnIndex = (
      SELECT j2.turnIndex
      FROM joined j2
      WHERE j2.sessionId = c.sessionId
      ORDER BY j2.createdAt DESC, j2.insOrder DESC
      LIMIT 1
    )
),
active_rows AS (
  SELECT j.*
  FROM joined j
  JOIN active_turn at
    ON at.sessionId = j.sessionId
   AND at.turnIndex = j.turnIndex
),
-- One row per assistant content block (tool_use / non-empty text / thinking).
assistant_entries AS (
  SELECT
    ar.sessionId AS sessionId,
    ar.turnIndex AS turnIndex,
    ar.createdAt AS ts,
    -- rowId is insertion order (sdk_messages.rowid), NOT the random UUID id,
    -- so the entry id + final ORDER BY keep same-millisecond rows (e.g. a
    -- tool_use and the hook it triggers) in emission order instead of shuffling
    -- by UUID.
    base.rowid AS rowId,
    CAST(je.key AS INTEGER) AS blockIdx,
    json_extract(ar.content, '$.uuid') AS uuid,
    json_extract(je.value, '$.type') AS blockType,
    json_extract(je.value, '$.name') AS toolName,
    json_extract(je.value, '$.input') AS toolInput,
    -- tool_use block id — lets the roster link to a matching task_notification
    -- (by tool_use_id) and render the task's terminal status inline.
    json_extract(je.value, '$.id') AS toolUseId,
    json_extract(je.value, '$.text') AS textValue,
    json_extract(je.value, '$.thinking') AS thinkingValue
  FROM active_rows ar
  JOIN sdk_messages base ON base.id = ar.id,
       json_each(
         CASE WHEN json_valid(ar.content)
              THEN json_extract(ar.content, '$.message.content')
              ELSE '[]' END
       ) je
  WHERE ar.messageType = 'assistant'
    AND json_valid(ar.content)
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
    base.rowid AS rowId,
    -1 AS blockIdx,
    json_extract(ar.content, '$.uuid') AS uuid,
    CASE
      WHEN COALESCE(CAST(json_extract(ar.content, '$.isReplay') AS INTEGER), 0) = 1
        THEN '__user_replay'
      ELSE '__user_message'
    END AS blockType,
    NULL AS toolName,
    NULL AS toolInput,
    NULL AS toolUseId,
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
  JOIN sdk_messages base ON base.id = ar.id
  WHERE ar.messageType = 'user'
    -- Task #862 (review P2): a deferred prompt is explicitly waiting for the
    -- next turn -- keep it in the main thread, but don't show it in the live
    -- active-turn roster as input "inside" the active turn.
    AND COALESCE(base.send_status, 'consumed') != 'deferred'
    AND json_valid(ar.content)
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
),
-- One row per hook run in the active turn. A hook emits hook_started →
-- hook_progress → hook_response; collapse to the LATEST message per hook_id
-- so the roster shows a single entry whose status reflects the final phase
-- (running while started/progress, completed/failed once response arrives).
hook_runs AS (
  SELECT
    ar.sessionId AS sessionId,
    ar.turnIndex AS turnIndex,
    ar.createdAt AS ts,
    base.rowid AS rowId,
    json_extract(ar.content, '$.uuid') AS uuid,
    json_extract(ar.content, '$.hook_id') AS hookId,
    json_extract(ar.content, '$.hook_name') AS hookName,
    json_extract(ar.content, '$.hook_event') AS hookEvent,
    json_extract(ar.content, '$.subtype') AS hookSubtype,
    json_extract(ar.content, '$.outcome') AS outcome,
    json_extract(ar.content, '$.stdout') AS stdout,
    ROW_NUMBER() OVER (
      -- Partition per (session, turn, hook_id): hook_id is only unique within a
      -- single agent's turn, so two active sessions emitting the same hook_id
      -- must not collapse into one window (one would be dropped before grouping
      -- by sessionId).
      PARTITION BY ar.sessionId, ar.turnIndex, json_extract(ar.content, '$.hook_id')
      -- createdAt ties (same-millisecond hook_started/progress/response) are
      -- broken by insertion order: sdk_messages.id is a random UUID, so join
      -- back to the base table for its implicit rowid, which is monotonic.
      ORDER BY ar.createdAt DESC, base.rowid DESC
    ) AS rn
  FROM active_rows ar
  JOIN sdk_messages base ON base.id = ar.id
  WHERE ar.messageType = 'system'
    -- Guard the hook json_extract calls on valid JSON so a single malformed
    -- sdk_message blob can't raise 'malformed JSON' and break the active-turn
    -- subscription. Malformed rows simply don't qualify as hook runs.
    AND json_valid(ar.content)
    AND json_extract(ar.content, '$.subtype') IN ('hook_started', 'hook_progress', 'hook_response')
    AND json_extract(ar.content, '$.hook_id') IS NOT NULL
),
hook_entries AS (
  SELECT
    sessionId,
    turnIndex,
    ts,
    rowId,
    -2 AS blockIdx,
    uuid,
    '__hook' AS blockType,
    hookName AS toolName,
    NULL AS toolInput,
    NULL AS toolUseId,
    CASE
      WHEN stdout IS NOT NULL AND TRIM(stdout) != ''
        THEN SUBSTR(TRIM(stdout), 1, 120)
      ELSE NULL
    END AS textValue,
    NULL AS thinkingValue,
    hookEvent AS hookEvent,
    CASE
      WHEN hookSubtype = 'hook_response' AND outcome = 'success' THEN 'completed'
      WHEN hookSubtype = 'hook_response' THEN 'failed'
      ELSE 'running'
    END AS hookStatus,
    NULL AS attempt,
    NULL AS maxRetries,
    NULL AS retryDelayMs,
    NULL AS errorStatus
  FROM hook_runs
  WHERE rn = 1
),
api_retry_entries AS (
  SELECT
    ar.sessionId AS sessionId,
    ar.turnIndex AS turnIndex,
    ar.createdAt AS ts,
    base.rowid AS rowId,
    -3 AS blockIdx,
    json_extract(ar.content, '$.uuid') AS uuid,
    '__api_retry' AS blockType,
    NULL AS toolName,
    NULL AS toolInput,
    NULL AS toolUseId,
    NULL AS textValue,
    NULL AS thinkingValue,
    NULL AS hookEvent,
    NULL AS hookStatus,
    COALESCE(json_extract(ar.content, '$.attempt'), 1) AS attempt,
    COALESCE(json_extract(ar.content, '$.max_retries'), 0) AS maxRetries,
    COALESCE(json_extract(ar.content, '$.retry_delay_ms'), 0) AS retryDelayMs,
    json_extract(ar.content, '$.error_status') AS errorStatus
  FROM active_rows ar
  JOIN sdk_messages base ON base.id = ar.id
  WHERE ar.messageType = 'system'
    AND json_valid(ar.content)
    AND json_extract(ar.content, '$.subtype') = 'api_retry'
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
  toolUseId,
  textValue,
  thinkingValue,
  NULL AS hookEvent,
  NULL AS hookStatus,
  NULL AS attempt,
  NULL AS maxRetries,
  NULL AS retryDelayMs,
  NULL AS errorStatus
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
  toolUseId,
  textValue,
  thinkingValue,
  NULL AS hookEvent,
  NULL AS hookStatus,
  NULL AS attempt,
  NULL AS maxRetries,
  NULL AS retryDelayMs,
  NULL AS errorStatus
FROM user_entries
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
  toolUseId,
  textValue,
  thinkingValue,
  hookEvent,
  hookStatus,
  attempt,
  maxRetries,
  retryDelayMs,
  errorStatus
FROM hook_entries
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
  toolUseId,
  textValue,
  thinkingValue,
  hookEvent,
  hookStatus,
  attempt,
  maxRetries,
  retryDelayMs,
  errorStatus
FROM api_retry_entries
ORDER BY sessionId ASC, ts ASC, rowId ASC, blockIdx ASC, id ASC
`.trim();

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
  s.acp_session_id as acpSessionId,
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

const SESSIONS_TOTAL_COUNT_SQL = `
SELECT COUNT(*) as cnt FROM sessions s
WHERE s.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
  AND json_extract(s.session_context, '$.roomId') IS NULL
  AND json_extract(s.session_context, '$.spaceId') IS NULL
`.trim();

const SESSIONS_ARCHIVED_COUNT_SQL = `
SELECT COUNT(*) as cnt FROM sessions s
WHERE s.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
  AND json_extract(s.session_context, '$.roomId') IS NULL
  AND json_extract(s.session_context, '$.spaceId') IS NULL
  AND s.status = 'archived'
`.trim();

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
    acpSessionId: (row.acpSessionId as string | null) ?? undefined,
    availableCommands,
    processingState: (row.processingState as string | null) ?? undefined,
    archivedAt: (row.archivedAt as string | null) ?? undefined,
    type: (row.type as string | null) ?? 'worker',
    context: sessionContext,
  };
}

const EXCLUDED_FROM_PAGINATION_SQL_LIST = toSqlStringList([
  ...HIDDEN_SYSTEM_SUBTYPES,
  'thinking_tokens',
]);

const SPACE_SESSIONS_BY_SPACE_SQL = `
SELECT
  s.id as id,
  s.title as title,
  s.status as status,
  s.processing_state as processingState,
  -- Read the maintained counter directly instead of a correlated COUNT(*) over
  -- sdk_messages per session (previously ~92ms warm for dev-neokai, re-run every
  -- 150ms debounce). SDKMessageRepository keeps this in sync with the same
  -- visibility predicate (top-level rows, non-deferred user rows, non-hidden
  -- subtypes) on every sdk_messages mutation.
  s.visible_message_count as messageCount,
  (unixepoch(s.last_active_at) - 0) * 1000 as lastActiveAt
FROM sessions s
INNER JOIN spaces sp ON sp.id = ?
CROSS JOIN json_each(sp.session_ids) j
WHERE j.value = s.id AND s.status != 'archived' AND s.type != 'space_chat'
ORDER BY s.last_active_at DESC, s.id DESC
`.trim();

function mapSpaceSessionRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    processingState: (row.processingState as string | null) ?? undefined,
    messageCount: Number(row.messageCount ?? 0),
    lastActiveAt: Number(row.lastActiveAt ?? 0),
  };
}

const BACKGROUND_TASK_METADATA_SUBTYPES = ['task_started', 'task_updated', 'task_notification'];
const BACKGROUND_TASK_METADATA_BATCH_SIZE = 300;
const MAX_MESSAGES_BY_SESSION_WINDOW = 200;

function toSqlStringList(subtypes: Iterable<string>): string {
  return [...subtypes].map((subtype) => `'${subtype.replace(/'/g, "''")}'`).join(', ');
}

const BACKGROUND_TASK_METADATA_SQL_LIST = toSqlStringList(BACKGROUND_TASK_METADATA_SUBTYPES);

export const BACKGROUND_TASK_METADATA_SQL = `
WITH recent_metadata AS (
  SELECT
    id,
    sdk_message,
    timestamp,
    send_status,
    origin,
    rowid,
    COALESCE(
      CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
      task_id
    ) AS task_id
  FROM sdk_messages
  WHERE session_id = ?
    AND parent_tool_use_id IS NULL
    AND message_subtype_norm IN (${BACKGROUND_TASK_METADATA_SQL_LIST})
  ORDER BY timestamp DESC, rowid DESC
  LIMIT ${BACKGROUND_TASK_METADATA_BATCH_SIZE}
),
recent_progress AS (
  SELECT
    id,
    sdk_message,
    timestamp,
    send_status,
    origin,
    rowid,
    COALESCE(
      CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
      task_id
    ) AS task_id
  FROM sdk_messages
  WHERE session_id = ?
    AND parent_tool_use_id IS NULL
    AND message_subtype_norm = 'task_progress'
  ORDER BY timestamp DESC, rowid DESC
  LIMIT ${BACKGROUND_TASK_METADATA_BATCH_SIZE}
),
recent_task_ids AS (
  SELECT DISTINCT candidate.task_id
  FROM (
    SELECT task_id FROM recent_metadata
    UNION ALL
    SELECT task_id FROM recent_progress
  ) candidate
  WHERE candidate.task_id IS NOT NULL AND candidate.task_id != ''
    AND NOT EXISTS (
      SELECT 1
      FROM sdk_messages terminal
      WHERE terminal.session_id = ?
        AND terminal.parent_tool_use_id IS NULL
        AND terminal.message_subtype_norm = 'task_notification'
        AND COALESCE(
          CASE WHEN json_valid(terminal.sdk_message) THEN json_extract(terminal.sdk_message, '$.task_id') END,
          terminal.task_id
        ) = candidate.task_id
    )
),
task_starts AS (
  SELECT
    id,
    sdk_message,
    timestamp,
    send_status,
    origin,
    rowid,
    COALESCE(
      CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
      task_id
    ) AS task_id
  FROM sdk_messages
  WHERE session_id = ?
    AND parent_tool_use_id IS NULL
    AND message_subtype_norm = 'task_started'
    AND COALESCE(
      CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
      task_id
    ) IN (SELECT task_id FROM recent_task_ids)
    AND id NOT IN (SELECT id FROM recent_metadata)
),
latest_progress AS (
  SELECT
    id,
    sdk_message,
    timestamp,
    send_status,
    origin,
    rowid,
    task_id
  FROM (
    SELECT
      id,
      sdk_message,
      timestamp,
      send_status,
      origin,
      rowid,
      COALESCE(
        CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
        task_id
      ) AS task_id,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(
          CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.tool_use_id') END,
          ''
        )
        ORDER BY timestamp DESC, rowid DESC
      ) AS rn
    FROM sdk_messages
    WHERE session_id = ?
      AND parent_tool_use_id IS NULL
      AND message_subtype_norm = 'task_progress'
      AND COALESCE(
        CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.tool_use_id') END,
        ''
      ) != ''
      AND COALESCE(
        CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
        task_id
      ) IN (SELECT task_id FROM recent_task_ids)
  )
  WHERE rn = 1
)
SELECT
  id,
  sdk_message                                                     AS content,
  CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER)  AS timestamp,
  send_status                                                     AS sendStatus,
  origin                                                          AS origin
FROM (
  SELECT * FROM recent_metadata
  UNION ALL
  SELECT * FROM task_starts
  UNION ALL
  SELECT * FROM latest_progress
)
ORDER BY timestamp DESC, rowid DESC
`.trim();

const MESSAGES_BY_SESSION_SQL = `
WITH active_delivery_jobs AS MATERIALIZED (
  SELECT
    jq.rowid AS job_rowid,
    json_extract(jq.payload, '$.messageUuid') AS message_uuid,
    CASE
      WHEN json_type(jq.payload, '$.batchUuids') = 'array'
      THEN json_extract(jq.payload, '$.batchUuids')
      ELSE '[]'
    END AS batch_uuids,
    jq.retry_count,
    jq.run_at,
    jq.max_retries
  FROM job_queue jq
  WHERE jq.queue = 'message_delivery'
    AND jq.status IN ('pending', 'processing')
    AND json_extract(jq.payload, '$.sessionId') = ?1
),
active_delivery_candidates AS (
  SELECT
    message_uuid,
    job_rowid,
    retry_count,
    run_at,
    max_retries
  FROM active_delivery_jobs
  WHERE message_uuid IS NOT NULL
  UNION ALL
  SELECT
    je.value AS message_uuid,
    jobs.job_rowid,
    jobs.retry_count,
    jobs.run_at,
    jobs.max_retries
  FROM active_delivery_jobs jobs, json_each(jobs.batch_uuids) je
  WHERE je.value IS NOT NULL
),
active_delivery_ranked AS (
  SELECT
    message_uuid,
    json_object(
      'count', retry_count,
      'runAt', run_at,
      'max', max_retries
    ) AS deliveryRetryInfo,
    ROW_NUMBER() OVER (
      PARTITION BY message_uuid
      ORDER BY retry_count DESC, job_rowid DESC
    ) AS retry_rank
  FROM active_delivery_candidates
),
active_delivery_retry AS MATERIALIZED (
  SELECT message_uuid, deliveryRetryInfo
  FROM active_delivery_ranked
  WHERE retry_rank = 1
),
top_level AS (
  SELECT
    id,
    sdk_message,
    timestamp,
    send_status,
    origin,
    rowid,
    message_type,
    active_delivery_retry.deliveryRetryInfo AS deliveryRetryInfo
  FROM sdk_messages
  LEFT JOIN active_delivery_retry ON active_delivery_retry.message_uuid = sdk_messages.sdk_uuid
  WHERE session_id = ?1
    AND parent_tool_use_id IS NULL
    -- Task #862: surface ALL user-message delivery states (deferred / enqueued
    -- / submitted / consumed / failed) so the UI can badge queued / processing
    -- / retrying explicitly instead of inferring from system/init. Daemon-side
    -- reads (SDKMessageRepository.getSDKMessages) keep the consumed/failed
    -- visibility filter, so prompt context / rewind are unaffected; only the
    -- web transcript feed widens.
    AND message_subtype_norm NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})
    AND (
      message_type != 'system'
      OR message_subtype_norm != 'informational'
      OR NOT json_valid(sdk_message)
      OR COALESCE(
        CASE
          WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.level')
        END,
        ''
      ) != 'info'
    )
    AND (
      message_type != 'system'
      OR message_subtype_norm != 'worker_shutting_down'
      OR NOT EXISTS (
        SELECT 1
        FROM sdk_messages newer
        WHERE newer.session_id = sdk_messages.session_id
          AND newer.parent_tool_use_id IS NULL
          AND (
            newer.timestamp > sdk_messages.timestamp
            OR (newer.timestamp = sdk_messages.timestamp AND newer.id > sdk_messages.id)
          )
          AND (newer.message_type != 'user' OR COALESCE(newer.send_status, 'consumed') IN ('consumed', 'failed'))
      )
    )
  -- Cap window orders by (timestamp, rowid) so a LiveQuery limit that cuts
  -- through same-millisecond hook_started/progress/response rows keeps the
  -- later phases (insertion order) instead of dropping the terminal response
  -- by random UUID. The planner falls back to idx_sdk_messages_session_timestamp_id + a
  -- bounded temp sort (rowid isn't in the composite index) — acceptable for a
  -- capped window, and correctness beats the micro-optimisation here.
  ORDER BY timestamp DESC, rowid DESC
  LIMIT ?2
),
tool_use_ids AS (
  SELECT DISTINCT json_extract(je.value, '$.id') AS id
  FROM top_level,
       json_each(
         CASE
           WHEN json_valid(top_level.sdk_message)
            AND json_extract(top_level.sdk_message, '$.type') = 'assistant'
           THEN json_extract(top_level.sdk_message, '$.message.content')
           ELSE '[]'
         END
       ) AS je
  WHERE json_valid(top_level.sdk_message)
    AND json_extract(top_level.sdk_message, '$.type') = 'assistant'
    AND json_extract(je.value, '$.type') = 'tool_use'
    AND json_extract(je.value, '$.id') IS NOT NULL
),
subagent AS (
  SELECT
    sm.id AS id,
    sm.sdk_message AS sdk_message,
    sm.timestamp AS timestamp,
    sm.send_status AS send_status,
    sm.origin AS origin,
    sm.rowid AS rowid,
    sm.message_type AS message_type,
    active_delivery_retry.deliveryRetryInfo AS deliveryRetryInfo
  FROM sdk_messages sm
  LEFT JOIN active_delivery_retry ON active_delivery_retry.message_uuid = sm.sdk_uuid
  WHERE sm.session_id = ?1
    AND sm.parent_tool_use_id IN (SELECT id FROM tool_use_ids)
    AND sm.message_subtype_norm != 'thinking_tokens'
)
SELECT
  id,
  sdk_message                                                       AS content,
  CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER)    AS timestamp,
  send_status                                                       AS sendStatus,
  origin                                                            AS origin,
  rowid                                                             AS rowid,
  message_type                                                      AS messageType,
  deliveryRetryInfo                                                 AS deliveryRetryInfo
FROM top_level
UNION ALL
SELECT
  id,
  sdk_message                                                       AS content,
  CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER)    AS timestamp,
  send_status                                                       AS sendStatus,
  origin                                                            AS origin,
  rowid                                                             AS rowid,
  message_type                                                      AS messageType,
  deliveryRetryInfo                                                 AS deliveryRetryInfo
FROM subagent
ORDER BY timestamp ASC, rowid ASC
`.trim();

function mapMessageRow(row: Record<string, unknown>): Record<string, unknown> {
  const contentRaw = row.content;
  let parsed: Record<string, unknown> = {};
  if (typeof contentRaw === 'string') {
    try {
      parsed = JSON.parse(contentRaw) as Record<string, unknown>;
    } catch {
      parsed = { type: 'unknown', rawContent: contentRaw };
    }
  }

  const extras: Record<string, unknown> = {
    id: row.id,
    timestamp: typeof row.timestamp === 'number' ? row.timestamp : Number(row.timestamp ?? 0),
    rowid: typeof row.rowid === 'number' ? row.rowid : Number(row.rowid ?? 0),
    origin: row.origin != null ? row.origin : undefined,
  };
  if (parsed.type === 'user') {
    let retryCount = 0;
    let retryInfo: { count?: number; runAt?: number; max?: number } | null = null;
    const raw = row.deliveryRetryInfo;
    if (typeof raw === 'string' && raw.length > 0) {
      try {
        retryInfo = JSON.parse(raw) as { count?: number; runAt?: number; max?: number };
        retryCount = Number(retryInfo?.count ?? 0);
      } catch {
        // malformed blob — treat as no active job
      }
    }
    const deliveryStatus = sendStatusToDeliveryStatus(row.sendStatus as string | null, {
      retrying: retryCount > 0,
    });
    if (deliveryStatus) extras.deliveryStatus = deliveryStatus;
    if (retryCount > 0 && retryInfo) {
      extras.deliveryRetry = {
        count: retryCount,
        runAt: typeof retryInfo.runAt === 'number' ? retryInfo.runAt : undefined,
        maxRetries: typeof retryInfo.max === 'number' ? retryInfo.max : undefined,
      };
    }
  }

  return { ...parsed, ...extras };
}

function buildTaskScopeFilter(
  params: ReadonlyArray<unknown>,
  db: BunDatabase
): ((scope: TableChangeScope) => boolean) | undefined {
  const taskId = params[0] as string;

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

function buildWorkflowRunScopeFilter(
  params: ReadonlyArray<unknown>,
  db: BunDatabase
): (scope: TableChangeScope) => boolean {
  const workflowRunId = params[0] as string;
  const taskIds = new Set<string>();
  const sessionIds = new Set<string>();
  const loadScope = () => {
    taskIds.clear();
    sessionIds.clear();
    try {
      const tasks = db
        .prepare('SELECT id, task_agent_session_id FROM space_tasks WHERE workflow_run_id = ?')
        .all(workflowRunId) as Array<{ id: string; task_agent_session_id: string | null }>;
      for (const row of tasks) {
        taskIds.add(row.id);
        if (row.task_agent_session_id) sessionIds.add(row.task_agent_session_id);
      }
    } catch {
      // space_tasks may not exist in minimal test schemas
    }
    try {
      const executions = db
        .prepare('SELECT agent_session_id FROM node_executions WHERE workflow_run_id = ?')
        .all(workflowRunId) as Array<{ agent_session_id: string | null }>;
      for (const row of executions) {
        if (row.agent_session_id) sessionIds.add(row.agent_session_id);
      }
    } catch {
      // node_executions may not exist in minimal test schemas
    }
    try {
      const messages = db
        .prepare(
          'SELECT DISTINCT session_id FROM sdk_messages WHERE task_id IN (SELECT id FROM space_tasks WHERE workflow_run_id = ?)'
        )
        .all(workflowRunId) as Array<{ session_id: string | null }>;
      for (const row of messages) {
        if (row.session_id) sessionIds.add(row.session_id);
      }
    } catch {
      // sdk_messages may not exist in minimal test schemas
    }
  };
  loadScope();
  return (scope) => {
    if (scope.taskId) return taskIds.has(scope.taskId);
    if (!scope.sessionId) return true;
    if (sessionIds.has(scope.sessionId)) return true;
    loadScope();
    return sessionIds.has(scope.sessionId);
  };
}

function buildSpaceSessionsScopeFilter(
  params: ReadonlyArray<unknown>,
  db: BunDatabase
): (scope: TableChangeScope) => boolean {
  const spaceId = params[0] as string;
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
    if (scope.spaceId === spaceId) return true;

    if (!scope.sessionId) return true;

    const members = readMembership();
    if (members === null) return true;
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
      buildScopeFilter: buildWorkflowRunScopeFilter,
    },
  ],
  [
    'taskMilestones.byTask',
    {
      sql: TASK_MILESTONES_BY_TASK_SQL,
      paramCount: 1,
      debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
      mapRow: mapTaskMilestoneRow,
      buildScopeFilter: buildTaskScopeFilter,
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
      mapRow: mapSpaceSessionRow,
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
      rowFingerprint: (row) =>
        row.messageType === 'hyperneo_action'
          ? row
          : {
              content: typeof row.content === 'string' ? row.content.length : row.content,
              timestamp: row.timestamp,
              sendStatus: row.sendStatus,
              origin: row.origin,
              rowid: row.rowid,
              deliveryRetryInfo: row.deliveryRetryInfo,
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

const log = new Logger('live-query-handlers');

export function setupLiveQueryHandlers(
  messageHub: MessageHub,
  liveQueries: LiveQueryEngine,
  db: BunDatabase
): () => void {
  const subscriptions = new Map<string, Map<string, LiveQueryHandle<Record<string, unknown>>>>();

  const stmtSessionsTotalCount = db.prepare(SESSIONS_TOTAL_COUNT_SQL);
  const stmtSessionsArchivedCount = db.prepare(SESSIONS_ARCHIVED_COUNT_SQL);

  const sessionsListBase = NAMED_QUERY_REGISTRY.get('sessions.list')!;
  const activeRegistry = new Map(NAMED_QUERY_REGISTRY);

  const messagesBySessionBase = NAMED_QUERY_REGISTRY.get('messages.bySession')!;
  const stmtBackgroundTaskMetadata = db.prepare(BACKGROUND_TASK_METADATA_SQL);
  activeRegistry.set('messages.bySession', {
    ...messagesBySessionBase,
    mapResult: (_rawRows, params) => {
      const sessionId = params[0];
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
      const rows = stmtBackgroundTaskMetadata.all(
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId
      ) as Record<string, unknown>[];
      return {
        backgroundTaskMessages: rows.map(mapMessageRow).reverse(),
      };
    },
  });

  activeRegistry.set('sessions.list', {
    ...sessionsListBase,
    mapResult: (rawRows) => {
      if (rawRows.length > 0 && rawRows[0]._totalCount != null) {
        return {
          totalCount: rawRows[0]._totalCount as number,
          archivedCount: (rawRows[0]._archivedCount as number | null) ?? 0,
        };
      }
      const totalRow = stmtSessionsTotalCount.get() as { cnt: number } | undefined;
      const archivedRow = stmtSessionsArchivedCount.get() as { cnt: number } | undefined;
      return {
        totalCount: totalRow?.cnt ?? 0,
        archivedCount: archivedRow?.cnt ?? 0,
      };
    },
  });

  const stmtRoom = db.prepare('SELECT id FROM rooms WHERE id = ?');
  const stmtGroup = db.prepare('SELECT ref_id, group_type FROM session_groups WHERE id = ?');
  const stmtTask = db.prepare('SELECT room_id FROM tasks WHERE id = ?');
  const stmtSpace = db.prepare('SELECT id FROM spaces WHERE id = ?');
  const stmtSession = db.prepare('SELECT id FROM sessions WHERE id = ?');

  messageHub.onRequest('liveQuery.subscribe', (data, context) => {
    const { queryName, params, subscriptionId } = data as LiveQuerySubscribeRequest;
    const { clientId, sessionId } = context;

    if (!clientId) {
      throw new Error('liveQuery.subscribe requires a WebSocket connection (clientId absent)');
    }

    const router = messageHub.getRouter();

    const namedQuery = activeRegistry.get(queryName);
    if (!namedQuery) {
      throw new Error(`Unknown query name: "${queryName}"`);
    }

    if (params.length !== namedQuery.paramCount) {
      throw new Error(
        `Query "${queryName}" expects ${namedQuery.paramCount} parameter(s), got ${params.length}`
      );
    }

    if (queryName === 'sessionGroupMessages.byGroup') {
      const groupId = params[0] as string;
      const group = stmtGroup.get(groupId) as { ref_id: string; group_type: string } | null;
      if (!group) {
        throw new Error(`Unauthorized: session group "${groupId}" not found`);
      }
      if (group.group_type === 'task') {
        const task = stmtTask.get(group.ref_id) as { room_id: string } | null;
        if (!task) {
          throw new Error(`Unauthorized: task "${group.ref_id}" not found`);
        }
        if (!stmtRoom.get(task.room_id)) {
          throw new Error(`Unauthorized: room "${task.room_id}" not found`);
        }
      }
    } else if (
      queryName === 'spaceTaskActivity.byTask' ||
      queryName === 'spaceTaskMessages.byTask' ||
      queryName === 'spaceTaskMessages.byTask.compact' ||
      queryName === 'spaceTaskActiveTurn.byTask' ||
      queryName === 'actorMessages.byTask' ||
      queryName === 'taskMilestones.byTask'
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
    } else if (queryName === 'actorMessages.byWorkflowRun') {
      const workflowRunId = params[0] as string;
      if (params.some((param) => param !== workflowRunId)) {
        throw new Error(
          'Unauthorized: actorMessages.byWorkflowRun requires matching workflow run ids'
        );
      }
      let workflowRun: { id: string } | null = null;
      try {
        workflowRun = db
          .prepare('SELECT id FROM space_workflow_runs WHERE id = ?')
          .get(workflowRunId) as {
          id: string;
        } | null;
      } catch {
        workflowRun = null;
      }
      if (!workflowRun) {
        throw new Error(`Unauthorized: workflow run "${workflowRunId}" not found`);
      }
    } else if (queryName === 'spaceSessions.bySpace' || queryName === 'mcpEnablement.bySpace') {
      const spaceId = params[0] as string;
      if (!stmtSpace.get(spaceId)) {
        throw new Error(`Unauthorized: space "${spaceId}" not found`);
      }
    } else if (queryName === 'messages.bySession') {
      const targetSessionId = params[0] as string;
      if (typeof targetSessionId !== 'string' || targetSessionId.length === 0) {
        throw new Error('Unauthorized: messages.bySession requires a non-empty sessionId');
      }
      if (!stmtSession.get(targetSessionId)) {
        throw new Error(`Unauthorized: session "${targetSessionId}" not found`);
      }
      const limit = params[1];
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit <= 0 ||
        limit > MAX_MESSAGES_BY_SESSION_WINDOW
      ) {
        throw new Error(
          `Unauthorized: messages.bySession limit must be an integer in [1, ${MAX_MESSAGES_BY_SESSION_WINDOW}], got ${String(limit)}`
        );
      }
    }

    let clientSubs = subscriptions.get(clientId);
    if (!clientSubs) {
      clientSubs = new Map();
      subscriptions.set(clientId, clientSubs);
    }

    const existing = clientSubs.get(subscriptionId);
    const isReplacement = !!existing;
    if (existing) {
      log.debug(
        `liveQuery.subscribe: replacing subscription ${subscriptionId} for client ${clientId}`
      );
      existing.dispose();
      clientSubs.delete(subscriptionId);
      router?.releaseClientSubscription(clientId);
    }

    if (router && !isReplacement) {
      const capacity = router.checkSubscriptionCapacity(clientId);
      if (!capacity.ok) {
        throw new MessageHubHandlerError(
          `liveQuery.subscribe: subscription cap reached for client (${capacity.current}/${capacity.limit}); subscribe to fewer queries or close other views`,
          ErrorCode.TOO_MANY_SUBSCRIPTIONS
        );
      }
    }

    const { sql, mapRow } = namedQuery;
    const applyMapRow = (row: Record<string, unknown>) => (mapRow ? mapRow(row) : row);
    const applyMapRows = (rows: Record<string, unknown>[]) => rows.map(applyMapRow);

    let snapshotDeliveryFailed = false;
    let snapshotTooLarge = false;

    const handle = liveQueries.subscribe(
      sql,
      params,
      (diff: QueryDiff<Record<string, unknown>>) => {
        const router = messageHub.getRouter();
        if (!router) {
          log.warn(
            `liveQuery: router unavailable; skipping event (clientId=${clientId}, subscriptionId=${subscriptionId})`
          );
          if (diff.type === 'snapshot') {
            snapshotDeliveryFailed = true;
          }
          return;
        }

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

        const delivery = router.sendToClientDetailed(clientId, message);
        if (!delivery.ok && delivery.reason === 'message_too_large') {
          const errorMessage = createEventMessage({
            method: 'liveQuery.error',
            data: {
              subscriptionId,
              code: 'MESSAGE_TOO_LARGE',
              message: 'Live query update is too large to send; load a smaller window',
              phase: diff.type,
            },
            sessionId,
          });
          router.sendToClient(clientId, errorMessage);
          if (diff.type === 'snapshot') {
            snapshotTooLarge = true;
          } else {
            handle.dispose();
            const subs = subscriptions.get(clientId);
            subs?.delete(subscriptionId);
            if (subs?.size === 0) subscriptions.delete(clientId);
            router.releaseClientSubscription(clientId);
          }
          return;
        }
        if (!delivery.ok) {
          if (diff.type === 'snapshot') {
            snapshotDeliveryFailed = true;
            log.warn(
              `liveQuery: snapshot delivery failed for client ${clientId}; subscription ${subscriptionId} will be disposed`
            );
          } else {
            log.warn(
              `liveQuery: delta delivery failed for client ${clientId}; disposing subscription ${subscriptionId}`
            );
            handle.dispose();
            const subs = subscriptions.get(clientId);
            if (subs) {
              subs.delete(subscriptionId);
              if (subs.size === 0) subscriptions.delete(clientId);
            }
            router.releaseClientSubscription(clientId);
          }
        }
      },
      {
        debounceMs: namedQuery.debounceMs,
        getMetadata: namedQuery.mapResult,
        scopeFilter: namedQuery.buildScopeFilter?.(params, db),
        rowFingerprint: namedQuery.rowFingerprint,
      }
    );

    if (snapshotTooLarge) {
      handle.dispose();
      throw new Error('MESSAGE_TOO_LARGE: Live query snapshot exceeds the outbound size limit');
    }

    if (snapshotDeliveryFailed) {
      handle.dispose();
      return { ok: true } satisfies LiveQuerySubscribeResponse;
    }

    router?.addClientSubscription(clientId);
    clientSubs.set(subscriptionId, handle);
    log.debug(
      `liveQuery.subscribe: registered subscription ${subscriptionId} for client ${clientId}, query=${queryName}`
    );

    return { ok: true } satisfies LiveQuerySubscribeResponse;
  });

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
      messageHub.getRouter()?.releaseClientSubscription(clientId);
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

  return () => {
    for (const [, clientSubs] of subscriptions) {
      for (const [, handle] of clientSubs) {
        handle.dispose();
      }
    }
    subscriptions.clear();
    unsubDisconnect();
  };
}
