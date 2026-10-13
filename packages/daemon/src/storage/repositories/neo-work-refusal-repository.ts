import type { WorkRef } from '../../lib/drivers/types.ts';
import type { Database } from '../sqlite-compat.ts';

export interface NeoWorkRefusal {
  workId: string;
  ref: WorkRef;
  what: string;
  at: number;
}

export class NeoWorkRefusalRepository {
  constructor(private readonly db: Database) {}

  list(): NeoWorkRefusal[] {
    return (
      this.db
        .prepare('SELECT work_id AS workId, ref, what, at FROM neo_work_refusals')
        .all() as (Omit<NeoWorkRefusal, 'ref'> & { ref: string })[]
    ).map((row) => ({ ...row, ref: JSON.parse(row.ref) as WorkRef }));
  }

  record(row: NeoWorkRefusal): void {
    this.db
      .prepare(`INSERT INTO neo_work_refusals (work_id, ref, what, at) VALUES (?, ?, ?, ?)
      ON CONFLICT(work_id) DO UPDATE SET ref = excluded.ref, what = excluded.what, at = excluded.at`)
      .run(row.workId, JSON.stringify(row.ref), row.what, row.at);
  }

  clear(row: NeoWorkRefusal): boolean {
    return (
      this.db
        .prepare('DELETE FROM neo_work_refusals WHERE work_id = ? AND at = ? AND what = ?')
        .run(row.workId, row.at, row.what).changes > 0
    );
  }
}
