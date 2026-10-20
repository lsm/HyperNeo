import { sdkMessageBodyAt } from '../../../storage/repositories/sdk-message-body-read.ts';
import { capMessageOutput } from '../../rpc-handlers/message-output-cap.ts';
import {
  activeDeliveryJobsCtes,
  ACTIVE_DELIVERY_RETRYING_CTE_SQL,
  deliveryStateCase,
  NODE_EXECUTION_RELEVANCE_ORDER,
  TASK_SHUTDOWN_BOUNDARY_CTE_SQL,
  TASK_AGENT_SESSION_PREDICATE,
  WORKER_SHUTDOWN_TAIL_FILTER_SQL,
} from './task-delivery.ts';

export const DEBOUNCE_SPACE_TASK_FEEDS_MS = 250;

export function mapSpaceTaskMessageRow(row: Record<string, unknown>): Record<string, unknown> {
  const sessionId = typeof row.sessionId === 'string' ? row.sessionId : null;
  const role = row.role == null ? '' : String(row.role);
  const label = row.label == null ? '' : String(row.label);
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
      ...capMessageOutput(parsed),
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
  } catch {}

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

const ACTIVE_DELIVERY_RETRYING_CTE = `${activeDeliveryJobsCtes(`AND json_extract(jq.payload, '$.sessionId') IN (
    SELECT session_id
    FROM sdk_messages
    WHERE task_id = (SELECT id FROM target_task)
  )`)},
${ACTIVE_DELIVERY_RETRYING_CTE_SQL}`;

const SPACE_TASK_DELIVERY_STATE_CASE = `${deliveryStateCase('sm')},`;

const SPACE_TASK_MESSAGES_BASE_CTE = `
WITH target_task AS (
  SELECT *
  FROM space_tasks
  WHERE id = ?
),
${ACTIVE_DELIVERY_RETRYING_CTE},
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
    ge.rowid AS insOrder
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
             ${NODE_EXECUTION_RELEVANCE_ORDER}
         ) AS rn
  FROM target_task tt
  JOIN node_executions ne
    ON ne.workflow_run_id = tt.workflow_run_id
   AND ne.agent_session_id IS NOT NULL
),
${TASK_SHUTDOWN_BOUNDARY_CTE_SQL},
sdk_rows_raw AS (
  SELECT
    sm.id AS id,
    sm.session_id AS sessionId,
    -- Task Agent vs node-agent classification — a session that ran a workflow
    -- node (node_executions row, or a declared promptProvenance.nodeId) is a
    -- node agent; the task-level agent has neither. Keying on that rather than
    -- the task's current task_agent_session_id pointer keeps historical rows
    -- attributed when the pointer is rotated or cleared.
    -- A direct-task worker is also execution-less and provenance-less, but it
    -- is not the task's agent: its messages stay unlabelled rather than
    -- borrowing the Task Agent identity.
    CASE
      WHEN ${TASK_AGENT_SESSION_PREDICATE} THEN 'task_agent'
      ELSE 'node_agent'
    END AS kind,
    CASE
      WHEN ${TASK_AGENT_SESSION_PREDICATE} THEN 'task-agent'
      ELSE COALESCE(sne.agent_name, json_extract(s_kind.metadata, '$.promptProvenance.agentName'))
    END AS role,
    CASE
      WHEN ${TASK_AGENT_SESSION_PREDICATE} THEN 'Task Agent'
      ELSE COALESCE(sa.display_name, sne.agent_name, json_extract(s_kind.metadata, '$.promptProvenance.agentName'))
    END AS label,
    sne.node_execution_id AS nodeExecutionId,
    tt.id AS taskId,
    tt.title AS taskTitle,
    sm.message_type AS messageType,
    ${sdkMessageBodyAt('sm.rowid')} AS content,
    sm.origin AS origin,
    ${SPACE_TASK_DELIVERY_STATE_CASE}
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
  LEFT JOIN active_delivery_retrying adr
    ON adr.message_uuid = sm.sdk_uuid
   AND adr.session_id = sm.session_id
  LEFT JOIN sessions s_kind ON s_kind.id = sm.session_id
  LEFT JOIN session_node_exec sne
    ON sne.task_id = tt.id
   AND sne.session_id = sm.session_id
   AND sne.rn = 1
  LEFT JOIN space_long_horizon_agents sa
    ON sa.id = COALESCE(sne.agent_id, json_extract(s_kind.metadata, '$.promptProvenance.agentId'))
  WHERE (
      sm.message_type != 'system'
      OR sm.message_subtype_norm != 'informational'
      OR COALESCE(sm.info_level, 0) != 1
    )
    ${WORKER_SHUTDOWN_TAIL_FILTER_SQL}
),
sdk_rows_numbered AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (
      PARTITION BY r.sessionId
      ORDER BY r.createdAt ASC, r.insOrder ASC
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

export const SPACE_TASK_MESSAGES_BY_TASK_SQL = `
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
  parentToolUseId,
  insOrder
FROM joined
ORDER BY createdAt ASC, insOrder ASC, kind ASC, id ASC
`.trim();
