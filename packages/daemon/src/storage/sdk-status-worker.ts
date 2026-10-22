import { Database } from './sqlite-compat.ts';
import { SDKMessageRepository } from './repositories/sdk-message-repository.ts';
import { subscribeToStructuredLogs } from '../lib/logger.ts';
import {
  projectSDKStatusPage,
  type SDKStatusPage,
  type SDKStatusReply,
  type SDKStatusRequest,
} from './sdk-status-reader.ts';

const worker = globalThis as unknown as {
  onmessage: (event: { data: SDKStatusRequest }) => void;
  postMessage(reply: SDKStatusReply): void;
};
let db: Database | null = null;
let repository: SDKMessageRepository | null = null;
subscribeToStructuredLogs((log) => {
  if (log.module === 'hyperneo:daemon:sqlite.query') worker.postMessage({ log });
});

worker.onmessage = ({ data }) => {
  const { id, epoch, args } = data,
    started = performance.now(),
    queueMs = Date.now() - data.sentAt;
  try {
    let result: SDKStatusPage | null = null;
    if (!args) {
      db?.close();
      db = null;
      repository = null;
    } else {
      if (!db) {
        db = new Database(data.dbPath, {
          readonly: true,
          queryObservability: data.queryObservability,
        });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
        repository = new SDKMessageRepository(db);
      }
      const page = db.transaction(() =>
        repository!.getUserMessagesByStatus(args.sessionId, args.status, args.limit)
      )();
      result = projectSDKStatusPage(page, args.status);
    }
    worker.postMessage({
      id,
      epoch,
      result,
      finishedAt: Date.now(),
      workerMs: performance.now() - started,
      queueMs,
    });
  } catch (error) {
    worker.postMessage({
      id,
      epoch,
      error: error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
      workerMs: performance.now() - started,
      queueMs,
    });
  }
};
