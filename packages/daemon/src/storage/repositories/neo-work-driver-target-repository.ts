import type { WorkRef } from '../../lib/drivers/types.ts';
import { NeoDriverTargetSchema, type NeoDriverTarget } from '../../lib/neo/driver-work.ts';
import type { Database } from '../sqlite-compat.ts';
import type { NeoRepository, NeoWorkInput } from './neo-repository.ts';

export class NeoWorkDriverTargetRepository {
  constructor(private readonly db: Database) {}

  propose(repo: NeoRepository, input: NeoWorkInput, target: NeoDriverTarget) {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id FROM neo_work WHERE request_key = ?')
        .get(input.requestKey);
      const work = repo.proposeWork({ ...input, targetSessionId: null });
      if (!existing) {
        this.db
          .prepare('INSERT INTO neo_work_driver_targets(work_id, target) VALUES (?, ?)')
          .run(work.id, JSON.stringify(target));
      }
      return { work, target: this.get(work.id) };
    })();
  }

  get(workId: string): NeoDriverTarget | null {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = 'neo_work_driver_targets' AND type = 'table'"
        )
        .get()
    )
      return null;
    const row = this.db
      .prepare('SELECT target FROM neo_work_driver_targets WHERE work_id = ?')
      .get(workId) as { target: string } | null | undefined;
    if (!row) return null;
    const target = NeoDriverTargetSchema.safeParse(JSON.parse(row.target));
    return target.success ? target.data : null;
  }

  readRef(workId: string): WorkRef | null {
    const row = this.db
      .prepare('SELECT ref FROM neo_work_driver_targets WHERE work_id = ? AND ref IS NOT NULL')
      .get(workId) as { ref: string } | null | undefined;
    return row ? (JSON.parse(row.ref) as WorkRef) : null;
  }

  recordRef(workId: string, ref: WorkRef): void {
    this.db
      .prepare('UPDATE neo_work_driver_targets SET ref = ? WHERE work_id = ?')
      .run(JSON.stringify(ref), workId);
  }
}
