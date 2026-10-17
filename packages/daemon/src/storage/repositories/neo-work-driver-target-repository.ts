import {
  NEO_WORK_CLOSED_DONE_PREFIX,
  type NeoWorkDriverReceipt,
} from '@hyperneo/shared/types/neo-snapshot';
import { WorkStatusSchema, type WorkRef } from '../../lib/drivers/types.ts';
import {
  NeoDriverTargetSchema,
  isNeoReceiptAbandoned,
  isNeoReceiptUnconfirmed,
  type NeoDriverTarget,
} from '../../lib/neo/driver-work.ts';
import type { Database } from '../sqlite-compat.ts';
import type { NeoRepository, NeoWorkInput } from './neo-repository.ts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  NEO_WORK_AWAITING_WORKER,
  NEO_WORK_RESERVED_WORKER,
  neoWorkerRefKey,
} from '../../lib/neo/work-reroute.ts';
import { NeoAgentWorkTargetRepository } from './neo-agent-work-target-repository.ts';
import { NeoDriverSessionRows } from './neo-driver-session-rows.ts';

export class NeoWorkDriverTargetRepository extends NeoDriverSessionRows {
  constructor(db: Database) {
    super(db, 'neo_work_driver_targets', 'work_id');
  }

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

  occupiedWorkers(
    repo: NeoRepository,
    exceptId: string,
    waiting: ReadonlySet<string> = new Set()
  ): Set<string> {
    const agents = new NeoAgentWorkTargetRepository(this.db);
    return new Set(
      repo.listWork().flatMap((other) => {
        if (other.id === exceptId || !['proposed', 'queued'].includes(other.status)) return [];
        const held = this.get(other.id);
        const target = waiting.has(other.id) && held?.verb === 'send' ? null : held;
        const ref = this.readRef(other.id) ?? (target && 'ref' in target ? target.ref : null);
        const local = other.sessionId ?? other.targetSessionId;
        const agent = agents.get(other.id);
        return [
          ...(ref ? [neoWorkerRefKey(ref)] : []),
          ...(local ? [neoWorkerRefKey({ adapter: 'hyperneo', id: local })] : []),
          ...(agent ? [neoWorkerRefKey({ adapter: 'space', id: `agent:${agent.agentId}` })] : []),
        ];
      })
    );
  }

  reassign(
    repo: NeoRepository,
    work: NeoWork,
    candidates: WorkRef[],
    waiting: ReadonlySet<string> = new Set()
  ) {
    return this.db.transaction(() => {
      if (
        !['proposed', 'queued'].includes(work.status) ||
        !this.get(work.id) ||
        this.readRef(work.id)
      )
        return null;
      const occupied = this.occupiedWorkers(repo, work.id, waiting);
      const ref = candidates.find((candidate) => !occupied.has(neoWorkerRefKey(candidate)));
      const target: NeoDriverTarget | null = ref ? { verb: 'send', ref } : null;
      const next = repo.transitionWork(work.id, work, {
        status: 'proposed',
        report: target ? NEO_WORK_RESERVED_WORKER : NEO_WORK_AWAITING_WORKER,
      });
      if (!next) return null;
      if (target)
        this.db
          .prepare(
            'UPDATE neo_work_driver_targets SET target = ? WHERE work_id = ? AND ref IS NULL'
          )
          .run(JSON.stringify(target), work.id);
      return { work: next, target };
    })();
  }

  claimAdmission(workId: string, at: number, admitted: () => boolean, staleBefore = 0): boolean {
    return this.db.transaction(() => {
      if (!admitted()) return false;
      if (!this.db.prepare('SELECT 1 FROM neo_work_driver_targets WHERE work_id = ?').get(workId))
        return true;
      return (
        this.db
          .prepare(`UPDATE neo_work_driver_targets SET claimed_at = ?
            WHERE work_id = ? AND (claimed_at IS NULL OR claimed_at < ?)
              AND ref IS NULL AND start_interrupted = 0`)
          .run(at, workId, staleBefore).changes === 1
      );
    })();
  }

  releaseAdmission(workId: string): void {
    this.db
      .prepare(
        'UPDATE neo_work_driver_targets SET claimed_at = NULL WHERE work_id = ? AND ref IS NULL'
      )
      .run(workId);
  }

