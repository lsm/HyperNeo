import type { Database as BunDatabase } from '../sqlite-compat.ts';

export const TASK_MESSAGE_FLAG = {
  text: 1,
  thinking: 2,
  toolUse: 4,
  mutatingTool: 8,
  validJson: 16,
  infoLevel: 32,
  unresolvedAction: 64,
} as const;

const F = TASK_MESSAGE_FLAG;

function blockFlag(condition: string, bit: number): string {
  return `MAX(CASE WHEN ${condition} THEN ${bit} ELSE 0 END)`;
}

const BLOCK_TYPE = "json_extract(b.value, '$.type')";

const ASSISTANT_BLOCK_FLAGS = `(
  SELECT COALESCE(
    ${blockFlag(`${BLOCK_TYPE} = 'text' AND TRIM(COALESCE(json_extract(b.value, '$.text'), '')) != ''`, F.text)}
    | ${blockFlag(`${BLOCK_TYPE} = 'thinking' AND TRIM(COALESCE(json_extract(b.value, '$.thinking'), '')) != ''`, F.thinking)}
    | ${blockFlag(`${BLOCK_TYPE} = 'tool_use'`, F.toolUse)}
    | ${blockFlag(`${BLOCK_TYPE} = 'tool_use' AND json_extract(b.value, '$.name') IN ('Write', 'Edit', 'MultiEdit', 'TodoWrite')`, F.mutatingTool)},
    0)
  FROM json_each(
    CASE
      WHEN sm.message_type = 'assistant'
        AND json_valid(sm.sdk_message)
        AND json_type(sm.sdk_message, '$.message.content') = 'array'
      THEN sm.sdk_message
    END,
    '$.message.content'
  ) b
  WHERE json_valid(b.value) AND json_type(b.value) = 'object'
)`;

const MESSAGE_FLAGS = `CASE WHEN json_valid(sm.sdk_message) THEN
    ${F.validJson}
    | CASE WHEN json_extract(sm.sdk_message, '$.level') = 'info' THEN ${F.infoLevel} ELSE 0 END
    | CASE
        WHEN sm.message_type = 'hyperneo_action'
          AND COALESCE(json_extract(sm.sdk_message, '$.resolved'), 1) = 0
        THEN ${F.unresolvedAction}
        ELSE 0
      END
    | ${ASSISTANT_BLOCK_FLAGS}
  ELSE 0 END`;

const ARTIFACT_BLOCK_IS_VALID = `CASE
      WHEN json_valid(b.value) THEN CASE
        WHEN json_type(b.value) = 'object' THEN 1
        ELSE 0
      END
      ELSE 0
    END
    AND json_type(b.value, '$.id') = 'text'
    AND json_extract(b.value, '$.type') = 'tool_use'
    AND (
      json_extract(b.value, '$.name') NOT IN ('Write', 'Edit', 'MultiEdit')
      OR CASE
        WHEN json_extract(b.value, '$.name') = 'Write' THEN
          json_type(b.value, '$.input.file_path') = 'text'
          AND json_type(b.value, '$.input.content') = 'text'
        WHEN json_extract(b.value, '$.name') = 'Edit' THEN
          json_type(b.value, '$.input.file_path') = 'text'
          AND json_type(b.value, '$.input.old_string') = 'text'
          AND json_type(b.value, '$.input.new_string') = 'text'
        ELSE
          json_type(b.value, '$.input.file_path') = 'text'
          AND EXISTS (
            SELECT 1 FROM (
              SELECT me.value AS editValue
              FROM json_each(b.value, '$.input.edits') me
              WHERE CASE
                WHEN json_valid(me.value) THEN CASE
                  WHEN json_type(me.value) = 'object' THEN 1
                  ELSE 0
                END
                ELSE 0
              END
              ORDER BY me.key
              LIMIT 1
            ) firstEdit
            WHERE json_type(firstEdit.editValue, '$.old_string') = 'text'
              AND json_type(firstEdit.editValue, '$.new_string') = 'text'
          )
      END
    )
    AND (
      json_extract(b.value, '$.name') != 'TodoWrite'
      OR (
        json_type(b.value, '$.input.todos') = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(b.value, '$.input.todos') te
          WHERE CASE
            WHEN json_valid(te.value) THEN CASE
              WHEN json_type(te.value) = 'object' THEN CASE
                WHEN json_type(te.value, '$.content') = 'text'
                  THEN json_type(te.value, '$.status') != 'text'
                ELSE 1
              END
              ELSE 1
            END
            ELSE 1
          END
        )
      )
    )`;

