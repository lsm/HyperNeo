import superpipe, { type PipelineAPI } from 'superpipe';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import type { JobQueueProcessor } from '../../storage/job-queue-processor.ts';
import { nativeFeedEnqueueWrites } from '../../storage/repositories/native-feed-enqueue-write.ts';
import {
  type WorkSessionRow,
  workSessionWrites,
} from '../../storage/repositories/work-session-repository.ts';
import { Logger } from '../logger.ts';
import type { WorkAdapter, WorkSessionFact } from './types.ts';

const logger = new Logger('work-session-sync');
const WORK_SESSION_SYNC = 'work.sessions.sync';
const WORK_SESSION_SYNC_INTERVAL_MS = 60_000;

export function workSessionRows(
  adapter: string,
  sessions: readonly WorkSessionFact[]
): WorkSessionRow[] {
  return sessions.map((session) => ({ adapter, ...session }));
}

async function scanAdapters(adapters: readonly WorkAdapter[]): Promise<WorkSessionRow[]> {
  const scans = await Promise.all(
    adapters.flatMap(({ id, sessions }) =>
      sessions
        ? [
            sessions()
              .then((found) => workSessionRows(id, found))
              .catch((error) => {
                logger.warn(`Session scan failed for ${id}`, error);
                return [];
              }),
          ]
        : []
    )
  );
  return scans.flat();
}

export const syncWorkSessions = (superpipe({})('work-session-sync') as PipelineAPI)
  .input(['adapters', 'save'])
  .pipe(scanAdapters, 'adapters', 'rows')
  .pipe(
    (rows: WorkSessionRow[], save: (rows: WorkSessionRow[]) => Promise<number>) => save(rows),
    ['rows', 'save'],
    'changed'
  )
  .endAsync('changed') as (
  adapters: readonly WorkAdapter[],
  save: (rows: WorkSessionRow[]) => Promise<number>
) => Promise<number>;

function scheduleWorkSessionSync(gateway: DbGateway, delayMs: number) {
  return gateway.call(nativeFeedEnqueueWrites, 'enqueueUniquePending', {
    queue: WORK_SESSION_SYNC,
    payload: { scope: 'local' },
    matchPayload: { scope: 'local' },
    activeStatuses: ['pending'],
    runAt: Date.now() + delayMs,
  });
}

export function startWorkSessionSync(
  gateway: DbGateway,
  jobProcessor: Pick<JobQueueProcessor, 'register'>,
  adapters: () => readonly WorkAdapter[]
): void {
  jobProcessor.register(WORK_SESSION_SYNC, async () => {
    try {
      const changed = await syncWorkSessions(adapters(), (rows) =>
        gateway.call(workSessionWrites, 'saveSessions', rows, Date.now())
      );
      return { changed };
    } finally {
      await scheduleWorkSessionSync(gateway, WORK_SESSION_SYNC_INTERVAL_MS);
    }
  });
  void scheduleWorkSessionSync(gateway, 0).catch((error) =>
    logger.warn('Work session sync not scheduled', error)
  );
}
