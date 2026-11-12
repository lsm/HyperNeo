import {
  activeDeliveryJobsCtes,
  ACTIVE_DELIVERY_RETRYING_CTE_SQL,
  NODE_EXECUTION_RELEVANCE_ORDER,
  TASK_AGENT_SESSION_PREDICATE,
  deliveryStateCase,
} from './task-delivery.ts';
import { TASK_MESSAGE_FLAG } from '../../../storage/schema/task-message-rows.ts';

export const SPACE_TASK_MESSAGES_COMPACT_RECENT_TURNS = 100;

const SPACE_TASK_MESSAGES_COMPACT_ARTIFACT_PIN_LIMIT = 100;

const SPACE_TASK_CONV_ARTIFACT_STATE_CTES = `artifact_keys AS MATERIALIZED (
  SELECT
    tm.id AS id,
    tm.session_id AS sessionId,
    tm.created_at AS createdAt,
    tm.seq AS insOrder,
    k.value AS artifactKey
  FROM task_message_rows tm, json_each(tm.artifact_keys) k
  WHERE tm.task_id = (SELECT id FROM target_task)
    AND tm.artifact_keys IS NOT NULL
),
artifact_state_rows AS (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (ORDER BY createdAt DESC, insOrder DESC) AS pinRank
    FROM (
      SELECT id, createdAt, insOrder FROM (
        SELECT
          id,
          createdAt,
          insOrder,
          ROW_NUMBER() OVER (
            PARTITION BY artifactKey ORDER BY createdAt DESC, insOrder DESC
          ) AS pathRank
        FROM artifact_keys
        WHERE artifactKey LIKE 'file:%'
      ) WHERE pathRank = 1
      UNION
      SELECT id, createdAt, insOrder FROM (
        SELECT
          id,
          createdAt,
          insOrder,
          ROW_NUMBER() OVER (
            PARTITION BY sessionId ORDER BY createdAt DESC, insOrder DESC
          ) AS sessionRank
        FROM artifact_keys
        WHERE artifactKey = 'todo'
      ) WHERE sessionRank = 1
    )
  ) WHERE pinRank <= ${SPACE_TASK_MESSAGES_COMPACT_ARTIFACT_PIN_LIMIT}
),
`;

