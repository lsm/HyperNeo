import { Logger } from './logger';

const DEFAULT_MESSAGE_SEARCH_MERGE_TIMEOUT_MS = 30_000;

const log = new Logger('Database');

type MergeWorkerResponse = {
  ok: boolean;
  error?: string;
};

export interface MessageSearchMergeHandle {
  promise: Promise<void>;
  cancel(): void;
}

export function runMessageSearchMerge(
  dbPath: string,
  timeoutMs: number = DEFAULT_MESSAGE_SEARCH_MERGE_TIMEOUT_MS
): MessageSearchMergeHandle {
  if (typeof Worker === 'undefined') {
    return { promise: Promise.resolve(), cancel: () => {} };
  }
  let finish: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    let settled = false;
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      worker?.terminate();
      resolve();
    };
    try {
      worker = new Worker(new URL('./message-search-merge-worker.ts', import.meta.url).href, {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<MergeWorkerResponse>) => {
        const { ok, error } = event.data;
        if (!ok && error && !/no such table/i.test(error)) {
          log.warn('message_search_fts background merge failed:', error);
        }
        finish();
      };
      worker.onerror = (event: ErrorEvent) => {
        log.warn('message_search_fts background merge worker failed:', event.message);
        finish();
      };
      timer = setTimeout(finish, timeoutMs);
      worker.postMessage({ dbPath });
    } catch (error) {
      log.warn('message_search_fts background merge could not start:', error);
      finish();
    }
  });
  return { promise, cancel: finish };
}
