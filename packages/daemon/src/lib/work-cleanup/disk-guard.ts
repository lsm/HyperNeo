import superpipe, { type PipelineAPI } from 'superpipe';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { NeoAttentionEvent } from '../neo/attention/decide.ts';

export const WORK_CLEANUP_QUEUE = 'work.cleanup.sweep';
export const requestWorkCleanupSweep = (jobs: Pick<JobQueueRepository, 'enqueueUniquePending'>) =>
  jobs.enqueueUniquePending({
    queue: WORK_CLEANUP_QUEUE,
    payload: { reason: 'disk' },
    matchPayload: { reason: 'disk' },
    activeStatuses: ['pending'],
    runAt: Date.now(),
  });

const GiB = 1024 ** 3;
const LEVELS = { warnGiB: 50, floorGiB: 10 };
const HOLD = `the data volume has under ${LEVELS.floorGiB} GiB free`;
const TEXT = {
  warn: `The data volume has under ${LEVELS.warnGiB} GiB free. New worker starts wait below ${LEVELS.floorGiB} GiB; free space or archive finished work.`,
  floor: `The data volume has under ${LEVELS.floorGiB} GiB free. New worker starts wait until it is above that; running work continues and a work cleanup sweep was started.`,
};

type Level = 'ok' | 'warn' | 'floor';
type Deps = {
  free(): Promise<number>;
  gone(): Promise<{ key: string; goneAt: number }[]>;
  mark(key: string, at: number): Promise<unknown>;
  forget(keys: readonly string[]): Promise<unknown>;
  attend(event: NeoAttentionEvent): Promise<unknown>;
  backstop(): Promise<unknown>;
};

function decideDiskGuard(freeBytes: number, levels = LEVELS): Level {
  if (freeBytes < levels.floorGiB * GiB) return 'floor';
  return freeBytes < levels.warnGiB * GiB ? 'warn' : 'ok';
}

export const guardDisk = (superpipe({})('work.cleanup.disk-guard') as PipelineAPI)
  .input(['deps', 'now'])
  .pipe(async (deps: Deps) => decideDiskGuard(await deps.free()), 'deps', 'level')
  .pipe(
    async (deps: Deps, level: Level, now: number) => {
      const since = new Map((await deps.gone()).map(({ key, goneAt }) => [key, goneAt]));
      const below =
        level === 'floor' ? ['disk:warn', 'disk:floor'] : level === 'warn' ? ['disk:warn'] : [];
      const above = ['disk:warn', 'disk:floor'].filter(
        (key) => !below.includes(key) && since.has(key)
      );
      if (above.length) await deps.forget(above);
      if (below.length && !since.has('disk:warn')) await deps.mark('disk:warn', now);
      return { entered: level === 'floor' && !since.has('disk:floor'), since };
    },
    ['deps', 'level', 'now'],
    'recorded'
  )
  .pipe(
    async (
      deps: Deps,
      level: Level,
      now: number,
      recorded: { entered: boolean; since: Map<string, number> }
    ) => {
      if (level === 'ok') return;
      if (recorded.entered) {
        await deps.backstop();
        await deps.mark('disk:floor', now);
      }
      await deps.attend({
        kind: 'work.disk',
        subject: { type: 'work_disk', id: level },
        since: recorded.since.get(`disk:${level}`) ?? now,
        facts: { level, text: TEXT[level] },
      });
    },
    ['deps', 'level', 'now', 'recorded'],
    'told'
  )
  .pipe((level: Level) => ({ level, hold: level === 'floor' ? HOLD : null }), 'level', 'result')
  .endAsync('result') as (
  deps: Deps,
  now: number
) => Promise<{ level: Level; hold: string | null }>;