export function spaceTaskFlagRowsBaseCte(admitArtifactState: boolean): string {
  return `
WITH target_task AS (
  SELECT *
  FROM space_tasks
  WHERE id = ?
),
task_sessions AS MATERIALIZED (
  SELECT DISTINCT session_id
  FROM task_message_rows
  WHERE task_id = (SELECT id FROM target_task)
),
${activeDeliveryJobsCtes(`AND json_extract(jq.payload, '$.sessionId') IN (SELECT session_id FROM task_sessions)`)},
${ACTIVE_DELIVERY_RETRYING_CTE_SQL},
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
    ) AS githubContent,
    'delivered' AS deliveryState,
    ge.occurred_at AS createdAt,
    NULL AS parentToolUseId,
    1 AS isRenderable,
    0 AS isTerminal,
    NULL AS turnIndex,
    ge.rowid AS insOrder,
    0 AS flags,
    NULL AS jsonSubtype,
    ge.rowid AS githubRowid
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
             ${NODE_EXECUTION_RELEVANCE_ORDER}
         ) AS rn
  FROM target_task tt
  JOIN node_executions ne
    ON ne.workflow_run_id = tt.workflow_run_id
   AND ne.agent_session_id IS NOT NULL
),
session_labels AS MATERIALIZED (
  SELECT
    ts.session_id AS sessionId,
    sne.node_execution_id AS nodeExecutionId,
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
    END AS label
  FROM task_sessions ts
  LEFT JOIN sessions s_kind ON s_kind.id = ts.session_id
  LEFT JOIN session_node_exec sne
    ON sne.task_id = (SELECT id FROM target_task)
   AND sne.session_id = ts.session_id
   AND sne.rn = 1
  LEFT JOIN space_long_horizon_agents sa
    ON sa.id = COALESCE(sne.agent_id, json_extract(s_kind.metadata, '$.promptProvenance.agentId'))
),
recent_turns AS (
  SELECT COALESCE(MIN(turn_index), 0) AS minTurn
  FROM (
    SELECT DISTINCT turn_index
    FROM task_message_rows
    WHERE task_id = (SELECT id FROM target_task)
      AND turn_index IS NOT NULL
    ORDER BY turn_index DESC
    LIMIT ${SPACE_TASK_MESSAGES_COMPACT_RECENT_TURNS}
  )
),
task_shutdown_boundaries AS MATERIALIZED (
  SELECT session_id, id, created_at
  FROM (
    SELECT
      tm.session_id AS session_id,
      tm.id AS id,
      tm.created_at AS created_at,
      ROW_NUMBER() OVER (
        PARTITION BY tm.session_id
        ORDER BY tm.created_at DESC, tm.id DESC
      ) AS rn
    FROM task_message_rows tm
    WHERE tm.task_id = (SELECT id FROM target_task)
      AND tm.parent_tool_use_id IS NULL
      AND (tm.message_type != 'user' OR COALESCE(tm.send_status, 'consumed') IN ('consumed', 'failed'))
  )
  WHERE rn = 1
),
${admitArtifactState ? SPACE_TASK_CONV_ARTIFACT_STATE_CTES : ''}sdk_rows AS (
  SELECT
    tm.id AS id,
    tm.session_id AS sessionId,
    sl.kind AS kind,
    sl.role AS role,
    sl.label AS label,
    sl.nodeExecutionId AS nodeExecutionId,
    tt.id AS taskId,
    tt.title AS taskTitle,
    tm.message_type AS messageType,
    NULL AS githubContent,
    ${deliveryStateCase('tm')},
    tm.created_at AS createdAt,
    tm.parent_tool_use_id AS parentToolUseId,
    tm.is_renderable AS isRenderable,
    tm.is_terminal AS isTerminal,
    tm.turn_index AS turnIndex,
    tm.seq AS insOrder,
    tm.flags AS flags,
    tm.json_subtype AS jsonSubtype,
    NULL AS githubRowid
  FROM target_task tt
  JOIN task_message_rows tm ON tm.task_id = tt.id
  LEFT JOIN active_delivery_retrying adr
    ON adr.message_uuid = tm.sdk_uuid
   AND adr.session_id = tm.session_id
  CROSS JOIN recent_turns rt
  LEFT JOIN session_labels sl ON sl.sessionId = tm.session_id
  WHERE (
    tm.turn_index >= rt.minTurn
    OR (
      tm.message_type = 'user'
      AND COALESCE(tm.send_status, 'consumed') NOT IN ('consumed', 'failed')
    )
    OR (tm.message_type = 'hyperneo_action' AND tm.flags & ${TASK_MESSAGE_FLAG.unresolvedAction})
    ${admitArtifactState ? 'OR tm.id IN (SELECT id FROM artifact_state_rows)' : ''}
  )
    AND (
      tm.message_type != 'system'
      OR COALESCE(tm.message_subtype, '') != 'informational'
      OR NOT tm.flags & ${TASK_MESSAGE_FLAG.infoLevel}
    )
    AND (
      tm.message_type != 'system'
      OR COALESCE(tm.message_subtype, '') != 'worker_shutting_down'
      OR (
        tm.parent_tool_use_id IS NULL
        AND tm.id IN (SELECT id FROM task_shutdown_boundaries)
      )
      OR (
        tm.parent_tool_use_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM task_shutdown_boundaries boundary
          WHERE boundary.session_id = tm.session_id
            AND (
              boundary.created_at > tm.created_at
              OR (boundary.created_at = tm.created_at AND boundary.id > tm.id)
            )
        )
      )
    )
),
joined AS MATERIALIZED (
  SELECT * FROM github_events
  UNION ALL
  SELECT * FROM sdk_rows
)`.trim();
}
