import type { Database } from '../sqlite-compat.ts';

export interface NeoWorkCheckRow {
  workId: string;
  signature: string;
  toldAt: number | null;
  reminded: string | null;
}

export class NeoWorkCheckRepository {
  constructor(private readonly db: Database) {}

  private hasTable(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_checks' AND type = 'table'")
      .get();
  }

  get(workId: string): NeoWorkCheckRow | null {
    if (!this.hasTable()) return null;
    return (
      (this.db
        .prepare(
          'SELECT work_id AS workId, signature, told_at AS toldAt, reminded FROM neo_work_checks WHERE work_id = ?'
        )
        .get(workId) as NeoWorkCheckRow | undefined) ?? null
    );
  }

  markTold(workId: string, signature: string, at: number, reminded = false): void {
    if (!this.hasTable()) return;
    this.db
      .prepare(
        `INSERT INTO neo_work_checks(work_id, signature, told_at, reminded)
           VALUES (?, ?, ?, CASE WHEN ? THEN ? END)
         ON CONFLICT(work_id) DO UPDATE SET
           signature = excluded.signature, told_at = excluded.told_at,
           reminded = COALESCE(excluded.reminded, reminded)`
      )
      .run(workId, signature, at, reminded ? 1 : 0, signature);
  }
}
