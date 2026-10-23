import { getConfig } from '../config.ts';
import {
  publishSQLiteWorkerLogs,
  type SQLiteWorkerLog,
} from '../storage/sqlite-worker-observability.ts';
import { Database as BunDatabase } from '../storage/sqlite-compat.ts';
import { withBusyRetry } from '../storage/busy-retry.ts';

const FTS_MERGE_RANK = 1024;

type MergeWorkerRequest = {
  dbPath: string;
  requestId?: string;
};

type MergeWorkerResponse = {
  ok: boolean;
  error?: string;
  lifecycle?: { openedAt: number; mergeMs: number; closeMs: number; closedAt: number };
};

type WorkerGlobal = {
  onmessage: ((event: { data: MergeWorkerRequest }) => void | Promise<void>) | null;
  postMessage(message: MergeWorkerResponse | SQLiteWorkerLog): void;
};

const worker = globalThis as unknown as WorkerGlobal;
let workerRequestId: string | undefined;
publishSQLiteWorkerLogs(
  (message) => worker.postMessage(message),
  () => ({ workerOperation: 'message_search_merge', workerRequestId })
);

worker.onmessage = (event) => {
  const { dbPath } = event.data;
  workerRequestId = event.data.requestId;
  let db: BunDatabase | null = null;
  let result: MergeWorkerResponse;
  const openedAt = Date.now();
  let mergeMs = 0,
    closeMs = 0;
  try {
    db = new BunDatabase(dbPath, { queryObservability: getConfig().sqlQueryObservability });
    db.exec(`PRAGMA busy_timeout = 5000`);
    const mergeStart = performance.now();
    withBusyRetry(() => {
      db?.exec(
        `INSERT INTO message_search_fts(message_search_fts, rank) VALUES('merge', ${FTS_MERGE_RANK})`
      );
    });
    mergeMs = performance.now() - mergeStart;
    result = { ok: true };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    const closeStart = performance.now();
    db?.close();
    closeMs = performance.now() - closeStart;
  }
  worker.postMessage({
    ...result,
    lifecycle: { openedAt, mergeMs, closeMs, closedAt: Date.now() },
  });
};
