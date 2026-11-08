export const PAIR_HOLD_MS = 8_000;

export interface PairWaits {
  hold(codeId: string, ms: number, signal?: AbortSignal): Promise<boolean>;
  release(codeId: string): void;
}

export function createPairWaits(): PairWaits {
  const held = new Map<string, () => void>();
  return {
    hold: (codeId, ms, signal) => {
      if (held.has(codeId) || signal?.aborted) return Promise.resolve(false);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          held.delete(codeId);
          resolve(true);
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done);
        held.set(codeId, done);
      });
    },
    release: (codeId) => held.get(codeId)?.(),
  };
}

export const daemonPairWaits = createPairWaits();
