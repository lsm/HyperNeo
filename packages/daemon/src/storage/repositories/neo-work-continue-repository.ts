import type { NeoWorkContinue } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';

const columns = `work_id AS workId, count, continued_at AS continuedAt,
  last_message AS lastMessage, progress, stalled`;

export class NeoWorkContinueRepository {
  constructor(private readonly db: Database) {}

  get(workId: string): NeoWorkContinue | null {
    return (
      (this.db
        .prepare(`SELECT ${columns} FROM neo_work_continues WHERE work_id = ?`)
        .get(workId) as NeoWorkContinue | null) ?? null
    );
  }

  record(workId: string, message: string, at: number, progress: string): NeoWorkContinue | null {
    this.db
      .prepare(
        `INSERT INTO neo_work_continues(work_id, count, continued_at, last_message, progress, stalled)
           VALUES (?, 1, ?, ?, ?, 0)
           ON CONFLICT(work_id) DO UPDATE SET count = count + 1,
             continued_at = excluded.continued_at, last_message = excluded.last_message,
             stalled = 0,
             progress = excluded.progress`
      )
      .run(workId, at, message, progress);
    return this.get(workId);
  }

  list(workIds: readonly string[]): NeoWorkContinue[] {
    if (workIds.length === 0) return [];
    return this.db
      .prepare(
        `SELECT ${columns} FROM neo_work_continues WHERE work_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(workIds)) as NeoWorkContinue[];
  }
}
