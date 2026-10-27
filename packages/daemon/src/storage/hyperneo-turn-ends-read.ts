import type { Database as BunDatabase } from './sqlite-compat.ts';
import type { WorkDetail } from '../lib/drivers/types.ts';
import { workEntryTime } from '../lib/drivers/work-messages.ts';
import { sdkMessageBodyAt } from './repositories/sdk-message-body-read.ts';

export function readHyperneoTurnEnds(
  db: BunDatabase,
  sessionId: string,
  since?: number
): NonNullable<WorkDetail['turnEnds']> {
  if (since === undefined) return [];
  const rows = db
    .prepare(`SELECT CAST(m.rowid AS TEXT) AS id, m.timestamp,
    (SELECT p.timestamp FROM sdk_messages p WHERE p.session_id=m.session_id
      AND p.parent_tool_use_id IS NULL AND p.rowid<m.rowid
      AND p.message_type IN ('user','result') AND COALESCE(p.internal_compaction_turn,0)=0
      AND COALESCE(p.tool_result_only,0)=0 ORDER BY p.rowid DESC LIMIT 1) AS started_at,
    COALESCE(NULLIF(json_extract(${sdkMessageBodyAt('m.rowid')}, '$.result'), ''),
      (SELECT group_concat(json_extract(block.value, '$.text'), char(10)) FROM json_each((
        SELECT CASE json_type(${sdkMessageBodyAt('a.rowid')}, '$.message.content')
          WHEN 'array' THEN json_extract(${sdkMessageBodyAt('a.rowid')}, '$.message.content') ELSE '[]' END
        FROM sdk_messages a WHERE a.session_id=m.session_id AND a.message_type='assistant'
          AND a.parent_tool_use_id IS NULL AND a.rowid<m.rowid AND COALESCE(a.internal_compaction_turn,0)=0
          AND a.rowid>COALESCE((SELECT MAX(p.rowid) FROM sdk_messages p
            WHERE p.session_id=m.session_id AND p.message_type='result' AND p.parent_tool_use_id IS NULL
              AND COALESCE(p.internal_compaction_turn,0)=0 AND p.rowid<m.rowid
              AND NOT (COALESCE(p.recovery_intercepted,0)=1 AND COALESCE(p.recovery_billing_terminal,0)=0)),0)
        ORDER BY a.rowid DESC LIMIT 1
      )) block WHERE json_extract(block.value, '$.type')='text'), '') AS message
    FROM sdk_messages m WHERE m.session_id=? AND m.message_type='result' AND m.parent_tool_use_id IS NULL
      AND COALESCE(m.internal_compaction_turn,0)=0
      AND NOT (COALESCE(m.recovery_intercepted,0)=1 AND COALESCE(m.recovery_billing_terminal,0)=0)
      AND m.timestamp>? ORDER BY m.rowid`)
    .all(sessionId, new Date(since).toISOString()) as {
    id: string;
    timestamp: string;
    started_at: string | null;
    message: string;
  }[];
  return rows.flatMap((row) => {
    const at = workEntryTime(row.timestamp);
    const startedAt = workEntryTime(row.started_at);
    return at === undefined ? [] : [{ id: row.id, at, startedAt, message: row.message }];
  });
}
