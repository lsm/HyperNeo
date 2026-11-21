import { setTimeout as delay } from 'node:timers/promises';

export function createCodexCutover(isIdle: () => Promise<boolean>) {
  const admitted = new Set<Promise<unknown>>();
  let cutover: Promise<void> | undefined;
  return {
    async admit<T>(send: () => Promise<T>) {
      while (cutover) await cutover;
      const work = Promise.resolve().then(send);
      admitted.add(work);
      try {
        return await work;
      } finally {
        admitted.delete(work);
      }
    },
    async atIdle<T>(effect: () => Promise<T>, signal?: AbortSignal) {
      for (;;) {
        while (cutover) await cutover;
        signal?.throwIfAborted();
        let release!: () => void;
        cutover = new Promise((resolve) => {
          release = resolve;
        });
        try {
          await Promise.allSettled(admitted);
          signal?.throwIfAborted();
          const idle = await isIdle();
          signal?.throwIfAborted();
          if (idle) return await effect();
        } finally {
          cutover = undefined;
          release();
        }
        await delay(1000, undefined, { signal });
      }
    },
  };
}
