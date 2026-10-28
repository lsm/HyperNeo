import { setTimeout as delay } from 'node:timers/promises';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { DevicePairingRepository } from '../../storage/repositories/device-pairing-repository.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { Logger } from '../logger.ts';

const log = new Logger('pairing-revocation');
type Receipt = Awaited<ReturnType<DevicePairingRepository['revokeAsync']>>;

async function reconcile(repo: DevicePairingRepository, id: string): Promise<boolean> {
  while (!repo.closeSignal.aborted) {
    try {
      const active = await repo.isActiveDeviceAsync(id);
      return !repo.closeSignal.aborted && !active;
    } catch {
      await delay(25, undefined, { signal: repo.closeSignal }).catch(() => {});
    }
  }
  return false;
}

export function createDeviceRevoker(
  repo: () => DevicePairingRepository,
  now: () => number,
  notify: (id: string) => void
) {
  return (superpipe({})('device.revoke') as PipelineAPI)
    .input(['id', 'caller'])
    .pipe(() => repo(), 'id', 'repo')
    .pipe(
      async (state: DevicePairingRepository, id: string, caller: OperationCaller) => {
        try {
          return await state.revokeAsync(id, caller, now());
        } catch (error) {
          if ((await reconcile(state, id)) && !state.closeSignal.aborted) {
            try {
              notify(id);
            } catch (failure) {
              log.warn('Could not announce a reconciled revocation:', failure);
            }
          }
          throw error;
        }
      },
      ['repo', 'id', 'caller'],
      'receipt'
    )
    .pipe(
      (receipt: Receipt, id: string) => {
        if (receipt.ok) notify(id);
        return receipt;
      },
      ['receipt', 'id'],
      'receipt'
    )
    .endAsync('receipt') as (id: string, caller: OperationCaller) => Promise<Receipt>;
}
