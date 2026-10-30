import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { googleConnectionReads } from '../../storage/repositories/google-connections-worker.ts';
import type { ConnectionStatus } from './status.ts';
import { getGoogleConnectionService, type GoogleConnectionDependencies } from './operations.ts';

type Service = Awaited<ReturnType<typeof getGoogleConnectionService>>;
const refresh = (superpipe({})('google-connections-refresh-due') as PipelineAPI)
  .input(['db', 'service'])
  .pipe((db: Database) => gatewayFor(db).call(googleConnectionReads, 'list'), 'db', 'rows')
  .pipe(
    (rows: ConnectionStatus[]) =>
      rows.filter((row) => row.health === 'healthy').map((row) => row.id),
    'rows',
    'ids'
  )
  .pipe(
    async (ids: string[], service: Service) => {
      await Promise.all(ids.map((id) => service.token(id)));
    },
    ['ids', 'service'],
    'result'
  )
  .endAsync('result') as (db: Database, service: Service) => Promise<void>;

export function createGoogleConnectionRefreshLoop(
  db: Database,
  deps: GoogleConnectionDependencies & { schedule?: (tick: () => Promise<void>) => () => void } = {}
) {
  let stopped = false;
  let active: Promise<void> | undefined;
  let current: Service | undefined;
  let stopTimer: (() => void) | undefined;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    active ??= getGoogleConnectionService(db, deps)
      .then((service) => {
        current = service;
        if (stopped) service.close();
        else return refresh(db, service);
      })
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
      current?.close();
      await active;
    },
  };
}
