import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';

export interface NeoWorkPrRow {
  workId: string;
  prs: NeoWorkPr[];
  revision: number;
  delivered: string | null;
  readAt: number;
}
type StoredRow = Omit<NeoWorkPrRow, 'prs'> & { prsJson: string };

const columns = 'work_id AS workId, prs_json AS prsJson, revision, delivered, read_at AS readAt';

export class NeoWorkPrRepository {
  constructor(private readonly db: Database) {}

  private hasTable(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_prs' AND type = 'table'")
      .get();
  }

  get(workId: string): NeoWorkPrRow | null {
    if (!this.hasTable()) return null;
    const row = this.db
      .prepare(`SELECT ${columns} FROM neo_work_prs WHERE work_id = ?`)
      .get(workId) as StoredRow | undefined;
    if (!row) return null;
    const { prsJson, ...rest } = row;
    return { ...rest, prs: JSON.parse(prsJson) as NeoWorkPr[] };
  }

  record(workId: string, prs: readonly NeoWorkPr[], at: number): NeoWorkPrRow | null {
    if (!this.hasTable()) return null;
    this.db
      .prepare(
        `INSERT INTO neo_work_prs(work_id, prs_json, open, revision, delivered, read_at)
           VALUES (?, ?, ?, 1, NULL, ?)
         ON CONFLICT(work_id) DO UPDATE SET
           revision = revision + (prs_json IS NOT excluded.prs_json),
           prs_json = excluded.prs_json, open = excluded.open, read_at = excluded.read_at`
      )
      .run(workId, JSON.stringify(prs), prs.some((pr) => pr.state === 'OPEN') ? 1 : 0, at);
    return this.get(workId);
  }

  list(workIds: readonly string[]): NeoWorkPrRow[] {
    if (!this.hasTable() || workIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM neo_work_prs WHERE work_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(workIds)) as StoredRow[];
    return rows.map(({ prsJson, ...rest }) => ({
      ...rest,
      prs: JSON.parse(prsJson) as NeoWorkPr[],
    }));
  }

  markDelivered(workId: string, signature: string): void {
    if (!this.hasTable()) return;
    this.db
      .prepare('UPDATE neo_work_prs SET delivered = ? WHERE work_id = ?')
      .run(signature, workId);
  }

  listOpen(): string[] {
    if (!this.hasTable()) return [];
    return (
      this.db.prepare('SELECT work_id AS workId FROM neo_work_prs WHERE open = 1').all() as {
        workId: string;
      }[]
    ).map((row) => row.workId);
  }
}
