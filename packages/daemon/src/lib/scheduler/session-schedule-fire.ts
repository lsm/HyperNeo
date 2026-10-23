import superpipe, { type PipelineAPI } from 'superpipe';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import type { SessionSchedule } from '../../storage/repositories/session-schedule-repository.ts';
import type { WorkRef, WorkStatus } from '../drivers/types.ts';
import type { SessionScheduler } from './session-schedules.ts';

export interface ScheduleFireDeps {
  scheduler: SessionScheduler;
  notifyIdle?(schedule: SessionSchedule): void;
  status(target: WorkRef): Promise<WorkStatus | 'not_found' | 'not_open'>;
  deliver(
    schedule: SessionSchedule,
    messageId: string,
    text: string
  ): Promise<void | 'target_gone' | 'unconfirmed'>;
}

type Outcome = { outcome: string };
type Gate<T> = { value: T } | { reason: Outcome };

export function createSessionScheduleFire(deps: ScheduleFireDeps) {
  const { scheduler } = deps;
  const finish = (
    schedule: SessionSchedule,
    outcome: string,
    commit?: () => void
  ): { reason: Outcome } => {
    scheduler.finishRun(schedule, outcome, undefined, undefined, Date.now(), commit);
    return { reason: { outcome } };
  };
  return (superpipe({})('sessionSchedule.fire') as PipelineAPI)
    .input(['job'])
    .pipe(
      (job: Job): Gate<SessionSchedule> => {
        const { scheduleId } = job.payload as { scheduleId: string };
        const row = scheduler.repo.get(scheduleId);
        if (!row || row.status !== 'active' || row.pendingJobId !== job.id)
          return { reason: { outcome: 'superseded' } };
        const counted = scheduler.repo.countDue(
          row.id,
          job.id,
          row.nextRunAt ?? job.runAt,
          Date.now()
        );
        return counted ? { value: counted } : { reason: { outcome: 'superseded' } };
      },
      'job',
      'result:run'
    )
    .pipe(
      async (schedule: SessionSchedule): Promise<Gate<SessionSchedule>> => {
        const status = await deps.status(schedule.target);
        if (status === 'not_found' || status === 'not_open') return finish(schedule, 'target_gone');
        if (status === 'running' || status === 'queued' || status === 'stopped')
          return finish(schedule, 'skipped_busy');
        if (status === 'needs_you') return finish(schedule, 'skipped_needs_you');
        return { value: schedule };
      },
      'run',
      'result:run'
    )
    .pipe(
      async (
        schedule: SessionSchedule
      ): Promise<
        Gate<{ schedule: SessionSchedule; digest: string; text: string; commit?: () => void }>
      > => {
        const source = scheduler.source(schedule.sourceKind);
        if (!source) throw new Error(`Unregistered schedule source: ${schedule.sourceKind}`);
        const facts = await scheduler.facts(schedule);
        if (!facts) return finish(schedule, 'source_gone');
        const nudge = facts.digest === schedule.factsDigest;
        if (nudge) {
          const quiet = { ...schedule, dueCount: schedule.dueCount + 1 };
          return finish(
            quiet,
            'skipped_unchanged',
            quiet.dueCount === 3 ? () => deps.notifyIdle?.(quiet) : undefined
          );
        }
        const text = source.message(schedule.sourceId, { summary: facts.summary, nudge });
        if (text === null) return finish(schedule, 'source_gone');
        return {
          value: {
            schedule,
            digest: facts.digest,
            commit: facts.commit,
            text,
          },
        };
      },
      'run',
      'result:run'
    )
    .pipe(
      async ({
        schedule,
        digest,
        text,
        commit,
      }: {
        schedule: SessionSchedule;
        digest: string;
        text: string;
        commit?: () => void;
      }): Promise<Outcome> => {
        const current = scheduler.repo.get(schedule.id);
        if (current?.status !== 'active' || current.pendingJobId !== schedule.pendingJobId)
          return { outcome: 'superseded' };
        const messageId = `schedule:${schedule.id}:${schedule.nextRunAt}`;
        const delivery = await deps.deliver(schedule, messageId, text);
        if (delivery === 'target_gone') return finish(schedule, 'target_gone').reason;
        if (delivery === 'unconfirmed')
          return {
            outcome: scheduler.finishRun(
              schedule,
              'skipped_delivery_unconfirmed',
              schedule.factsDigest,
              messageId
            )
              ? 'skipped_delivery_unconfirmed'
              : 'superseded',
          };
        return {
          outcome: scheduler.finishRun(schedule, 'fired', digest, messageId, Date.now(), commit)
            ? 'fired'
            : 'superseded',
        };
      },
      'run',
      'run'
    )
    .endAsync('run') as (job: Job) => Promise<Outcome>;
}
