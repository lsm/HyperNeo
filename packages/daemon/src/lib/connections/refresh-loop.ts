import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { googleConnectionReads } from '../../storage/repositories/google-connections-worker.ts';
import type { ConnectionStatus } from './status.ts';
import {
  getGoogleConnectionService,
  configureGoogleConnections,
  closeGoogleConnections,
  type GoogleConnectionDependencies,
} from './operations.ts';

type Service = Awaited<ReturnType<typeof getGoogleConnectionService>>;
const refresh = (superpipe({})('google-connections-refresh-due') as PipelineAPI)
  .input(['db', 'createService'])
  .pipe((db: Database) => gatewayFor(db).call(googleConnectionReads, 'list'), 'db', 'rows')
  .pipe(
    (rows: ConnectionStatus[]) => {
      const ids = rows.filter((row) => row.health === 'healthy').map((row) => row.id);
      return ids.length ? { value: ids } : { reason: 'idle' };
    },
    'rows',
    'result:result'
  )
  .pipe((createService: () => Promise<Service>) => createService(), 'createService', 'service')
  .pipe(
    async (ids: string[], service: Service) => {
      await Promise.all(ids.map((id) => service.token(id)));
    },
    ['result', 'service'],
    'result'
  )
  .endAsync('result') as (
  db: Database,
  createService: () => Promise<Service>
) => Promise<void | 'idle'>;

export function createGoogleConnectionRefreshLoop(
  db: Database,
  deps: GoogleConnectionDependencies & { schedule?: (tick: () => Promise<void>) => () => void } = {}
) {
  configureGoogleConnections(db, deps);
  let stopped = false;
  let active: Promise<void> | undefined;
  let stopTimer: (() => void) | undefined;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    active ??= refresh(db, () => getGoogleConnectionService(db))
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  return {
    start() {
      if (stopped || stopTimer) return;
      stopTimer = deps.schedule
        ? deps.schedule(tick)
        : (() => {
            const timer = setInterval(() => {
              void tick();
            }, 60000);
            timer.unref?.();
            return () => clearInterval(timer);
          })();
      void tick();
    },
    async stop() {
      stopped = true;
      stopTimer?.();
      stopTimer = undefined;
      closeGoogleConnections(db);
      await active;
    },
  };
}
