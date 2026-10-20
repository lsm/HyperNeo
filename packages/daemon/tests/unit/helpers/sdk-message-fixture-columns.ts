import type { Database } from '../../../src/storage/sqlite-compat';
import { runMigration413 } from '../../../src/storage/schema/m413-sdk-message-columns';
import { runMigration418 } from '../../../src/storage/schema/m418-sdk-message-bodies';
import { writeSdkMessageBody } from '../../../src/storage/repositories/sdk-message-body-write';
import {
  SDK_MESSAGE_COLUMN_TYPES,
  deriveSdkMessageColumns,
} from '../../../src/storage/sdk-message-columns';

export function fillSdkMessageFixtureColumns(db: Database): void {
  const columns = db.prepare("PRAGMA table_xinfo('sdk_messages')").all() as { name: string }[];
  if (!columns.length) return;
  runMigration413(db);
  runMigration418(db);
  const taskId = columns.some((column) => column.name === 'task_id')
    ? 'task_id'
    : 'NULL AS task_id';
  const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
  const rows = db
    .prepare(`SELECT rowid AS row_id, sdk_message, ${taskId} FROM sdk_messages`)
    .all() as { row_id: number; sdk_message: string; task_id: string | null }[];
  const update = db.prepare(
    `UPDATE sdk_messages SET ${names.map((key) => `${key} = ?`).join(',')} WHERE rowid = ?`
  );
  for (const row of rows) {
    let derived: ReturnType<typeof deriveSdkMessageColumns> | undefined;
    try {
      if (typeof row.sdk_message === 'string')
        derived = deriveSdkMessageColumns(JSON.parse(row.sdk_message), row.task_id);
    } catch {}
    writeSdkMessageBody(
      db,
      () => update.run(...names.map((key) => derived?.[key] ?? null), row.row_id),
      'rowid=?',
      [row.row_id]
    );
  }
}
