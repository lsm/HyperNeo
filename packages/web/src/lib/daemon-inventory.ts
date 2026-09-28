import type { MessageHub } from '@hyperneo/shared';
import type { DaemonSnapshot } from '@hyperneo/shared/types/daemon-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from './operations.ts';

export type DaemonInventoryRead =
  | { state: 'ready'; snapshot: DaemonSnapshot }
  | { state: 'stale' }
  | { state: 'unavailable' };

export function admitDaemonInventoryRead(
  current: boolean
): { value: true } | { reason: Extract<DaemonInventoryRead, { state: 'stale' }> } {
  return current ? { value: true } : { reason: { state: 'stale' } };
}

export function presentDaemonInventoryRead(
  snapshot: DaemonSnapshot | { accepted: false; reason: string }
):
  | { value: Extract<DaemonInventoryRead, { state: 'ready' }> }
  | { reason: Extract<DaemonInventoryRead, { state: 'unavailable' }> } {
  return 'accepted' in snapshot
    ? { reason: { state: 'unavailable' } }
    : { value: { state: 'ready', snapshot } };
}

export const readDaemonInventory = (superpipe({})('web-daemon-inventory') as PipelineAPI)
  .input(['getHub', 'current'])
  .pipe((current: () => boolean) => current(), 'current', 'live')
  .pipe(admitDaemonInventoryRead, 'live', 'result:inventory')
  .pipe((getHub: () => Promise<MessageHub>) => getHub(), 'getHub', 'hub')
  .pipe((current: () => boolean) => current(), 'current', 'live')
  .pipe(admitDaemonInventoryRead, 'live', 'result:inventory')
  .pipe(
    (hub: MessageHub) =>
      invokeOperation<DaemonSnapshot | { accepted: false; reason: string }>(
        hub,
        'daemon.snapshot',
        { limit: 50, includeArchived: false }
      ),
    'hub',
    'snapshot'
  )
  .pipe((current: () => boolean) => current(), 'current', 'live')
  .pipe(admitDaemonInventoryRead, 'live', 'result:inventory')
  .pipe(presentDaemonInventoryRead, 'snapshot', 'result:inventory')
  .endAsync('inventory') as (
  getHub: () => Promise<MessageHub>,
  current: () => boolean
) => Promise<DaemonInventoryRead>;