  adoptedRefs(reportedSince: number): WorkRef[] {
    const rows = this.db
      .prepare(`SELECT t.target FROM neo_work_driver_targets t
        JOIN neo_work w ON w.id = t.work_id
        WHERE json_extract(t.target, '$.verb') = 'adopt'
          AND (w.status IN ('proposed', 'queued')
            OR (w.status = 'reported' AND w.updated_at > ?
              AND (w.report IS NULL OR w.report NOT LIKE ?)))`)
      .all(reportedSince, `${NEO_WORK_CLOSED_DONE_PREFIX}%`) as { target: string }[];
    return rows.flatMap((row) => {
      const target = NeoDriverTargetSchema.safeParse(JSON.parse(row.target));
      return target.success && target.data.verb === 'adopt' ? [target.data.ref] : [];
    });
  }

  cardRefs(reportedSince: number): { workId: string; ref: WorkRef }[] {
    const rows = this.db
      .prepare(`SELECT t.work_id AS workId, t.ref FROM neo_work_driver_targets t
        JOIN neo_work w ON w.id = t.work_id
        WHERE t.ref IS NOT NULL
          AND (w.status IN ('proposed', 'queued') OR (w.status = 'reported' AND w.updated_at > ?))`)
      .all(reportedSince) as { workId: string; ref: string }[];
    return rows.map((row) => ({ workId: row.workId, ref: JSON.parse(row.ref) as WorkRef }));
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

  receipts(workIds: readonly string[], now = Date.now()): NeoWorkDriverReceipt[] {
    if (workIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT work_id AS workId, target, ref, live_status AS status, link,
                actual_model AS model, actual_effort AS effort,
                remote_link AS remoteLink, started_at AS startedAt, input_before AS inputBefore,
                (SELECT status FROM neo_work WHERE id = work_id) AS workStatus,
                (SELECT created_at FROM neo_work WHERE id = work_id) AS workCreatedAt,
                (SELECT updated_at FROM neo_work WHERE id = work_id) AS workUpdatedAt
           FROM neo_work_driver_targets WHERE work_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(workIds)) as Array<{
      workId: string;
      model: string | null;
      effort: string | null;
      target: string;
      ref: string | null;
      status: string | null;
      link: string | null;
      remoteLink: string | null;
      startedAt: number | null;
      inputBefore: number | null;
      workStatus: string | null;
      workCreatedAt: number | null;
      workUpdatedAt: number | null;
    }>;
    return rows.flatMap((row) => {
      const target = NeoDriverTargetSchema.safeParse(JSON.parse(row.target));
      if (!target.success || target.data.verb === 'read') return [];
      const ref = row.ref ? (JSON.parse(row.ref) as WorkRef) : null;
      const adapter =
        ref?.adapter ??
        (target.data.verb === 'start' ? target.data.adapter : target.data.ref.adapter);
      const daemon =
        ref?.daemon ??
        (target.data.verb === 'start'
          ? (target.data.place.daemon ?? null)
          : (target.data.ref.daemon ?? null));
      const status = WorkStatusSchema.safeParse(row.workStatus === 'cancelled' ? null : row.status);
      return [
        {
          workId: row.workId,
          adapter,
          daemon,
          status: status.success ? status.data : null,
          link:
            row.link ??
            (ref?.adapter === 'claude-desktop' && ref.id.startsWith('local_')
              ? `claude://claude.ai/epitaxy/${encodeURIComponent(ref.id)}`
              : null),
          ...(row.model !== null ? { model: row.model } : {}),
          ...(row.effort !== null ? { effort: row.effort } : {}),
          ...(row.remoteLink ? { remoteLink: row.remoteLink } : {}),
          ...(isNeoReceiptUnconfirmed(
            { ...row, ref: !!ref, status: status.success ? status.data : null },
            now
          )
            ? { unconfirmed: true as const }
            : {}),
          ...(isNeoReceiptAbandoned(row.workStatus, row.workUpdatedAt, now)
            ? { abandoned: true as const }
            : {}),
        },
      ];
    });
  }
}
