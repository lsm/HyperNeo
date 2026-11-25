import superpipe, { type PipelineAPI } from 'superpipe';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import type { SessionSchedule } from '../../storage/repositories/session-schedule-repository.ts';
import type { WorkRef, WorkStatus } from '../drivers/types.ts';
import type { SessionScheduler } from './session-schedules.ts';

export interface ScheduleFireDeps {
  scheduler: SessionScheduler;
  status(target: WorkRef): Promise<WorkStatus | 'not_found' | 'not_open'>;
  deliver(
    schedule: SessionSchedule,
    messageId: string,
    text: string
  ): Promise<void | 'target_gone' | 'unconfirmed'>;
}

type Outcome = { outcome: string };
type Delivery = {
  schedule: SessionSchedule;
  outcome: 'fired' | 'skipped_budget';
  digest: string | null;
  text: string;
  commit?: () => void;
};
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
        const alwaysFire = scheduler.source(schedule.sourceKind)?.alwaysFire;
        if (status === 'stopped' || (!alwaysFire && (status === 'running' || status === 'queued')))
          return finish(schedule, 'skipped_busy');
        if (status === 'needs_you' && !alwaysFire) return finish(schedule, 'skipped_needs_you');
        return { value: schedule };
      },
      'run',
      'result:run'
    )
    .pipe(
      async (schedule: SessionSchedule): Promise<Gate<Delivery>> => {
        const source = scheduler.source(schedule.sourceKind);
        if (!source) throw new Error(`Unregistered schedule source: ${schedule.sourceKind}`);
        const limit = source.dailyRunLimit?.(schedule.sourceId) ?? null;
        const day =
          limit === null
            ? null
            : scheduler.repo.budgetRuns(
                schedule.sourceKind,
                schedule.sourceId,
                Date.now() - 86_400_000
              );
        if (limit !== null && day && day.fired >= limit) {
          if (day.noticed) return finish(schedule, 'skipped_budget');
          return {
            value: {
              schedule,
              outcome: 'skipped_budget',
              digest: schedule.factsDigest,
              text: `${source.label?.(schedule.sourceId) ?? 'This schedule'} reached its daily run limit of ${limit}; due times are skipped until runs from the last 24 hours age out.`,
            },
          };
        }
        const facts = await scheduler.facts(schedule);
        if (!facts) return finish(schedule, 'source_gone');
        const nudge = facts.digest === schedule.factsDigest;
        if (nudge && limit === null && !source.alwaysFire) {
          const quiet = { ...schedule, dueCount: schedule.dueCount + 1 };
          return finish(quiet, 'skipped_unchanged');
        }
        const text = await source.message(schedule.sourceId, { summary: facts.summary, nudge });
        if (text === null) return finish(schedule, 'source_gone');
        return {
          value: {
            schedule,
            outcome: 'fired',
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
      async ({ schedule, outcome, digest, text, commit }: Delivery): Promise<Outcome> => {
        const current = scheduler.repo.get(schedule.id);
        if (current?.status !== 'active' || current.pendingJobId !== schedule.pendingJobId)
          return { outcome: 'superseded' };
        const occurrence =
          schedule.cadence.kind === 'once' ? schedule.cadence.at : schedule.nextRunAt;
        const messageId = `schedule:${schedule.id}:${occurrence}`;
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
          outcome: scheduler.finishRun(schedule, outcome, digest, messageId, Date.now(), commit)
            ? outcome
            : 'superseded',
        };
      },
      'run',
      'run'
    )
    .endAsync('run') as (job: Job) => Promise<Outcome>;
}
