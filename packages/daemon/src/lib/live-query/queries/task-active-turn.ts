import { spaceTaskFlagRowsBaseCte } from './task-message-window.ts';
import { HOOK_SUBTYPE_NAMES, HOOK_SUBTYPES } from './task-delivery.ts';

export const SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL = `
${spaceTaskFlagRowsBaseCte(false)},
active_rows AS MATERIALIZED (
  SELECT r.*, sm.sdk_message AS content, sm.rowid AS rowId, sm.send_status AS sendStatus,
    sm.info_level AS infoLevel, sm.tool_result_only AS toolResultOnly, sm.hook_id AS hookId
  FROM (
    SELECT
      j.*,
      FIRST_VALUE(j.turnIndex) OVER (
        PARTITION BY j.sessionId ORDER BY j.createdAt DESC, j.insOrder DESC
      ) AS latestTurn,
      MAX(j.isCandidate) OVER (PARTITION BY j.sessionId) AS sessionHasCandidate,
      FIRST_VALUE(j.turnIndex) OVER (
        PARTITION BY j.sessionId ORDER BY j.isCandidate DESC, j.createdAt DESC, j.insOrder DESC
      ) AS candidateTurn,
      FIRST_VALUE(j.isTerminal) OVER (
        PARTITION BY j.sessionId ORDER BY j.isCandidate DESC, j.createdAt DESC, j.insOrder DESC
      ) AS candidateTerminal
    FROM (
      SELECT
        joined.*,
        (sessionId IS NOT NULL AND (
          messageType IN ('assistant', 'result')
          OR (
            messageType = 'system'
            AND COALESCE(jsonSubtype, '') IN ('api_retry', ${HOOK_SUBTYPE_NAMES})
          )
        )) AS isCandidate
      FROM joined
    ) j
  ) r
  JOIN sdk_messages sm ON sm.id = r.id
  WHERE r.sessionId IS NOT NULL
    AND r.sessionHasCandidate
    AND r.candidateTerminal = 0
    AND r.candidateTurn = r.latestTurn
    AND r.turnIndex = r.candidateTurn
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
    ar.rowId AS rowId,
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
  CROSS JOIN
       json_each(
         CASE WHEN json_valid(ar.content)
              THEN json_extract(ar.content, '$.message.content')
              ELSE '[]' END
       ) je
  WHERE ar.messageType = 'assistant'
    AND ar.infoLevel IS NOT NULL
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
    ar.rowId AS rowId,
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
  WHERE ar.messageType = 'user'
    -- Task #862 (review P2): a deferred prompt is explicitly waiting for the
    -- next turn -- keep it in the main thread, but don't show it in the live
    -- active-turn roster as input "inside" the active turn.
    AND COALESCE(ar.sendStatus, 'consumed') != 'deferred'
    AND ar.infoLevel IS NOT NULL
    -- Skip user rows whose content is exclusively tool_result blocks (or
    -- mixes tool_result with empty/whitespace-only text blocks). Such rows
    -- render as null in the compact feed and would otherwise produce a
    -- blank rail entry — the GROUP_CONCAT above already filters empty text,
    -- so the row would survive the filter with textValue = NULL.
    --
    -- Mirrors the assistant-entries filter on lines above, which also
    -- excludes empty-text blocks from contributing to the roster.
    AND COALESCE(ar.toolResultOnly, 0) = 0
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
    ar.rowId AS rowId,
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
      PARTITION BY ar.sessionId, ar.turnIndex, ar.hookId
      -- createdAt ties (same-millisecond hook_started/progress/response) are
      -- broken by insertion order: sdk_messages.id is a random UUID, so join
      -- back to the base table for its implicit rowid, which is monotonic.
      ORDER BY ar.createdAt DESC, ar.rowId DESC
    ) AS rn
  FROM active_rows ar
  WHERE ar.messageType = 'system'
    -- Guard the hook json_extract calls on valid JSON so a single malformed
    -- sdk_message blob can't raise 'malformed JSON' and break the active-turn
    -- subscription. Malformed rows simply don't qualify as hook runs.
    AND ar.infoLevel IS NOT NULL
    AND ar.jsonSubtype IN ${HOOK_SUBTYPES}
    AND ar.hookId IS NOT NULL
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
    ar.rowId AS rowId,
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
  WHERE ar.messageType = 'system'
    AND ar.infoLevel IS NOT NULL
    AND ar.jsonSubtype = 'api_retry'
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
