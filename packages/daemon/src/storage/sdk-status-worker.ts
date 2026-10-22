import { Database } from './sqlite-compat.ts';
import { SDKMessageRepository } from './repositories/sdk-message-repository.ts';
import { subscribeToStructuredLogs } from '../lib/logger.ts';
import {
  projectSDKStatusPage,
  projectSDKStatusMessage,
  readSDKMessagePage,
  type SDKReadResult,
  type SDKStatusReply,
  type SDKStatusRequest,
} from './sdk-status-reader.ts';

const worker = globalThis as unknown as {
  onmessage: (event: { data: SDKStatusRequest }) => void;
  postMessage(reply: SDKStatusReply): void;
};
let db: Database | null = null;
let repository: SDKMessageRepository | null = null;
let workerOperation = 'sdk-status';
subscribeToStructuredLogs((log) => {
  if (log.module === 'hyperneo:daemon:sqlite.query')
    worker.postMessage({ log: { ...log, metadata: { ...log.metadata, workerOperation } } });
});

worker.onmessage = ({ data }) => {
  const { id, epoch, args } = data,
    started = performance.now(),
    queueMs = Date.now() - data.sentAt;
  workerOperation = args ? ('page' in args ? 'sdk-page' : 'sdk-status') : 'close';
  try {
    let result: SDKReadResult | null = null;
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
      result = db.transaction(() => {
        if ('page' in args) return readSDKMessagePage(repository!, args);
        return projectSDKStatusPage(
          repository!.getUserMessagesByStatus(
            args.sessionId,
            args.status,
            args.limit,
            'asc',
            projectSDKStatusMessage
          ),
          args.status
        );
      })();
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
