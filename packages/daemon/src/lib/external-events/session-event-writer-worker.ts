import { Database } from '../../storage/sqlite-compat.ts';
import { purgeWorkFeedSessions } from '../../storage/work-feed.ts';
import { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
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
    worker.postMessage({
      log: {
        ...log,
        metadata:
          log.metadata.event === 'summary' ? log.metadata : { ...log.metadata, workerOperation },
      },
    });
});
worker.onmessage = async ({ data }) => {
  const { id, epoch, event } = data,
    started = performance.now(),
    queueMs = Date.now() - data.sentAt;
  workerOperation = data.claimJobs
    ? 'job-queue-dequeue'
    : data.cleanupJobs
      ? 'job-queue-cleanup'
      : data.purgeClaudeSessions
        ? 'claude-feed-purge'
        : 'session-event-ingest';
  try {
    let outcome;
    if (!event && !data.purgeClaudeSessions && !data.cleanupJobs && !data.claimJobs) {
      db?.close();
      db = null;
      store = null;
    } else {
      if (!db) {
        db = new Database(data.dbPath, { queryObservability: data.queryObservability });
        db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
        store = new SessionExternalEventStore(db);
      }
      if (data.claimJobs) {
        const queue = new JobQueueRepository(db);
        const request = data.claimJobs;
        outcome =
          request.method === 'dequeue'
            ? queue.dequeue(...request.args)
            : request.method === 'dequeueSessionFifo'
              ? queue.dequeueSessionFifo(...request.args)
              : queue.dequeueExempt(...request.args);
      } else if (data.cleanupJobs) {
        const queue = new JobQueueRepository(db);
        outcome = queue.cleanup(data.cleanupJobs.beforeMs);
        for (const { queue: name, beforeMs } of data.cleanupJobs.completed)
          outcome += queue.cleanupCompleted(name, beforeMs);
      } else if (data.purgeClaudeSessions)
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