const ARTIFACT_KEYS = `(
  SELECT json_group_array(artifactKey)
  FROM (
    SELECT DISTINCT
      CASE
        WHEN json_extract(b.value, '$.name') = 'TodoWrite' THEN 'todo'
        ELSE 'file:' || json_extract(b.value, '$.input.file_path')
      END AS artifactKey
    FROM json_each(
      CASE
        WHEN sm.message_type = 'assistant'
          AND json_valid(sm.sdk_message)
          AND json_type(sm.sdk_message, '$.message.content') = 'array'
        THEN sm.sdk_message
      END,
      '$.message.content'
    ) b
    WHERE ${ARTIFACT_BLOCK_IS_VALID}
      AND json_extract(b.value, '$.name') IN ('Write', 'Edit', 'MultiEdit', 'TodoWrite')
  )
  HAVING COUNT(*) > 0
)`;

const TASK_MESSAGE_ROW_SELECT = `SELECT
    sm.id,
    sm.task_id,
    sm.session_id,
    sm.rowid,
    CAST(ROUND((julianday(sm.timestamp) - 2440587.5) * 86400000) AS INTEGER),
    sm.message_type,
    sm.message_subtype,
    CASE WHEN json_valid(sm.sdk_message) THEN json_extract(sm.sdk_message, '$.subtype') END,
    sm.send_status,
    sm.is_renderable,
    sm.is_terminal,
    sm.parent_tool_use_id,
    sm.conversation_turn_index,
    sm.sdk_uuid,
    ${MESSAGE_FLAGS},
    ${ARTIFACT_KEYS}
  FROM sdk_messages sm`;

const INSERT_ROWS = `INSERT OR REPLACE INTO task_message_rows (
    id, task_id, session_id, seq, created_at, message_type, message_subtype, json_subtype,
    send_status, is_renderable, is_terminal, parent_tool_use_id, turn_index, sdk_uuid, flags,
    artifact_keys
  )
  ${TASK_MESSAGE_ROW_SELECT}`;

const UPSERT_ROW = `${INSERT_ROWS}
  WHERE sm.rowid = NEW.rowid AND sm.task_id IS NOT NULL;`;

export function createTaskMessageRows(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_message_rows (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      json_subtype TEXT,
      send_status TEXT,
      is_renderable INTEGER NOT NULL,
      is_terminal INTEGER NOT NULL,
      parent_tool_use_id TEXT,
      turn_index INTEGER,
      sdk_uuid TEXT,
      flags INTEGER NOT NULL,
      artifact_keys TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_message_rows_task
    ON task_message_rows(task_id, created_at, seq)`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS task_message_rows_ai
    AFTER INSERT ON sdk_messages WHEN NEW.task_id IS NOT NULL BEGIN
      ${UPSERT_ROW}
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS task_message_rows_au
    AFTER UPDATE OF sdk_message, timestamp, send_status, conversation_turn_index,
      is_renderable, is_terminal, task_id, session_id, parent_tool_use_id
    ON sdk_messages BEGIN
      DELETE FROM task_message_rows WHERE id = OLD.id;
      ${UPSERT_ROW}
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS task_message_rows_ad
    AFTER DELETE ON sdk_messages BEGIN
      DELETE FROM task_message_rows WHERE id = OLD.id;
    END
  `);
}

export function ensureTaskMessageRows(db: BunDatabase, taskId: string): void {
  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM sdk_messages WHERE task_id = ?1) AS messages,
        (SELECT COUNT(*) FROM task_message_rows WHERE task_id = ?1) AS projected`
    )
    .get(taskId) as { messages: number; projected: number };
  if (counts.messages === counts.projected) return;
  db.prepare(`${INSERT_ROWS} WHERE sm.task_id = ?`).run(taskId);
}

export function addTaskMessageArtifactKeys(db: BunDatabase): void {
  const columns = db.prepare('PRAGMA table_info(task_message_rows)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'artifact_keys'))
    db.exec('ALTER TABLE task_message_rows ADD COLUMN artifact_keys TEXT');
  db.exec('DROP TRIGGER IF EXISTS task_message_rows_ai');
  db.exec('DROP TRIGGER IF EXISTS task_message_rows_au');
  createTaskMessageRows(db);
  db.exec(`UPDATE task_message_rows
    SET artifact_keys = (SELECT ${ARTIFACT_KEYS} FROM sdk_messages sm WHERE sm.id = task_message_rows.id)
    WHERE flags & ${F.mutatingTool}`);
}
