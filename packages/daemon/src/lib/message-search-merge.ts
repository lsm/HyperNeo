import { Logger } from './logger';

const DEFAULT_MESSAGE_SEARCH_MERGE_TIMEOUT_MS = 30_000;

const log = new Logger('Database');

type MergeWorkerResponse = {
  ok: boolean;
  error?: string;
};

export function runMessageSearchMerge(
  dbPath: string,
  timeoutMs: number = DEFAULT_MESSAGE_SEARCH_MERGE_TIMEOUT_MS
): Promise<void> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./message-search-merge-worker.ts', import.meta.url).href, {
      type: 'module',
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    worker.onmessage = (event: MessageEvent<MergeWorkerResponse>) => {
      const { ok, error } = event.data;
      if (!ok && error && !/no such table/i.test(error)) {
        log.warn('message_search_fts background merge failed:', error);
      }
      finish();
    };
    worker.onerror = () => {
      finish();
    };
    worker.postMessage({ dbPath });
  });
}
