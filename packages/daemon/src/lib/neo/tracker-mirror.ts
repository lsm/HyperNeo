import { Logger } from '../logger.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import {
  neoTrackerReads,
  neoTrackerWrites,
} from '../../storage/repositories/neo-tracker-mirror.ts';
import type { NeoTrackerAdapter } from './pack-contract.ts';
import {
  NEO_TRACKER_FAILURE_LIMIT,
  planNeoTrackerMirror,
  planNeoTrackerRecovery,
  type NeoTrackerPlan,
} from './tracker-mirror-plan.ts';

const log = new Logger('tracker-mirror');
const activeSweeps = new WeakMap<Database, Promise<void>>();

export async function sweepNeoTrackerMirrors(
  db: Database,
  adapters: readonly NeoTrackerAdapter[]
): Promise<void> {
  if (!adapters.length) return;
  const active = activeSweeps.get(db);
  if (active) return active;
  const gateway = gatewayFor(db);
  const sweep = (superpipe({})('neo.tracker.mirror') as PipelineAPI)
    .input(['adapters'])
    .pipe(() => gateway.call(neoTrackerReads, 'facts'), undefined, 'facts')
    .pipe(
      (
        facts: ReturnType<
          import('../../storage/repositories/neo-tracker-mirror.ts').NeoTrackerMirrorRepository['facts']
        >,
        adapters: readonly NeoTrackerAdapter[]
      ) => planNeoTrackerMirror(facts.asks, facts.todos, facts.mirrors, adapters),
      ['facts', 'adapters'],
      'plans'
    )
    .pipe(
      async (plans: NeoTrackerPlan[]) => {
        for (const { row, adapter, item, action, parent, outcome } of plans) {
          const write = (change: Partial<typeof row>) =>
            gateway.call(neoTrackerWrites, 'put', { ...row, updatedAt: Date.now(), ...change });
          await write({});
          let ref = row.ref;
          try {
            if (action === 'create') {
              const result =
                planNeoTrackerRecovery(row, await adapter.find(item.marker, row.home)) ??
                (await adapter.create(item));
              if ('reason' in result) throw new Error(result.reason);
              ref = result.ref;
            } else {
              const result =
                action === 'link'
                  ? await adapter.link(parent!, ref!)
                  : await adapter.close(ref!, outcome!);
              if (result !== true) throw new Error(result.reason);
            }
          } catch (error) {
            const failures = row.failures + 1;
            await write({ failures });
            if (failures === NEO_TRACKER_FAILURE_LIMIT)
              log.warn(
                'Tracker retry limit reached',
                { ownerKind: row.ownerKind, ownerId: row.ownerId, tracker: row.tracker, action },
                error
              );
            continue;
          }
          await write({
            ref,
            parentRef: action === 'link' ? parent! : row.parentRef,
            state: action === 'close' ? 'closed' : 'bound',
            failures: 0,
          });
        }
      },
      'plans',
      'done'
    )
    .endAsync('done') as (adapters: readonly NeoTrackerAdapter[]) => Promise<void>;
  const pending = sweep(adapters).finally(() => activeSweeps.delete(db));
  activeSweeps.set(db, pending);
  return pending;
}
