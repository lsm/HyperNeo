import { NODE_EXECUTION_RELEVANCE_ORDER, TASK_AGENT_SESSION_PREDICATE } from './task-delivery.ts';

function formatTaskActivityLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return value
    .split(/[_-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function mapSpaceTaskActivityRow(row: Record<string, unknown>): Record<string, unknown> {
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
          : formatTaskActivityLabel(rawLabel, ''),
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

export const NODE_EXECUTIONS_BY_RUN_SQL = `
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

export const SPACE_TASK_ACTIVITY_BY_TASK_SQL = `
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
    AND NOT EXISTS (
      SELECT 1 FROM direct_task_session_provenance dtp WHERE dtp.session_id = s.id
    )
  UNION
  -- Task Agent after pause/cancel: stopActiveWorkflowTaskAgents clears
  -- task_agent_session_id (severing the pointer arm above), and the worker
  -- arms below only admit sessions.type = 'worker'. Recover it from durable
  -- task_id-stamped messages so the orchestrator's history stays in the feed.
  -- Redundant while the pointer is live; UNION dedupes by session_id.
  --
  -- Direct-task workers also stamp their messages with the task id, but they
  -- are not participants in this feed. The provenance table records every
  -- session a direct attempt ever used, so exclude them.
  SELECT DISTINCT
    sm.session_id AS session_id,
    tt.id AS task_id,
    tt.title AS task_title,
    tt.status AS task_status
  FROM target_task tt
  JOIN sdk_messages sm ON sm.task_id = tt.id
  JOIN sessions s ON s.id = sm.session_id
  WHERE NOT EXISTS (
    SELECT 1 FROM direct_task_session_provenance dtp WHERE dtp.session_id = s.id
  )
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
             ${NODE_EXECUTION_RELEVANCE_ORDER}
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
    -- Task Agent vs node-agent classification: a session with a
    -- node_executions row ran a workflow node; the task-level agent has none.
    -- Keying on the execution row (not the transient task_agent_session_id
    -- pointer) keeps historical rows correctly attributed when the pointer is
    -- rotated or cleared (rehydrate self-heal, session replacement).
    -- A direct-task worker has neither, so the provenance table is what
    -- separates it from the task-level agent: it is never the Task Agent.
    CASE
      WHEN ${TASK_AGENT_SESSION_PREDICATE} THEN 'task_agent'
      ELSE 'node_agent'
    END AS kind,
    CASE
      WHEN ${TASK_AGENT_SESSION_PREDICATE} THEN 'Task Agent'
      ELSE COALESCE(sa.display_name, sne.agent_name, json_extract(s_kind.metadata, '$.promptProvenance.agentName'))
    END AS label,
    CASE
      WHEN ${TASK_AGENT_SESSION_PREDICATE} THEN 'task-agent'
      ELSE COALESCE(sne.agent_name, json_extract(s_kind.metadata, '$.promptProvenance.agentName'))
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
  -- Resolve the display agent (space_long_horizon_agents.display_name) via the
  -- execution's agent id when present, else the post-approval worker's provenance
  -- agent id, so its label matches what
  -- it would show with an execution row.
  LEFT JOIN space_long_horizon_agents sa
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
