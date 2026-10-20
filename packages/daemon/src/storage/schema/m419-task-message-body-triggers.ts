import type { Database } from '../sqlite-compat.ts';
import {
  TASK_MESSAGE_BODY_COLUMNS,
  TASK_MESSAGE_BODY_SELECT,
  TASK_MESSAGE_METADATA_SELECT,
  TASK_MESSAGE_ROW_COLUMNS,
} from './task-message-rows.ts';

const columns = [...TASK_MESSAGE_ROW_COLUMNS, ...TASK_MESSAGE_BODY_COLUMNS].join(', ');
const assignments = (names: string[]) => names.map((name) => `${name}=excluded.${name}`).join(', ');
const rowUpsert = `INSERT INTO task_message_rows (${columns})
  SELECT ${TASK_MESSAGE_METADATA_SELECT}, NULL, 0, NULL FROM sdk_messages sm
  WHERE sm.rowid=NEW.rowid AND sm.task_id IS NOT NULL
  ON CONFLICT(id) DO UPDATE SET ${assignments(TASK_MESSAGE_ROW_COLUMNS.slice(1))};`;
const bodySelect = TASK_MESSAGE_BODY_SELECT.replaceAll('sm.sdk_message', 'body.sdk_message');
const bodyUpsert = `INSERT INTO task_message_rows (${columns})
  SELECT ${TASK_MESSAGE_METADATA_SELECT}, ${bodySelect}
  FROM sdk_messages sm JOIN sdk_message_bodies body ON body.seq=sm.rowid
  WHERE sm.rowid=NEW.seq AND sm.task_id IS NOT NULL
  ON CONFLICT(id) DO UPDATE SET ${assignments(TASK_MESSAGE_BODY_COLUMNS)};`;
const reclassifiedBodySelect = TASK_MESSAGE_BODY_SELECT.replaceAll(
  'sm.sdk_message',
  'COALESCE(body.sdk_message,sm.sdk_message)'
);

export function runMigration419(db: Database): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('task_message_rows','sdk_message_bodies')"
    )
    .all();
  if (tables.length !== 2) return;
  db.exec(`CREATE TABLE IF NOT EXISTS sdk_message_body_copy_active (
    singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK(singleton=1)
  )`);
  db.exec('DROP TRIGGER IF EXISTS task_message_rows_ai');
  db.exec('DROP TRIGGER IF EXISTS task_message_rows_au');
  db.exec(`CREATE TRIGGER task_message_rows_ai AFTER INSERT ON sdk_messages
    WHEN NEW.task_id IS NOT NULL BEGIN ${rowUpsert} END`);
  db.exec(`CREATE TRIGGER task_message_rows_au
    AFTER UPDATE OF timestamp,send_status,conversation_turn_index,is_renderable,is_terminal,
      task_id,session_id,parent_tool_use_id ON sdk_messages
    WHEN NEW.task_id IS NOT NULL BEGIN ${rowUpsert} END`);
  for (const [suffix, event] of [
    ['ai', 'INSERT'],
    ['au', 'UPDATE OF sdk_message'],
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS task_message_bodies_${suffix}
      AFTER ${event} ON sdk_message_bodies
      WHEN NOT EXISTS (SELECT 1 FROM sdk_message_body_copy_active)
      BEGIN ${bodyUpsert} END`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS task_message_rows_unassigned
    AFTER UPDATE OF task_id ON sdk_messages WHEN NEW.task_id IS NULL
    BEGIN DELETE FROM task_message_rows WHERE id=OLD.id; END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS task_message_rows_reassigned
    AFTER UPDATE OF task_id ON sdk_messages
    WHEN NEW.task_id IS NOT NULL AND OLD.task_id IS NULL BEGIN
      INSERT INTO task_message_rows (${columns})
      SELECT ${TASK_MESSAGE_METADATA_SELECT}, ${reclassifiedBodySelect}
      FROM sdk_messages sm LEFT JOIN sdk_message_bodies body ON body.seq=sm.rowid
      WHERE sm.rowid=NEW.rowid
      ON CONFLICT(id) DO UPDATE SET ${assignments(TASK_MESSAGE_BODY_COLUMNS)};
    END`);
}
