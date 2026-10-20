import type { Database } from '../../../src/storage/sqlite-compat';
import {
  SDK_MESSAGE_COLUMN_TYPES,
  deriveSdkMessageColumns,
} from '../../../src/storage/sdk-message-columns';

export function fillSdkMessageFixtureColumns(db: Database): void {
  const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
  const rows = db
    .prepare('SELECT rowid AS row_id, sdk_message, task_id FROM sdk_messages')
    .all() as { row_id: number; sdk_message: string; task_id: string | null }[];
  const update = db.prepare(
    `UPDATE sdk_messages SET ${names.map((key) => `${key} = ?`).join(',')} WHERE rowid = ?`
  );
  for (const row of rows) {
    let message: unknown;
    try {
      message = JSON.parse(row.sdk_message);
    } catch {
      continue;
    }
    const derived = deriveSdkMessageColumns(message, row.task_id);
    update.run(...names.map((key) => derived[key]), row.row_id);
  }
}
