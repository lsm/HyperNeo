import type { Database } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';

export function writeSdkMessageBody<T>(
  db: Database,
  write: () => T,
  predicate: string,
  params: SQLiteValue[],
  bodySql: string,
  bodyParams: SQLiteValue[]
): T {
  return db.transaction(() => {
    const result = write();
    db.prepare(`INSERT INTO sdk_message_bodies (seq,sdk_message)
      SELECT m.rowid,${bodySql} FROM sdk_messages m
      LEFT JOIN sdk_message_bodies previous ON previous.seq=m.rowid WHERE ${predicate}
      ON CONFLICT(seq) DO UPDATE SET sdk_message=excluded.sdk_message`).run(
      ...bodyParams,
      ...params
    );
    return result;
  })();
}
