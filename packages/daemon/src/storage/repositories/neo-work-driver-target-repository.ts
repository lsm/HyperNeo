import type { NeoWorkDriverReceipt } from '@hyperneo/shared/types/neo-snapshot';
import { WorkStatusSchema, type WorkRef, type WorkStatus } from '../../lib/drivers/types.ts';
import {
  NeoDriverTargetSchema,
  type DriverSent,
  type NeoDriverTarget,
} from '../../lib/neo/driver-work.ts';
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

  refs(): WorkRef[] {
    if (!this.hasTable()) return [];
    const rows = this.db
      .prepare('SELECT ref FROM neo_work_driver_targets WHERE ref IS NOT NULL')
      .all() as { ref: string }[];
    return rows.map((row) => JSON.parse(row.ref) as WorkRef);
  }

  readRef(workId: string): WorkRef | null {
    if (!this.hasTable()) return null;
    const row = this.db
      .prepare('SELECT ref FROM neo_work_driver_targets WHERE work_id = ? AND ref IS NOT NULL')
      .get(workId) as { ref: string } | null | undefined;
    return row ? (JSON.parse(row.ref) as WorkRef) : null;
  }

  readFollowAnchor(workId: string): number | null {
    const row = this.db
      .prepare('SELECT follow_anchor AS at FROM neo_work_driver_targets WHERE work_id = ?')
      .get(workId) as { at: number | null } | null | undefined;
    return row?.at ?? null;
  }

  recordFollowAnchor(workId: string, at: number): void {
    this.db
      .prepare('UPDATE neo_work_driver_targets SET follow_anchor = ? WHERE work_id = ?')
      .run(at, workId);
  }

  readSupersededAt(workId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(other.started_at) AS at
           FROM neo_work_driver_targets card
           JOIN neo_work_driver_targets other
             ON other.ref = card.ref AND other.work_id != card.work_id
          WHERE card.work_id = ? AND card.started_at IS NOT NULL
            AND other.started_at > card.started_at`
      )
      .get(workId) as { at: number | null } | null | undefined;
    return row?.at ?? null;
  }

  readLiveStatus(workId: string): WorkStatus | null {
    const row = this.db
      .prepare('SELECT live_status AS status FROM neo_work_driver_targets WHERE work_id = ?')
      .get(workId) as { status: WorkStatus | null } | null | undefined;
    return row?.status ?? null;
  }

  readStartedAt(workId: string): number | null {
    if (!this.hasTable()) return null;
    const row = this.db
      .prepare('SELECT started_at AS startedAt FROM neo_work_driver_targets WHERE work_id = ?')
      .get(workId) as { startedAt: number | null } | null | undefined;
    return row?.startedAt ?? null;
  }

  readSent(workId: string): DriverSent | null {
    if (!this.hasTable()) return null;
    const row = this.db
      .prepare(
        `SELECT input_before AS inputBefore, sent_opening AS opening
           FROM neo_work_driver_targets WHERE work_id = ?`
      )
      .get(workId) as { inputBefore: number | null; opening: string | null } | null | undefined;
    return row && row.inputBefore !== null && row.opening
      ? { inputBefore: row.inputBefore, opening: row.opening }
      : null;
  }

  readRetries(workId: string): number {
    if (!this.hasTable()) return 0;
    const row = this.db
      .prepare('SELECT retries FROM neo_work_driver_targets WHERE work_id = ?')
      .get(workId) as { retries: number } | null | undefined;
    return row?.retries ?? 0;
  }

  recordRetry(workId: string): number {
    this.db
      .prepare('UPDATE neo_work_driver_targets SET retries = retries + 1 WHERE work_id = ?')
      .run(workId);
    return this.readRetries(workId);
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

  recordSent(workId: string, sent: DriverSent | null): void {
    this.db
      .prepare(
        'UPDATE neo_work_driver_targets SET input_before = ?, sent_opening = ? WHERE work_id = ?'
      )
      .run(sent?.inputBefore ?? null, sent?.opening ?? null, workId);
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

  recordLive(
    workId: string,
    status: WorkStatus,
    link: string | undefined,
    remoteLink?: string
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE neo_work_driver_targets
            SET live_status = ?1, link = COALESCE(?2, link), remote_link = ?4
          WHERE work_id = ?3 AND (live_status IS NOT ?1 OR (?2 IS NOT NULL AND link IS NOT ?2)
            OR remote_link IS NOT ?4)`
      )
      .run(status, link ?? null, workId, remoteLink ?? null);
    return result.changes > 0;
  }

  receipts(workIds: readonly string[]): NeoWorkDriverReceipt[] {
    if (!this.hasTable() || workIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT work_id AS workId, target, ref, live_status AS status, link,
                remote_link AS remoteLink, started_at AS startedAt,
                (SELECT status FROM neo_work WHERE id = work_id) AS workStatus
           FROM neo_work_driver_targets WHERE work_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(workIds)) as Array<{
      workId: string;
      target: string;
      ref: string | null;
      status: string | null;
      link: string | null;
      remoteLink: string | null;
      startedAt: number | null;
      workStatus: string | null;
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
          ...(row.remoteLink ? { remoteLink: row.remoteLink } : {}),
          ...(ref &&
          row.workStatus === 'queued' &&
          row.startedAt === null &&
          status.success &&
          status.data !== 'queued'
            ? { unconfirmed: true as const }
            : {}),
        },
      ];
    });
  }
}
