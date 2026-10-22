import { readCodexSnapshot } from './codex-desktop-read.ts';
import { countPendingTurns, readPendingTurns } from './turn-vectors.ts';
import { readMessageFacts } from '../lib/neo/message-status.ts';
import { readMessageFeed } from './sdk-message-feed-read.ts';
import { Database } from './sqlite-compat.ts';
import { SDKMessageRepository } from './repositories/sdk-message-repository.ts';
import { subscribeToStructuredLogs } from '../lib/logger.ts';
import {
  projectSDKStatusPage,
  projectSDKStatusMessage,
  readSDKMessagePage,
  sdkReadLogMetadata,
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
    worker.postMessage({
      log: { ...log, metadata: sdkReadLogMetadata(log.metadata, workerOperation) },
    });
});

worker.onmessage = ({ data }) => {
  const { id, epoch, args } = data,
    started = performance.now(),
    queueMs = Date.now() - data.sentAt;
  workerOperation = args
    ? 'query' in args
      ? 'work-search'
      : 'codexSnapshot' in args
        ? 'codex-snapshot'
        : 'turnVectors' in args
          ? 'turn-vectors'
          : 'neoMessageStatus' in args
            ? 'neo-message-status'
            : 'feed' in args
              ? 'message-feed'
              : 'page' in args
                ? 'sdk-page'
                : 'sdk-status'
    : 'close';
  try {
    let result: SDKReadResult | null = null;
    if (!args) {
      db?.close();
      db = null;
      repository = null;
    } else if ('codexSnapshot' in args) {
      result = readCodexSnapshot(args.codexSnapshot.statePath, args.codexSnapshot.includeClosed);
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
        if ('query' in args) {
          const semantic = args.semantic
            ? { model: args.semantic.model, vector: Float32Array.from(args.semantic.vector) }
            : undefined;
          return repository!.searchWorkChats(args.query, args.limit, semantic, args.kinds);
        }
        if ('turnVectors' in args) {
          const { model, dimensions, limit } = args.turnVectors;
          return limit === null
            ? countPendingTurns(db!, model, dimensions)
            : readPendingTurns(db!, model, dimensions, limit);
        }
        if ('neoMessageStatus' in args) return readMessageFacts(db!, args.neoMessageStatus);
        if ('feed' in args) return readMessageFeed(db!, args);
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

worker.postMessage({ ready: true });
