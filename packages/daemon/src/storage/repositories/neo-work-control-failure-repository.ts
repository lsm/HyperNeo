import type { NeoCardControlFailure } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef } from '../../lib/drivers/types.ts';
import type { Database } from '../sqlite-compat.ts';

export interface NeoWorkControlFailure extends NeoCardControlFailure {
  workId: string;
  ref: WorkRef;
}

const refKey = (ref: WorkRef) =>
  JSON.stringify({
    adapter: ref.adapter,
    id: ref.id,
    ...(ref.daemon ? { daemon: ref.daemon } : {}),
  });

export class NeoWorkControlFailureRepository {
  constructor(private readonly db: Database) {}

  list(workIds?: readonly string[]): NeoWorkControlFailure[] {
    if (workIds && !workIds.length) return [];
    const filter = workIds ? ` WHERE work_id IN (${workIds.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .prepare(`SELECT work_id AS workId, ref, operation, reason, detail, at
        FROM neo_work_control_failures${filter}`)
      .all(...(workIds ?? [])) as (Omit<NeoWorkControlFailure, 'ref'> & { ref: string })[];
    return rows.map((row) => ({ ...row, ref: JSON.parse(row.ref) as WorkRef }));
  }

  record(row: NeoWorkControlFailure): void {
    this.db
      .prepare(`INSERT INTO neo_work_control_failures (work_id, ref, operation, reason, detail, at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(work_id, operation) DO UPDATE SET
        ref = excluded.ref, reason = excluded.reason, detail = excluded.detail, at = excluded.at`)
      .run(row.workId, refKey(row.ref), row.operation, row.reason, row.detail, row.at);
  }

  clear(workId: string, ref: WorkRef, operation: NeoCardControlFailure['operation']): boolean {
    return (
      this.db
        .prepare(
          'DELETE FROM neo_work_control_failures WHERE work_id = ? AND ref = ? AND operation = ?'
        )
        .run(workId, refKey(ref), operation).changes > 0
    );
  }
}
