import { WorkStatusSchema } from '../../lib/drivers/types.ts';
import type { NeoSessionSeen } from '../../lib/neo/session-watch.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

export const replaceNeoSessionSeen = defineDbOp({
  name: 'neo.sessionSeen.replace',
  mode: 'write',
  run: (db: Database, entries: readonly (readonly [string, NeoSessionSeen])[]): void => {
    db.prepare('DELETE FROM neo_session_seen').run();
    const insert = db.prepare(
      'INSERT INTO neo_session_seen(session_key, listed, status, question) VALUES (?, ?, ?, ?)'
    );
    for (const [key, seen] of entries)
      insert.run(key, seen.listed, seen.status, seen.question ?? null);
  },
});

export class NeoSessionSeenRepository {
  constructor(private readonly db: Database) {}

  list(): [string, NeoSessionSeen][] {
    const rows = this.db
      .prepare('SELECT session_key AS key, listed, status, question FROM neo_session_seen')
      .all() as { key: string; listed: string; status: string; question: string | null }[];
    return rows.flatMap((row) => {
      const status = WorkStatusSchema.safeParse(row.status);
      return status.success
        ? [
            [
              row.key,
              {
                listed: row.listed,
                status: status.data,
                ...(row.question ? { question: row.question } : {}),
              },
            ],
          ]
        : [];
    });
  }

  replace(entries: readonly (readonly [string, NeoSessionSeen])[]): Promise<void> {
    return gatewayFor(this.db).run(replaceNeoSessionSeen, entries);
  }
}
