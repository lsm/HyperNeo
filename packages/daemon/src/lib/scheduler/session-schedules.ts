import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import {
  SessionScheduleRepository,
  type NewSessionSchedule,
  type SessionSchedule,
  type SessionScheduleCadence,
} from '../../storage/repositories/session-schedule-repository.ts';
import { getNextRunAt, isValidCronExpression } from '../schedule/cron-utils.ts';
import { SESSION_SCHEDULE_FIRE } from '../job-queue-constants.ts';

export interface ScheduleSource {
  kind: string;
  facts(id: string): Promise<{ digest: string; summary: string } | null>;
  message(id: string, change: { summary: string; nudge: boolean }): string;
}

type Gate<T> = { value: T } | { reason: string };

const MIN_EVERY_MS = 60_000;

export function nextScheduleRun(cadence: SessionScheduleCadence, after: number): number | null {
  return cadence.kind === 'every'
    ? after + cadence.everyMs
    : getNextRunAt(cadence.cron, cadence.timezone, after);
}

export function requireValidCadence(cadence: SessionScheduleCadence): Gate<SessionScheduleCadence> {
  if (cadence.kind === 'every')
    return cadence.everyMs >= MIN_EVERY_MS
      ? { value: cadence }
      : { reason: 'invalid_cadence: every must be at least one minute.' };
  return isValidCronExpression(cadence.cron) && nextScheduleRun(cadence, Date.now()) !== null
    ? { value: cadence }
    : { reason: `invalid_cadence: "${cadence.cron}" in ${cadence.timezone} has no next run.` };
}

export class SessionScheduler {
  readonly repo: SessionScheduleRepository;
  private readonly sources = new Map<string, ScheduleSource>();

  constructor(
    private readonly db: BunDatabase,
    private readonly jobQueue: JobQueueRepository
  ) {
    this.repo = new SessionScheduleRepository(db);
  }

  registerSource(source: ScheduleSource): void {
    this.sources.set(source.kind, source);
  }

  source(kind: string): ScheduleSource | null {
    return this.sources.get(kind) ?? null;
  }

  private enqueue(scheduleId: string, runAt: number): string {
    return this.jobQueue.enqueue({ queue: SESSION_SCHEDULE_FIRE, payload: { scheduleId }, runAt })
      .id;
  }

  create(input: NewSessionSchedule, now = Date.now()): SessionSchedule {
    const existing = this.repo.getBySource(input.sourceKind, input.sourceId);
    if (existing) return existing;
    const nextRunAt = nextScheduleRun(input.cadence, now) as number;
    return this.db.transaction(() => {
      const created = this.repo.create(input, nextRunAt, now);
      this.repo.setPending(created.id, null, this.enqueue(created.id, nextRunAt), nextRunAt);
      return this.repo.get(created.id) as SessionSchedule;
    })();
  }

  pause(schedule: SessionSchedule): SessionSchedule {
    if (schedule.pendingJobId) this.jobQueue.deleteJob(schedule.pendingJobId);
    this.repo.setStatus(schedule.id, 'active', 'paused', schedule.pendingJobId, null);
    return this.repo.get(schedule.id) as SessionSchedule;
  }

  resume(schedule: SessionSchedule, now = Date.now()): SessionSchedule {
    const nextRunAt = nextScheduleRun(schedule.cadence, now) as number;
    const jobId = this.enqueue(schedule.id, nextRunAt);
    if (!this.repo.setStatus(schedule.id, 'paused', 'active', null, { jobId, nextRunAt }))
      this.jobQueue.deleteJob(jobId);
    return this.repo.get(schedule.id) as SessionSchedule;
  }

  delete(schedule: SessionSchedule): boolean {
    if (schedule.pendingJobId) this.jobQueue.deleteJob(schedule.pendingJobId);
    return this.repo.delete(schedule.id, schedule.pendingJobId);
  }

  recover(now = Date.now()): number {
    let recovered = 0;
    for (const schedule of this.repo.listActiveWithoutJob()) {
      const runAt = Math.max(schedule.nextRunAt ?? now, now);
      const jobId = this.enqueue(schedule.id, runAt);
      if (this.repo.setPending(schedule.id, schedule.pendingJobId, jobId, runAt)) recovered++;
      else this.jobQueue.deleteJob(jobId);
    }
    return recovered;
  }
}
