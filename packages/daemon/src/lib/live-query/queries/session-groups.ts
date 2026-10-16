export const DEBOUNCE_SESSION_GROUP_MESSAGES_MS = 150;

export function mapSessionGroupMessageRow(row: Record<string, unknown>): Record<string, unknown> {
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
    } catch {}
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

export const SESSION_GROUP_MESSAGES_BY_GROUP_SQL = `
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
sdk_rows_numbered AS (
  SELECT
    r.id AS id,
    r.sessionId AS sessionId,
    r.messageType AS messageType,
    ROW_NUMBER() OVER (
      PARTITION BY r.sessionId
      ORDER BY r.createdAt ASC, r.id ASC
    ) AS rowPos
  FROM sdk_rows_raw r
),
-- Forward-fill the latest user-row position seen in each session up to and
-- including the current row. SQLite ignores NULLs in MAX(), so this carries
-- the most recent user message through subsequent rows. The base WHERE above
-- already restricts user rows to settled ones, so every user row present can
-- anchor a turn. Replaces the former per-row correlated subquery over
-- user_row_starts, which ran an ORDER BY / LIMIT probe for every message of
-- every session in the group and blocked the main thread inside sqlite3_step
-- on large groups (#2660). Both window passes deliberately run over this
-- narrow projection — never r.* — so message payloads stay out of the window
-- sorts; wide columns are joined back only in the final sdk_rows pass.
sdk_row_turns AS (
  SELECT
    n.id AS id,
    MAX(CASE WHEN n.messageType = 'user' THEN n.rowPos END) OVER (
      PARTITION BY n.sessionId
      ORDER BY n.rowPos
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS turnUserRowPos
  FROM sdk_rows_numbered n
),
user_row_starts AS (
  -- Maps the forwarded rowPos back to the user message id with a single join.
  SELECT
    sessionId,
    rowPos AS userRowPos,
    id AS userMessageId
  FROM sdk_rows_numbered
  WHERE messageType = 'user'
),
sdk_rows AS (
  SELECT
    r.id,
    r.groupId,
    r.sessionId,
    r.role,
    r.messageType,
    r.content,
    r.createdAt,
    r.parentToolUseId,
    urs.userMessageId AS turnUserMessageId
  FROM sdk_rows_raw r
  JOIN sdk_row_turns t ON t.id = r.id
  LEFT JOIN user_row_starts urs
    ON urs.sessionId = r.sessionId
   AND urs.userRowPos = t.turnUserRowPos
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
