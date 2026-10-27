import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/sqlite-compat.ts';
import {
  hyperneoWorkStatus,
  readHyperneoSession,
  type HyperneoSessionRow,
} from '../drivers/hyperneo-adapter.ts';
import type { DaemonInternalEventMap } from '../internal-event-bus.ts';
import type { NeoService } from './service.ts';

const TerminalEpisodeErrorSchema = z.object({
  metadata: z.object({
    queryFailureEpisode: z.object({ id: z.string(), failed: z.literal(true) }),
  }),
});

export const wakeFailedHyperneoSession = (superpipe({})('neo-query-failure-wake') as PipelineAPI)
  .input(['db', 'wake', 'event'])
  .pipe(
    (db: Database, event: DaemonInternalEventMap['session.error']) => {
      const observed = TerminalEpisodeErrorSchema.safeParse(event.details);
      if (!observed.success) return { reason: false };
      const worker = readHyperneoSession(db, event.sessionId);
      return worker?.queryFailureId === observed.data.metadata.queryFailureEpisode.id &&
        hyperneoWorkStatus(worker.status, worker.processing) !== 'stopped'
        ? { value: worker }
        : { reason: false };
    },
    ['db', 'event'],
    'result:worker'
  )
  .pipe(
    (worker: HyperneoSessionRow, wake: NeoService['wakeNeo']) =>
      wake(
        `query-failure:${worker.id}:${worker.queryFailureId}`,
        `HyperNeo session ${worker.title} (${worker.id}) failed after repeated query errors:\n${worker.queryFailureError}`
      ),
    ['worker', 'wake'],
    'woken'
  )
  .endAsync('woken') as (
  db: Database,
  wake: NeoService['wakeNeo'],
  event: DaemonInternalEventMap['session.error']
) => Promise<boolean>;
