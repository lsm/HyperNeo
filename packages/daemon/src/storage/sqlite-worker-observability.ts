import type { StructuredLogEvent } from '@hyperneo/shared';
import { emitStructuredLogEvent, subscribeToStructuredLogs } from '../lib/logger.ts';

export type SQLiteWorkerLog = { log: StructuredLogEvent };

export function publishSQLiteWorkerLogs(
  post: (message: SQLiteWorkerLog) => void,
  identity: () => Record<string, unknown>
): void {
  subscribeToStructuredLogs((log) => {
    if (log.module === 'hyperneo:daemon:sqlite.query')
      post({
        log: {
          ...log,
          metadata:
            log.metadata.event === 'summary' ? log.metadata : { ...log.metadata, ...identity() },
        },
      });
  });
}

export function forwardSQLiteWorkerLog({ log }: SQLiteWorkerLog, workerKind: string): void {
  emitStructuredLogEvent({
    ...log,
    args: [log.message],
    metadata: {
      ...log.metadata,
      workerKind,
      workerTimestamp: log.timestamp,
      workerEventId: log.id,
      workerProcess: log.process,
    },
  });
}
