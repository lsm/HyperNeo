import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type { TableChangeScope } from '../../../storage/reactive-database.ts';

export const NODE_EXECUTION_RELEVANCE_ORDER = `CASE ne.status
               WHEN 'in_progress' THEN 0
               WHEN 'waiting_rebind' THEN 1
               WHEN 'blocked' THEN 2
               WHEN 'pending' THEN 3
               ELSE 4
             END,
             ne.updated_at DESC,
             ne.created_at DESC,
             ne.id DESC`;

export const TASK_AGENT_SESSION_PREDICATE = `sne.node_execution_id IS NULL AND json_extract(s_kind.metadata, '$.promptProvenance.nodeId') IS NULL
        AND NOT EXISTS (SELECT 1 FROM direct_task_session_provenance dtp WHERE dtp.session_id = s_kind.id)`;

export const ACTIVE_DELIVERY_RETRYING_CTE_SQL = `active_delivery_retrying AS MATERIALIZED (
  SELECT message_uuid, session_id, MAX(retry_count) > 0 AS retrying
  FROM active_delivery_candidates
  GROUP BY message_uuid, session_id
)`;

export const HOOK_SUBTYPE_NAMES = `'hook_started', 'hook_progress', 'hook_response'`;

export const HOOK_SUBTYPES = `(${HOOK_SUBTYPE_NAMES})`;

export function deliveryStateCase(alias: string): string {
  return `CASE
      WHEN ${alias}.message_type != 'user' THEN NULL
      WHEN COALESCE(${alias}.send_status, 'consumed') = 'failed' THEN 'failed'
      WHEN adr.retrying THEN 'retrying'
      WHEN COALESCE(${alias}.send_status, 'consumed') = 'consumed' THEN 'delivered'
      WHEN COALESCE(${alias}.send_status, 'consumed') = 'submitted' THEN 'processing'
      ELSE 'queued'
    END AS deliveryState`;
}

export const TASK_SHUTDOWN_BOUNDARY_CTE_SQL = `
-- Newest settled top-level row per contributing session of the task. A
-- worker_shutting_down banner stays visible only while nothing newer has
-- settled in its session+task: a top-level banner while it IS this
-- boundary, a nested (subagent-origin) banner while it postdates the
-- boundary — matching the unbounded per-row EXISTS this replaces, minus
-- its CORRELATED SCALAR SUBQUERY / MULTI-INDEX OR plan shape. Task-scoped
-- sibling of messages.bySession's latest_shutdown_boundary.
task_shutdown_boundaries AS MATERIALIZED (
  SELECT session_id, id, timestamp
  FROM (
    SELECT
      sm.session_id AS session_id,
      sm.id AS id,
      sm.timestamp AS timestamp,
      ROW_NUMBER() OVER (
        PARTITION BY sm.session_id
        ORDER BY sm.timestamp DESC, sm.id DESC
      ) AS rn
    FROM target_task tt
    JOIN sdk_messages sm ON sm.task_id = tt.id
    WHERE sm.parent_tool_use_id IS NULL
      AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
  )
  WHERE rn = 1
)`;

export const WORKER_SHUTDOWN_TAIL_FILTER_SQL = `AND (
      sm.message_type != 'system'
      OR sm.message_subtype_norm != 'worker_shutting_down'
      OR (
        sm.parent_tool_use_id IS NULL
        AND sm.id IN (SELECT id FROM task_shutdown_boundaries)
      )
      OR (
        sm.parent_tool_use_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM task_shutdown_boundaries boundary
          WHERE boundary.session_id = sm.session_id
            AND (
              boundary.timestamp > sm.timestamp
              OR (boundary.timestamp = sm.timestamp AND boundary.id > sm.id)
            )
        )
      )
    )`;

export function activeDeliveryJobsCtes(sessionFilterSql: string = ''): string {
  const sessionFilter = sessionFilterSql.length > 0 ? `\n    ${sessionFilterSql}` : '';
  return `active_delivery_jobs AS MATERIALIZED (
  SELECT
    jq.rowid AS job_rowid,
    json_extract(jq.payload, '$.sessionId') AS session_id,
    json_extract(jq.payload, '$.messageUuid') AS message_uuid,
    jq.retry_count,
    jq.run_at,
    jq.max_retries
  FROM job_queue jq
  WHERE jq.queue = 'message_delivery'
    AND jq.status IN ('pending', 'processing')${sessionFilter}
),
active_delivery_candidates AS (
  SELECT
    message_uuid,
    session_id,
    job_rowid,
    retry_count,
    run_at,
    max_retries
  FROM active_delivery_jobs
  WHERE message_uuid IS NOT NULL
)`;
}

export function buildTaskScopeFilter(
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
  } catch {}
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
  } catch {}
  try {
    const messageSessions = db
      .prepare('SELECT DISTINCT session_id FROM sdk_messages WHERE task_id = ?')
      .all(taskId) as Array<{ session_id: string }>;
    for (const row of messageSessions) {
      if (row.session_id) linkedSessions.add(row.session_id);
    }
  } catch {}

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
