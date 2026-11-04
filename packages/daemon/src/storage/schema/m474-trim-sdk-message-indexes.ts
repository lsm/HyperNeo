import type { Database } from '../sqlite-compat.ts';

export function runMigration474(db: Database): void {
  if (
    !db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sdk_messages'`).get()
  )
    return;
  db.exec(`
    DROP INDEX IF EXISTS idx_sdk_messages_bg_task_time;
    DROP INDEX IF EXISTS idx_sdk_messages_bg_tool_time;
    DROP INDEX IF EXISTS idx_sdk_messages_task_assistant;
    DROP INDEX IF EXISTS idx_sdk_messages_renderable_terminal;
    DROP INDEX IF EXISTS idx_sdk_messages_task_id;
    DROP INDEX IF EXISTS idx_sdk_messages_task_turn;
    DROP INDEX IF EXISTS idx_sdk_messages_task_session_turn;
    CREATE INDEX idx_sdk_messages_task_id
      ON sdk_messages(task_id, timestamp) WHERE task_id IS NOT NULL;
    CREATE INDEX idx_sdk_messages_task_turn
      ON sdk_messages(task_id, conversation_turn_index) WHERE task_id IS NOT NULL;
    CREATE INDEX idx_sdk_messages_task_session_turn
      ON sdk_messages(task_id, session_id, conversation_turn_index) WHERE task_id IS NOT NULL;
  `);
}
