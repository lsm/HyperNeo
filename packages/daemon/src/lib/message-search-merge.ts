import { getConfig } from '../config.ts';
import {
  forwardSQLiteWorkerLog,
  type SQLiteWorkerLog,
} from '../storage/sqlite-worker-observability.ts';
import { Logger, emitStructuredLogEvent } from './logger.ts';

const DEFAULT_MESSAGE_SEARCH_MERGE_TIMEOUT_MS = 30_000;

const log = new Logger('Database');

type MergeWorkerResponse = {
  ok: boolean;
  error?: string;
  lifecycle?: { openedAt: number; mergeMs: number; closeMs: number; closedAt: number };
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
      worker.onmessage = (event: MessageEvent<MergeWorkerResponse | SQLiteWorkerLog>) => {
        if ('log' in event.data) {
          forwardSQLiteWorkerLog(event.data, 'message-search-merge');
          return;
        }
        const { ok, error, lifecycle } = event.data;
        if (lifecycle)
          emitStructuredLogEvent({
            level: 'debug',
            source: 'logger',
            module: 'hyperneo:daemon:sqlite.worker',
            args: ['sqlite.worker.lifecycle'],
            metadata: { event: 'message_search_merge', ...lifecycle, receivedAt: Date.now(), ok },
          });
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
      worker.postMessage({
        dbPath,
        requestId: crypto.randomUUID(),
        queryObservability: getConfig().sqlQueryObservability,
      });
    } catch (error) {
      log.warn('message_search_fts background merge could not start:', error);
      finish('worker-unavailable');
    }
  });
  return { promise, cancel: () => finish('cancelled') };
}
