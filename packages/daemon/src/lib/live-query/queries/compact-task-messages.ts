import { sdkMessageBodyAt } from '../../../storage/repositories/sdk-message-body-read.ts';
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
ranked AS MATERIALIZED (
  SELECT
    f.*,
    ROW_NUMBER() OVER (
      PARTITION BY isAssistantRow, sessionId, turnIndex, flags & ${TASK_MESSAGE_FLAG.text} != 0
      ORDER BY createdAt DESC, insOrder DESC
    ) AS textRank,
    ROW_NUMBER() OVER (
      PARTITION BY isAssistantRow, sessionId, turnIndex, flags & ${TASK_MESSAGE_FLAG.thinking} != 0
      ORDER BY createdAt DESC, insOrder DESC
    ) AS thinkingRank,
    ROW_NUMBER() OVER (
      PARTITION BY isAssistantRow, sessionId, turnIndex, flags & ${TASK_MESSAGE_FLAG.toolUse} != 0
      ORDER BY createdAt DESC, insOrder DESC
    ) AS toolRank,
    CASE WHEN sessionId IS NOT NULL AND turnIndex IS NOT NULL THEN MAX(
      isAssistantRow AND flags & ${TASK_MESSAGE_FLAG.text} != 0
    ) OVER (PARTITION BY sessionId, turnIndex) ELSE 0 END AS turnHasText,
    CASE WHEN sessionId IS NOT NULL AND turnIndex IS NOT NULL THEN MAX(
      isAssistantRow AND flags & ${TASK_MESSAGE_FLAG.thinking} != 0
    ) OVER (PARTITION BY sessionId, turnIndex) ELSE 0 END AS turnHasThinking,
    FIRST_VALUE(turnIndex) OVER (
      PARTITION BY sessionId ORDER BY createdAt DESC, insOrder DESC
    ) AS latestTurn,
    MAX(isCandidate) OVER (PARTITION BY sessionId) AS sessionHasCandidate,
    FIRST_VALUE(turnIndex) OVER (
      PARTITION BY sessionId ORDER BY isCandidate DESC, createdAt DESC, insOrder DESC
    ) AS candidateTurn,
    FIRST_VALUE(isTerminal) OVER (
      PARTITION BY sessionId ORDER BY isCandidate DESC, createdAt DESC, insOrder DESC
    ) AS candidateTerminal
  FROM (
    SELECT
      feed.*,
      (messageType = 'assistant'
        AND flags & ${TASK_MESSAGE_FLAG.text | TASK_MESSAGE_FLAG.thinking | TASK_MESSAGE_FLAG.toolUse}
      ) != 0 AS isAssistantRow,
      (sessionId IS NOT NULL AND (
        messageType IN ('assistant', 'result')
        OR (messageType = 'system' AND subtype IN ('api_retry', ${HOOK_SUBTYPE_NAMES}))
      )) AS isCandidate
    FROM feed
  ) f
),
marks AS MATERIALIZED (
  SELECT
    k,
    sessionId,
    kind,
    id,
    createdAt,
    insOrder,
    (messageType = 'user' AND isRenderable = 1)
      OR isTerminal = 1
      OR (messageType = 'system' AND subtype NOT IN ${HOOK_SUBTYPES})
      OR kind = 'github'
      OR messageType = 'hyperneo_action'
      OR (messageType = 'assistant' AND flags & ${TASK_MESSAGE_FLAG.mutatingTool})
      OR (isAssistantRow AND (
        (flags & ${TASK_MESSAGE_FLAG.text} AND textRank = 1)
        OR (NOT turnHasText AND flags & ${TASK_MESSAGE_FLAG.thinking} AND thinkingRank = 1)
        OR (
          NOT turnHasText
          AND NOT turnHasThinking
          AND flags & ${TASK_MESSAGE_FLAG.toolUse}
          AND toolRank <= ${SPACE_TASK_MESSAGES_COMPACT_TOOL_SUMMARY_LIMIT}
        )
      )) AS isBase,
    (messageType = 'hyperneo_action' AND flags & ${TASK_MESSAGE_FLAG.unresolvedAction})
      OR (messageType = 'user' AND deliveryState IN ('queued', 'processing', 'retrying'))
      OR id IN (SELECT id FROM artifact_state_rows) AS isPinned,
    sessionId IS NOT NULL
      AND sessionHasCandidate
      AND COALESCE(candidateTerminal, 0) = 0
      AND candidateTurn = latestTurn AS inActiveSession,
    messageType = 'system' AND subtype IN ${HOOK_SUBTYPES} AS isHook
  FROM ranked
),
active_session_tails AS MATERIALIZED (
  SELECT k
  FROM (
    SELECT
      k,
      kind,
      ROW_NUMBER() OVER (PARTITION BY sessionId ORDER BY createdAt DESC, insOrder DESC) AS rn
    FROM marks
    WHERE inActiveSession AND (isBase OR isHook)
  )
  WHERE rn = 1
    AND kind != 'github'
),
ordinary AS MATERIALIZED (
  SELECT k
  FROM (
    SELECT
      k,
      ROW_NUMBER() OVER (
        ORDER BY createdAt DESC, insOrder DESC, kind DESC, id DESC
      ) AS ordinaryRank
    FROM marks
    WHERE isBase
      AND NOT isPinned
      AND k NOT IN (SELECT k FROM active_session_tails)
  )
  WHERE ordinaryRank <= ?
),
chosen AS MATERIALIZED (
  SELECT k FROM marks
  WHERE isPinned AND (isBase OR k IN (SELECT k FROM active_session_tails))
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
  COALESCE(${sdkMessageBodyAt('sm.rowid')}, j.githubContent) AS content,
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
