import { Database } from '../../storage/sqlite-compat.ts';
import { purgeWorkFeedSessions } from '../../storage/work-feed.ts';
import { subscribeToStructuredLogs } from '../logger.ts';
import { ingestExternalEvent } from './ingest-external-event-pipeline.ts';
import { SessionExternalEventStore } from './session-external-event-store.ts';
import type { SessionEventWriteRequest, SessionEventWriteReply } from './session-event-writer.ts';

const worker = globalThis as unknown as {
  onmessage: (event: { data: SessionEventWriteRequest }) => void;
  postMessage(reply: SessionEventWriteReply): void;
};
let db: Database | null = null;
let store: SessionExternalEventStore | null = null;
let workerOperation = 'session-event-ingest';
subscribeToStructuredLogs((log) => {
  if (log.module === 'hyperneo:daemon:sqlite.query')
    worker.postMessage({ log: { ...log, metadata: { ...log.metadata, workerOperation } } });
});
worker.onmessage = async ({ data }) => {
  const { id, epoch, event } = data,
    started = performance.now(),
    queueMs = Date.now() - data.sentAt;
  workerOperation = data.purgeClaudeSessions ? 'claude-feed-purge' : 'session-event-ingest';
  try {
    let outcome;
    if (!event && !data.purgeClaudeSessions) {
      db?.close();
      db = null;
      store = null;
    } else {
      if (!db) {
        db = new Database(data.dbPath, { queryObservability: data.queryObservability });
        db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
        store = new SessionExternalEventStore(db);
      }
      if (data.purgeClaudeSessions)
        await purgeWorkFeedSessions(db, 'claude', data.purgeClaudeSessions);
      else
        outcome = db.transaction(() => {
          const result = ingestExternalEvent(
            { store: (candidate) => store!.store(candidate) },
            event!
          );
          if (result.action === 'failed') throw result.error;
          return result;
        })();
    }
    worker.postMessage({
      id,
      epoch,
      outcome,
      workerMs: performance.now() - started,
      queueMs,
      finishedAt: Date.now(),
    });
  } catch (error) {
    worker.postMessage({
      id,
      epoch,
      error: error instanceof Error ? error.message : String(error),
      workerMs: performance.now() - started,
      queueMs,
      finishedAt: Date.now(),
    });
  }
};

worker.postMessage({ ready: true });
