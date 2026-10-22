import { generateUUID } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { WorkRef } from '../../lib/drivers/types.ts';

import type {
  SessionSchedule,
  SessionScheduleStatus,
} from '@hyperneo/shared/types/session-schedule';

export type {
  SessionSchedule,
  SessionScheduleCadence,
  SessionScheduleStatus,
} from '@hyperneo/shared/types/session-schedule';

export type NewSessionSchedule = Pick<
  SessionSchedule,
  'target' | 'sourceKind' | 'sourceId' | 'note' | 'cadence' | 'nudgeEvery' | 'createdBySession'
>;

type Row = Record<string, unknown>;

function toSchedule(row: Row): SessionSchedule {
  const text = (key: string) => (row[key] as string | null) ?? null;
  const num = (key: string) => (row[key] as number | null) ?? null;
  return {
    id: row.id as string,
    target: JSON.parse(row.target as string) as WorkRef,
    sourceKind: row.source_kind as string,
    sourceId: row.source_id as string,
    note: text('note'),
    cadence:
      row.cadence_kind === 'cron'
        ? { kind: 'cron', cron: row.cron as string, timezone: row.timezone as string }
        : { kind: 'every', everyMs: row.every_ms as number },
    nudgeEvery: row.nudge_every as number,
    status: row.status as SessionScheduleStatus,
    nextRunAt: num('next_run_at'),
    pendingJobId: text('pending_job_id'),
    dueCount: row.due_count as number,
    factsDigest: text('facts_digest'),
    lastRunAt: num('last_run_at'),
    lastOutcome: text('last_outcome'),
    lastSkipReason: text('last_skip_reason'),
    lastMessageId: text('last_message_id'),
    createdBySession: text('created_by_session'),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export class SessionScheduleRepository {
  constructor(private readonly db: BunDatabase) {}

  recordWake(
    sessionId: string,
    messageId: string,
    metadata: { scheduleId: string; sourceKind: string; sourceId: string },
    firedAt: number
  ): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO session_schedule_wakes
      (session_id, message_id, metadata_json, fired_at) VALUES (?, ?, ?, ?)`)
      .run(sessionId, messageId, JSON.stringify(metadata), firedAt);
  }

  create(input: NewSessionSchedule, nextRunAt: number, now = Date.now()): SessionSchedule {
    const id = generateUUID();
    const { cadence } = input;
    this.db
      .prepare(
        `INSERT INTO session_schedules (id, target, source_kind, source_id, note, cadence_kind,
           every_ms, cron, timezone, nudge_every, next_run_at, created_by_session, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        JSON.stringify(input.target),
        input.sourceKind,
        input.sourceId,
        input.note,
        cadence.kind,
        cadence.kind === 'every' ? cadence.everyMs : null,
        cadence.kind === 'cron' ? cadence.cron : null,
        cadence.kind === 'cron' ? cadence.timezone : 'UTC',
        input.nudgeEvery,
        nextRunAt,
        input.createdBySession,
        now,
        now
      );
    return this.get(id) as SessionSchedule;
  }

  get(id: string): SessionSchedule | null {
    const row = this.db
      .prepare('SELECT * FROM session_schedules WHERE id = ?')
      .get(id) as Row | null;
    return row ? toSchedule(row) : null;
  }

  getBySource(kind: string, sourceId: string): SessionSchedule | null {
    const row = this.db
      .prepare('SELECT * FROM session_schedules WHERE source_kind = ? AND source_id = ?')
      .get(kind, sourceId) as Row | null;
    return row ? toSchedule(row) : null;
  }

  list(target?: WorkRef): SessionSchedule[] {
    const rows = (
      target
        ? this.db
            .prepare(
              `SELECT * FROM session_schedules
               WHERE json_extract(target, '$.adapter') = ? AND json_extract(target, '$.id') = ?
               ORDER BY created_at`
            )
            .all(target.adapter, target.id)
        : this.db.prepare('SELECT * FROM session_schedules ORDER BY created_at').all()
    ) as Row[];
    return rows.map(toSchedule);
  }

  listActiveWithoutJob(): SessionSchedule[] {
    return (
      this.db
        .prepare(
          `SELECT s.* FROM session_schedules s
           LEFT JOIN job_queue j ON j.id = s.pending_job_id AND j.status IN ('pending', 'processing')
           WHERE s.status = 'active' AND j.id IS NULL`
        )
        .all() as Row[]
    ).map(toSchedule);
  }

  reserveExternalDelivery(schedule: SessionSchedule, messageId: string): boolean {
    return (
      this.db
        .prepare(`UPDATE session_schedules SET last_message_id = ?,
      last_outcome = 'sending', updated_at = ? WHERE id = ? AND status = 'active'
      AND pending_job_id IS ? AND last_message_id IS NOT ?`)
        .run(messageId, Date.now(), schedule.id, schedule.pendingJobId, messageId).changes > 0
    );
  }

  countDue(id: string, jobId: string, dueAt: number, now: number): SessionSchedule | null {
    this.db
      .prepare(`UPDATE session_schedules SET due_count = due_count + 1,
      last_run_at = ?, updated_at = ? WHERE id = ? AND status = 'active'
      AND pending_job_id = ? AND (last_run_at IS NULL OR last_run_at < ?)`)
      .run(now, now, id, jobId, dueAt);
    const row = this.get(id);
    return row?.status === 'active' && row.pendingJobId === jobId ? row : null;
  }

  recordOutcome(
    schedule: SessionSchedule,
    outcome: string,
    digest: string | null,
    messageId: string | null
  ): boolean {
    return (
      this.db
        .prepare(`UPDATE session_schedules SET last_outcome = ?,
      last_skip_reason = ?, facts_digest = ?, last_message_id = ?,
      due_count = ?, updated_at = ? WHERE id = ? AND status = 'active' AND pending_job_id = ?`)
        .run(
          outcome,
          outcome.startsWith('skipped_') ? outcome.slice(8) : null,
          digest,
          messageId,
          outcome === 'fired' ? 0 : schedule.dueCount,
          Date.now(),
          schedule.id,
          schedule.pendingJobId
        ).changes > 0
    );
  }

  setPending(id: string, expectedJobId: string | null, jobId: string, nextRunAt: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE session_schedules SET pending_job_id = ?, next_run_at = ?, updated_at = ?
           WHERE id = ? AND pending_job_id IS ?`
        )
        .run(jobId, nextRunAt, Date.now(), id, expectedJobId).changes > 0
    );
  }

  setStatus(
    id: string,
    from: SessionScheduleStatus,
    to: SessionScheduleStatus,
    expectedJobId: string | null,
    pending: { jobId: string; nextRunAt: number } | null
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE session_schedules SET status = ?, pending_job_id = ?, next_run_at = ?, updated_at = ?
           WHERE id = ? AND status = ? AND pending_job_id IS ?`
        )
        .run(
          to,
          pending?.jobId ?? null,
          pending?.nextRunAt ?? null,
          Date.now(),
          id,
          from,
          expectedJobId
        ).changes > 0
    );
  }

  delete(id: string, expectedJobId: string | null): boolean {
    return (
      this.db
        .prepare('DELETE FROM session_schedules WHERE id = ? AND pending_job_id IS ?')
        .run(id, expectedJobId).changes > 0
    );
  }
}
