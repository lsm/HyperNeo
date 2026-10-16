import superpipe, { type PipelineAPI } from 'superpipe';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { isNeoContentlessCleanup } from './project-cleanup.ts';
import type { NeoReorganized } from './reorganize-operation.ts';

export const NEO_TOPICS_REORGANIZE_NIGHTLY = 'neo.projects.reorganize.nightly';
export const NEO_REORGANIZE_IDLE_MS = 3 * 60 * 60 * 1000;
export const NEO_REORGANIZE_EVERY_MS = 20 * 60 * 60 * 1000;

export interface NeoNightlyReorganizeDeps {
  now(): number;
  lastHumanAt(): number | null;
  reorganize(): Promise<NeoReorganized>;
  digest(run: NeoReorganized, since: number): Promise<void>;
  log(line: string): void;
}

type NightlyPlan = { lastRunAt: number | null; nextAt: number; run: boolean };
type NightlyResult = { ran: false; nextAt: number } | { ran: true; moved: number; stayed: number };

export function planNeoNightlyReorganize(
  now: number,
  lastHumanAt: number | null,
  lastRunAt: number | null
): NightlyPlan {
  const dueAt = lastRunAt === null ? now : lastRunAt + NEO_REORGANIZE_EVERY_MS;
  const idleAt = lastHumanAt === null ? now : lastHumanAt + NEO_REORGANIZE_IDLE_MS;
  const readyAt = Math.max(dueAt, idleAt);
  return readyAt <= now
    ? { lastRunAt: now, nextAt: now + NEO_REORGANIZE_EVERY_MS, run: true }
    : { lastRunAt, nextAt: readyAt, run: false };
}

export function scheduleNeoNightlyReorganize(
  queue: JobQueueRepository,
  runAt: number,
  lastRunAt: number | null
): void {
  queue.enqueueUniquePending({
    queue: NEO_TOPICS_REORGANIZE_NIGHTLY,
    payload: { scope: 'neo', lastRunAt },
    matchPayload: { scope: 'neo' },
    activeStatuses: ['pending'],
    runAt,
  });
}

export function requireNeoNightlyDue(
  plan: NightlyPlan
): { value: NightlyPlan } | { reason: NightlyResult } {
  return plan.run ? { value: plan } : { reason: { ran: false, nextAt: plan.nextAt } };
}

function readLastRunAt(job: Job): number | null {
  const value = job.payload.lastRunAt;
  return typeof value === 'number' ? value : null;
}

export const runNeoNightlyReorganize = (
  superpipe({})('neo-topics-reorganize-nightly') as PipelineAPI
)
  .input(['job', 'queue', 'deps'])
  .pipe(
    (job: Job, deps: NeoNightlyReorganizeDeps) =>
      planNeoNightlyReorganize(deps.now(), deps.lastHumanAt(), readLastRunAt(job)),
    ['job', 'deps'],
    'plan'
  )
  .pipe(
    (queue: JobQueueRepository, plan: NightlyPlan) =>
      scheduleNeoNightlyReorganize(queue, plan.nextAt, plan.lastRunAt),
    ['queue', 'plan']
  )
  .pipe(requireNeoNightlyDue, 'plan', 'result:result')
  .pipe(
    async (job: Job, deps: NeoNightlyReorganizeDeps): Promise<NightlyResult> => {
      const run = await deps.reorganize();
      const { merged, moved, stayed, cleanupPlanned, cleanupFailed } = run;
      const cleaned = cleanupPlanned.filter(isNeoContentlessCleanup).length - cleanupFailed.length;
      deps.log(
        `neo reorganize: nightly run merged ${merged.length} project(s), moved ${moved.length} ask(s), left ${stayed.length} with main, cleaned up ${cleaned} empty project(s) or holder(s), left ${cleanupPlanned.length - cleaned - cleanupFailed.length} cleanup step(s) for the human`
      );
      await deps.digest(run, readLastRunAt(job) ?? deps.now() - NEO_REORGANIZE_EVERY_MS);
      return { ran: true, moved: moved.length, stayed: stayed.length };
    },
    ['job', 'deps'],
    'result'
  )
  .endAsync('result') as (
  job: Job,
  queue: JobQueueRepository,
  deps: NeoNightlyReorganizeDeps
) => Promise<NightlyResult>;
