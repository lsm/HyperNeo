import { randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import { humanDeviceResetReads } from '../../storage/repositories/human-device-reset-read.ts';
import type { resetHumanDevices } from '../../storage/repositories/human-device-reset-repository.ts';
import { humanDeviceResetWrites } from '../../storage/repositories/human-device-reset-write.ts';
import { Logger } from '../logger.ts';

type Receipt = ReturnType<typeof resetHumanDevices>;
const log = new Logger('human-reset-coordinator');

export function createHumanResetCoordinator(
  gateway: DbGateway,
  notify: (receipt: Receipt) => void
) {
  const pending = new Set<string>();
  const signal = gateway.closeSignal;
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let degraded = false;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    pending.clear();
    signal.removeEventListener('abort', stop);
  };
  const finish = (receipt: Receipt) => {
    if (!signal.aborted) notify(receipt);
    pending.delete(receipt.id);
    return receipt;
  };
  const recover = (superpipe({})('human-reset-notification-recovery') as PipelineAPI)
    .input(['id'])
    .pipe((id: string) => gateway.call(humanDeviceResetReads, 'receipt', id), 'id', 'receipt')
    .pipe((receipt: Receipt | null) => (receipt ? finish(receipt) : null), 'receipt', 'receipt')
    .endAsync('receipt');
  const scan = async () => {
    if (signal.aborted || busy) return;
    busy = true;
    try {
      for (const id of pending) {
        if (signal.aborted) break;
        try {
          await recover(id);
          degraded = false;
        } catch (error) {
          if (!signal.aborted && !degraded)
            log.warn('Reset notification recovery unavailable:', error);
          degraded = true;
        }
      }
    } finally {
      busy = false;
      if (!pending.size) stop();
    }
  };
  const retain = (id: string) => {
    if (signal.aborted) return;
    pending.add(id);
    if (!timer) {
      signal.addEventListener('abort', stop, { once: true });
      timer = setInterval(() => void scan(), 1000);
    }
    void scan();
  };
  return (superpipe({})('human-reset-coordination') as PipelineAPI)
    .input(['now'])
    .pipe(() => randomUUID(), 'now', 'id')
    .pipe(
      async (now: number, id: string) => {
        if (signal.aborted) throw new Error('Human reset coordinator closed');
        try {
          return finish(await gateway.call(humanDeviceResetWrites, 'reset', now, id));
        } catch (error) {
          retain(id);
          throw error;
        }
      },
      ['now', 'id'],
      'receipt'
    )
    .endAsync('receipt') as (now: number) => Promise<Receipt>;
}
