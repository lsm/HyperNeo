import type { NeoWorkSupersession } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';

const columns = 'work_id AS workId, superseded_by AS supersededBy, superseded_at AS supersededAt';

export class NeoWorkSupersessionRepository {
  constructor(private readonly db: Database) {}

  record(workId: string, supersededBy: string, at: number): void {
    if (workId === supersededBy) return;
    this.db
      .prepare(
        `INSERT INTO neo_work_supersessions(work_id, superseded_by, superseded_at)
           VALUES (?, ?, ?)
           ON CONFLICT(work_id) DO UPDATE SET superseded_by = excluded.superseded_by,
             superseded_at = excluded.superseded_at
           WHERE superseded_by <> excluded.superseded_by`
      )
      .run(workId, supersededBy, at);
  }

  list(workIds: readonly string[]): NeoWorkSupersession[] {
    if (workIds.length === 0) return [];
    return this.db
      .prepare(
        `SELECT ${columns} FROM neo_work_supersessions
          WHERE work_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(workIds)) as NeoWorkSupersession[];
  }
}
