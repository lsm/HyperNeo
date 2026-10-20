import type { Database } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';

export function writeSdkMessageBody<T>(
  db: Database,
  write: () => T,
  predicate: string,
  params: SQLiteValue[]
): T {
  return db.transaction(() => {
    const result = write();
    db.prepare(`INSERT INTO sdk_message_bodies (seq,sdk_message)
      SELECT rowid,sdk_message FROM sdk_messages WHERE ${predicate}
      ON CONFLICT(seq) DO UPDATE SET sdk_message=excluded.sdk_message`).run(...params);
    return result;
  })();
}
