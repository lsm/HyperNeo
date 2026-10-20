import type { Database } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';
import { sdkSideOnlyWrites } from '../sdk-message-body-admission.ts';

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
      SELECT m.rowid,${bodySql.replaceAll('previous.sdk_message', 'COALESCE(previous.sdk_message,m.sdk_message)')} FROM sdk_messages m
      LEFT JOIN sdk_message_bodies previous ON previous.seq=m.rowid WHERE ${predicate}
      ON CONFLICT(seq) DO UPDATE SET sdk_message=excluded.sdk_message`).run(
      ...bodyParams,
      ...params
    );
    if (!sdkSideOnlyWrites(db))
      db.prepare(`UPDATE sdk_messages AS m SET sdk_message=(SELECT b.sdk_message FROM sdk_message_bodies b WHERE b.seq=m.rowid)
        WHERE ${predicate}`).run(...params);
    return result;
  })();
}
