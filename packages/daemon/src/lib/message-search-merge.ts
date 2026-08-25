import { Logger } from './logger.ts';

const DEFAULT_MESSAGE_SEARCH_MERGE_TIMEOUT_MS = 30_000;

const log = new Logger('Database');

type MergeWorkerResponse = {
  ok: boolean;
  error?: string;
};

export type MessageSearchMergeStatus =
  | 'merged'
  | 'failed'
  | 'worker-unavailable'
  | 'timeout'
  | 'cancelled';

export interface MessageSearchMergeHandle {
  promise: Promise<MessageSearchMergeStatus>;
  cancel(): void;
}

export function runMessageSearchMerge(
  dbPath: string,
  timeoutMs: number = DEFAULT_MESSAGE_SEARCH_MERGE_TIMEOUT_MS
): MessageSearchMergeHandle {
  if (typeof Worker === 'undefined') {
    return { promise: Promise.resolve('worker-unavailable'), cancel: () => {} };
  }
  let finish: (status: MessageSearchMergeStatus) => void = () => {};
  const promise = new Promise<MessageSearchMergeStatus>((resolve) => {
    let settled = false;
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    finish = (status) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      worker?.terminate();
      resolve(status);
    };
    try {
      worker = new Worker(new URL('./message-search-merge-worker.ts', import.meta.url).href, {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<MergeWorkerResponse>) => {
        const { ok, error } = event.data;
        if (!ok && error && !/no such table/i.test(error)) {
          log.warn('message_search_fts background merge failed:', error);
          finish('failed');
          return;
        }
        finish('merged');
      };
      worker.onerror = (event: ErrorEvent) => {
        log.warn('message_search_fts background merge worker failed:', event.message);
        finish('worker-unavailable');
      };
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      worker.postMessage({ dbPath });
    } catch (error) {
      log.warn('message_search_fts background merge could not start:', error);
      finish('worker-unavailable');
    }
  });
  return { promise, cancel: () => finish('cancelled') };
}
