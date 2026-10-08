import type { NeoWorkDriverReceipt } from '@hyperneo/shared/types/neo-snapshot';
import { WorkStatusSchema, type WorkRef, type WorkStatus } from '../../lib/drivers/types.ts';
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

  private hasTable(): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name = 'neo_work_driver_targets' AND type = 'table'"
      )
      .get();
  }

  get(workId: string): NeoDriverTarget | null {
    if (!this.hasTable()) return null;
    const row = this.db
      .prepare('SELECT target FROM neo_work_driver_targets WHERE work_id = ?')
      .get(workId) as { target: string } | null | undefined;
    if (!row) return null;
    const target = NeoDriverTargetSchema.safeParse(JSON.parse(row.target));
    return target.success ? target.data : null;
  }

  readRef(workId: string): WorkRef | null {
    if (!this.hasTable()) return null;
    const row = this.db
      .prepare('SELECT ref FROM neo_work_driver_targets WHERE work_id = ? AND ref IS NOT NULL')
      .get(workId) as { ref: string } | null | undefined;
    return row ? (JSON.parse(row.ref) as WorkRef) : null;
  }

  readStartedAt(workId: string): number | null {
    if (!this.hasTable()) return null;
    const row = this.db
      .prepare('SELECT started_at AS startedAt FROM neo_work_driver_targets WHERE work_id = ?')
      .get(workId) as { startedAt: number | null } | null | undefined;
    return row?.startedAt ?? null;
  }

  readNeedsYouSince(workId: string): number | null {
    if (!this.hasTable()) return null;
    const row = this.db
      .prepare('SELECT needs_you_since AS since FROM neo_work_driver_targets WHERE work_id = ?')
      .get(workId) as { since: number | null } | null | undefined;
    return row?.since ?? null;
  }

  recordStartedAt(workId: string, startedAt: number | null): void {
    this.db
      .prepare('UPDATE neo_work_driver_targets SET started_at = ? WHERE work_id = ?')
      .run(startedAt, workId);
  }

  recordNeedsYouSince(workId: string, since: number | null): void {
    this.db
      .prepare('UPDATE neo_work_driver_targets SET needs_you_since = ? WHERE work_id = ?')
      .run(since, workId);
  }

  recordRef(workId: string, ref: WorkRef, startedAt?: number, link?: string): void {
    this.db
      .prepare(
        'UPDATE neo_work_driver_targets SET ref = ?, started_at = ?, link = ? WHERE work_id = ?'
      )
      .run(JSON.stringify(ref), startedAt ?? null, link ?? null, workId);
  }

  recordLive(workId: string, status: WorkStatus, link: string | undefined): boolean {
    const result = this.db
      .prepare(
        `UPDATE neo_work_driver_targets SET live_status = ?1, link = COALESCE(?2, link)
          WHERE work_id = ?3 AND (live_status IS NOT ?1 OR (?2 IS NOT NULL AND link IS NOT ?2))`
      )
      .run(status, link ?? null, workId);
    return result.changes > 0;
  }

  receipts(workIds: readonly string[]): NeoWorkDriverReceipt[] {
    if (!this.hasTable() || workIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT work_id AS workId, target, ref, live_status AS status, link
           FROM neo_work_driver_targets WHERE work_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(workIds)) as Array<{
      workId: string;
      target: string;
      ref: string | null;
      status: string | null;
      link: string | null;
    }>;
    return rows.flatMap((row) => {
      const target = NeoDriverTargetSchema.safeParse(JSON.parse(row.target));
      if (!target.success) return [];
      const ref = row.ref ? (JSON.parse(row.ref) as WorkRef) : null;
      const adapter =
        ref?.adapter ??
        (target.data.verb === 'start' ? target.data.adapter : target.data.ref.adapter);
      const daemon =
        ref?.daemon ??
        (target.data.verb === 'send'
          ? (target.data.ref.daemon ?? null)
          : (target.data.place.daemon ?? null));
      const status = WorkStatusSchema.safeParse(row.status);
      return [
        {
          workId: row.workId,
          adapter,
          daemon,
          status: status.success ? status.data : null,
          link: row.link,
        },
      ];
    });
  }
}
