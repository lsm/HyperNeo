import { rmSync } from 'node:fs';

const ATTEMPTS = 20;
const RETRY_DELAY_MS = 500;
const LOCKED = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function removeTempDir(
  path: string,
  {
    remove = () => rmSync(path, { recursive: true, force: true }),
    wait = () => sleep(RETRY_DELAY_MS),
    warn = console.warn,
  }: { remove?: () => void; wait?: () => void; warn?: (message: string) => void } = {}
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return remove();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!LOCKED.has(code)) throw error;
      if (attempt === ATTEMPTS) return warn(`Left locked temp folder ${path}: ${code}`);
      wait();
    }
  }
}
