import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../logger.ts';

export type InactiveDeviceReader = (ids: readonly string[]) => Promise<readonly string[]>;
const log = new Logger('connected-device-observer');

export function createConnectedDeviceObserver(
  devices: () => string[],
  read: InactiveDeviceReader,
  notify: (id: string) => void
): (connected: boolean) => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let pending = false;
  let degraded = false;
  const poll = (superpipe({})('connected-device-revocations') as PipelineAPI)
    .input(['ids'])
    .pipe(read, 'ids', 'inactive')
    .pipe((inactive: readonly string[]) => {
      if (timer) for (const id of inactive) if (devices().includes(id)) notify(id);
    }, 'inactive')
    .endAsync('inactive');
  const scan = () => {
    if (!timer || pending) return;
    const ids = [...new Set(devices())];
    if (!ids.length) return;
    pending = true;
    void poll(ids)
      .then(() => {
        degraded = false;
      })
      .catch((error: unknown) => {
        if (timer && !degraded) log.warn('Device revocation observation unavailable:', error);
        degraded = true;
      })
      .finally(() => {
        pending = false;
      });
  };
  return (connected) => {
    if (connected === Boolean(timer)) return;
    if (timer) clearInterval(timer);
    timer = connected ? setInterval(scan, 1000) : null;
  };
}
