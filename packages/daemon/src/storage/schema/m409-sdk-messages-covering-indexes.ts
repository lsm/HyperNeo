import type { Database } from '../sqlite-compat.ts';

export function runMigration409(db: Database): void {
  const columns = new Set(
    (
      db.prepare("SELECT name FROM pragma_table_xinfo('sdk_messages')").all() as { name: string }[]
    ).map((column) => column.name)
  );
  if (!columns.size) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_visible
    ON sdk_messages(session_id, parent_tool_use_id, timestamp, id, message_type, send_status,
      message_subtype)`);
  if (columns.has('message_subtype_norm'))
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_subtype_time
      ON sdk_messages(session_id, message_subtype_norm, parent_tool_use_id, timestamp)`);
}
