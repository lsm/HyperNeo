import { spaceTaskFlagRowsBaseCte } from './task-message-window.ts';
import { TASK_MESSAGE_FLAG } from '../../../storage/schema/task-message-rows.ts';
import { HOOK_SUBTYPES, HOOK_SUBTYPE_NAMES } from './task-delivery.ts';

export const MAX_SPACE_TASK_MESSAGES_COMPACT_WINDOW = 100;

export const SPACE_TASK_MESSAGES_COMPACT_TOOL_SUMMARY_LIMIT = 3;

export const SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL = `
${spaceTaskFlagRowsBaseCte(true)},
feed AS MATERIALIZED (
  SELECT
    COALESCE(-githubRowid, insOrder) AS k,
    sessionId,
    turnIndex,
    messageType,
    isRenderable,
    isTerminal,
    flags,
    COALESCE(jsonSubtype, '') AS subtype,
    createdAt,
    insOrder,
    kind,
    id,
    deliveryState
  FROM joined
),
assistant_rank AS MATERIALIZED (
  SELECT
    k,
    sessionId,
    turnIndex,
    flags,
    ROW_NUMBER() OVER (
      PARTITION BY sessionId, turnIndex, flags & ${TASK_MESSAGE_FLAG.text} != 0
      ORDER BY createdAt DESC, insOrder DESC
    ) AS textRank,
    ROW_NUMBER() OVER (
      PARTITION BY sessionId, turnIndex, flags & ${TASK_MESSAGE_FLAG.thinking} != 0
      ORDER BY createdAt DESC, insOrder DESC
    ) AS thinkingRank,
    ROW_NUMBER() OVER (
      PARTITION BY sessionId, turnIndex, flags & ${TASK_MESSAGE_FLAG.toolUse} != 0
      ORDER BY createdAt DESC, insOrder DESC
    ) AS toolRank
  FROM feed
  WHERE messageType = 'assistant'
    AND flags & ${TASK_MESSAGE_FLAG.text | TASK_MESSAGE_FLAG.thinking | TASK_MESSAGE_FLAG.toolUse}
),
segments AS MATERIALIZED (
  SELECT
    sessionId,
    turnIndex,
    MAX(flags & ${TASK_MESSAGE_FLAG.text} != 0) AS hasText,
    MAX(flags & ${TASK_MESSAGE_FLAG.thinking} != 0) AS hasThinking
  FROM assistant_rank
  WHERE turnIndex IS NOT NULL
  GROUP BY sessionId, turnIndex
),
seg_summary AS MATERIALIZED (
  SELECT a.k
  FROM assistant_rank a
  LEFT JOIN segments s ON s.sessionId = a.sessionId AND s.turnIndex = a.turnIndex
  WHERE (a.flags & ${TASK_MESSAGE_FLAG.text} AND a.textRank = 1)
    OR (
      NOT COALESCE(s.hasText, 0)
      AND a.flags & ${TASK_MESSAGE_FLAG.thinking}
      AND a.thinkingRank = 1
    )
    OR (
      NOT COALESCE(s.hasText, 0)
      AND NOT COALESCE(s.hasThinking, 0)
      AND a.flags & ${TASK_MESSAGE_FLAG.toolUse}
      AND a.toolRank <= ${SPACE_TASK_MESSAGES_COMPACT_TOOL_SUMMARY_LIMIT}
    )
),
base_selection AS MATERIALIZED (
  SELECT k FROM feed
  WHERE (messageType = 'user' AND isRenderable = 1)
    OR isTerminal = 1
    OR (messageType = 'system' AND subtype NOT IN ${HOOK_SUBTYPES})
    OR kind = 'github'
    OR messageType = 'hyperneo_action'
    OR (messageType = 'assistant' AND flags & ${TASK_MESSAGE_FLAG.mutatingTool})
  UNION
  SELECT k FROM seg_summary
),
session_latest AS MATERIALIZED (
  SELECT sessionId, turnIndex
  FROM (
    SELECT
      sessionId,
      turnIndex,
      ROW_NUMBER() OVER (PARTITION BY sessionId ORDER BY createdAt DESC, insOrder DESC) AS rn
    FROM feed
    WHERE sessionId IS NOT NULL
  )
  WHERE rn = 1
),
session_candidates AS MATERIALIZED (
  SELECT sessionId, isTerminal, turnIndex
  FROM (
    SELECT
      sessionId,
      isTerminal,
      turnIndex,
      ROW_NUMBER() OVER (PARTITION BY sessionId ORDER BY createdAt DESC, insOrder DESC) AS rn
    FROM feed
    WHERE sessionId IS NOT NULL
      AND (
        messageType IN ('assistant', 'result')
        OR (
          messageType = 'system'
          AND subtype IN ('api_retry', ${HOOK_SUBTYPE_NAMES})
        )
      )
  )
  WHERE rn = 1
),
active_sessions AS MATERIALIZED (
  SELECT c.sessionId
  FROM session_candidates c
  JOIN session_latest l ON l.sessionId = c.sessionId
  WHERE COALESCE(c.isTerminal, 0) = 0
    AND c.turnIndex = l.turnIndex
),
active_session_tails AS MATERIALIZED (
  SELECT k
  FROM (
    SELECT
      f.k,
      f.kind,
      ROW_NUMBER() OVER (PARTITION BY f.sessionId ORDER BY f.createdAt DESC, f.insOrder DESC) AS rn
    FROM feed f
    WHERE f.sessionId IN (SELECT sessionId FROM active_sessions)
      AND (
        f.k IN (SELECT k FROM base_selection)
        OR (f.messageType = 'system' AND f.subtype IN ${HOOK_SUBTYPES})
      )
  )
  WHERE rn = 1
    AND kind != 'github'
),
pinned AS MATERIALIZED (
  SELECT k FROM feed
  WHERE (messageType = 'hyperneo_action' AND flags & ${TASK_MESSAGE_FLAG.unresolvedAction})
    OR (messageType = 'user' AND deliveryState IN ('queued', 'processing', 'retrying'))
    OR id IN (SELECT id FROM artifact_state_rows)
),
ordinary AS MATERIALIZED (
  SELECT k
  FROM (
    SELECT
      f.k,
      ROW_NUMBER() OVER (
        ORDER BY f.createdAt DESC, f.insOrder DESC, f.kind DESC, f.id DESC
      ) AS ordinaryRank
    FROM feed f
    WHERE f.k IN (SELECT k FROM base_selection)
      AND f.k NOT IN (SELECT k FROM pinned)
      AND f.k NOT IN (SELECT k FROM active_session_tails)
  )
  WHERE ordinaryRank <= ?
),
chosen AS MATERIALIZED (
  SELECT k FROM pinned
  WHERE k IN (SELECT k FROM base_selection) OR k IN (SELECT k FROM active_session_tails)
  UNION
  SELECT k FROM active_session_tails
  UNION
  SELECT k FROM ordinary
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
  COALESCE(sm.sdk_message, j.githubContent) AS content,
  CASE WHEN j.kind = 'github' THEN 'system' ELSE sm.origin END AS origin,
  j.deliveryState,
  j.createdAt,
  j.turnIndex,
  j.parentToolUseId,
  j.insOrder
FROM chosen c
JOIN joined j ON COALESCE(-j.githubRowid, j.insOrder) = c.k
LEFT JOIN sdk_messages sm ON sm.id = j.id AND j.kind != 'github'
ORDER BY j.createdAt ASC, j.insOrder ASC, j.kind ASC, j.id ASC
`.trim();
