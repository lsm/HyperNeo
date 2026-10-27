import superpipe, { type PipelineAPI } from 'superpipe';
import { createHash } from 'node:crypto';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { sessionScheduleCreateWrites } from '../../storage/repositories/session-schedule-create-write.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import {
  type NewSessionSchedule,
  type SessionSchedule,
  type SessionScheduleCadence,
  SessionScheduleRepository,
} from '../../storage/repositories/session-schedule-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { SESSION_SCHEDULE_FIRE } from '../job-queue-constants.ts';
import { isValidCronExpression } from '../schedule/cron-utils.ts';
import { nextScheduleRun, requireNextRun } from './session-schedule-cadence.ts';

export interface ScheduleSource {
  kind: string;
  label?(id: string): string | null;
  facts(id: string): Promise<{ digest: string; summary: string; commit?: () => void } | null>;
  message(id: string, change: { summary: string; nudge: boolean }): string | null;
}

type Gate<T> = { value: T } | { reason: string };

const MIN_EVERY_MS = 60_000;

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
  private readonly messageProgress = new Map<string, string | null>();

  constructor(
    private readonly db: BunDatabase,
    private readonly jobQueue: JobQueueRepository
  ) {
    this.repo = new SessionScheduleRepository(db);
    this.registerSource({
      kind: 'reminder',
      label: (id) => this.repo.getBySource('reminder', id)?.note ?? null,
      facts: async (id) => {
        const row = this.repo.getBySource('reminder', id);
        return row ? { digest: 'reminder', summary: row.note ?? '' } : null;
      },
      message: (_id, change) => change.summary,
    });
  }

  registerSource(source: ScheduleSource): void {
    this.sources.set(source.kind, source);
  }

  source(kind: string): ScheduleSource | null {
    return this.sources.get(kind) ?? null;
  }

  async facts(schedule: SessionSchedule) {
    const source = this.source(schedule.sourceKind);
    if (!source) throw new Error(`Unregistered schedule source: ${schedule.sourceKind}`);
    const facts = await source.facts(schedule.sourceId);
    if (!facts) return null;
    const progress = this.repo.progressKey(schedule);
    return progress
      ? {
          ...facts,
          digest: createHash('sha256')
            .update(JSON.stringify([facts.digest, progress]))
            .digest('hex'),
        }
      : facts;
  }

  private readonly refreshSchedule = (superpipe({})('sessionSchedule.progress') as PipelineAPI)
    .input(['schedule'])
    .pipe(
      (row: SessionSchedule): { value: SessionSchedule } | { reason: false } =>
        row.status === 'active' && row.dueCount > 0 && row.pendingJobId
          ? { value: row }
          : { reason: false },
      'schedule',
      'result:progress'
    )
    .pipe(
      async (row: SessionSchedule) => ({ row, facts: await this.facts(row) }),
      'progress',
      'snapshot'
    )
    .pipe(
      ({
        row,
        facts,
      }: {
        row: SessionSchedule;
        facts: Awaited<ReturnType<SessionScheduler['facts']>>;
      }) => {
        if (!facts || facts.digest === row.factsDigest) return false;
        return this.db.transaction(() => {
          const current = this.repo.get(row.id);
          if (
            current?.status !== 'active' ||
            !current.dueCount ||
            current.pendingJobId !== row.pendingJobId ||
            this.jobQueue.getJob(row.pendingJobId!)?.status !== 'pending'
          )
            return false;
          if (!this.finishRun(current, 'progress')) return false;
          this.jobQueue.deleteJob(row.pendingJobId!);
          return true;
        })();
      },
      'snapshot',
      'progress'
    )
    .endAsync('progress') as (schedule: SessionSchedule) => Promise<boolean>;

  async refreshProgress(sessionId?: string): Promise<void> {
    for (const row of this.repo.list(
      sessionId ? { adapter: 'hyperneo', id: sessionId } : undefined
    )) {
      if (row.status !== 'active' || !row.dueCount) continue;
      const key = this.repo.progressKey(row);
      if (sessionId && this.messageProgress.has(row.id) && this.messageProgress.get(row.id) === key)
        continue;
      this.messageProgress.set(row.id, key);
      await this.refreshSchedule(row);
    }
  }

  private enqueue(scheduleId: string, runAt: number): string {
    return this.jobQueue.enqueue({ queue: SESSION_SCHEDULE_FIRE, payload: { scheduleId }, runAt })
      .id;
  }

  createAsync(input: NewSessionSchedule, now = Date.now()): Promise<SessionSchedule> {
    return gatewayFor(this.db).call(sessionScheduleCreateWrites, 'create', input, now);
  }

  create(input: NewSessionSchedule, now = Date.now()): SessionSchedule {
    const existing = this.repo.getBySource(input.sourceKind, input.sourceId);
    if (existing) return existing;
    const nextRunAt = requireNextRun(input.cadence, now);
    return this.db.transaction(() => {
      const created = this.repo.create(input, nextRunAt, now);
      this.repo.setPending(created.id, null, this.enqueue(created.id, nextRunAt), nextRunAt);
      return this.repo.get(created.id) as SessionSchedule;
    })();
  }

  pause(schedule: SessionSchedule): SessionSchedule | null {
    if (schedule.pendingJobId) this.jobQueue.deleteJob(schedule.pendingJobId);
    return this.repo.setStatus(schedule.id, 'active', 'paused', schedule.pendingJobId, null)
      ? this.repo.get(schedule.id)
      : null;
  }

  resume(schedule: SessionSchedule, now = Date.now()): SessionSchedule | null {
    const nextRunAt = requireNextRun(schedule.cadence, now);
    const jobId = this.enqueue(schedule.id, nextRunAt);
    if (this.repo.setStatus(schedule.id, 'paused', 'active', null, { jobId, nextRunAt }))
      return this.repo.get(schedule.id);
    this.jobQueue.deleteJob(jobId);
    return null;
  }

  delete(schedule: SessionSchedule): boolean {
    if (schedule.pendingJobId) this.jobQueue.deleteJob(schedule.pendingJobId);
    return this.repo.delete(schedule.id, schedule.pendingJobId);
  }

  finishRun(
    schedule: SessionSchedule,
    outcome: string,
    digest = schedule.factsDigest,
    messageId = schedule.lastMessageId,
    now = Date.now(),
    commit?: () => void
  ): boolean {
    return this.db.transaction(() => {
      if (!this.repo.recordOutcome(schedule, outcome, digest, messageId)) return false;
      if (outcome === 'fired' || outcome === 'skipped_unchanged') commit?.();
      const next =
        outcome === 'source_gone' || outcome === 'target_gone'
          ? null
          : nextScheduleRun(schedule.cadence, now);
      const backedOff =
        next !== null && outcome === 'skipped_unchanged'
          ? now +
            Math.max(
              next - now,
              Math.min(
                (next - now) * 2 ** Math.min(Math.max(0, schedule.dueCount - 2), 30),
                28_800_000
              )
            )
          : next;
      if (backedOff === null)
        return this.repo.setStatus(schedule.id, 'active', 'done', schedule.pendingJobId, null);
      const jobId = this.enqueue(schedule.id, backedOff);
      if (this.repo.setPending(schedule.id, schedule.pendingJobId, jobId, backedOff)) return true;
      this.jobQueue.deleteJob(jobId);
      return false;
    })();
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
