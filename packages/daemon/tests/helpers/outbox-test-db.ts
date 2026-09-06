import { Database } from '../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../src/lib/job-queue-constants';

export interface OutboxTestDb {
  db: Database;
  sdkRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
  userRowCount(sessionId: string): number;
  userRowIdByUuid(sessionId: string, uuid: string): string | null;
  sendStatus(sessionId: string, uuid: string): string | null | undefined;
  pendingDeliveryJobCount(sessionId: string, uuid?: string): number;
  completeDeliveryJobs(sessionId: string, uuid: string): void;
  breakingEnqueue(): JobQueueRepository;
}

export function createOutboxTestDb(): OutboxTestDb {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      send_status TEXT,
      origin TEXT,
      is_renderable INTEGER NOT NULL DEFAULT 1,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      conversation_turn_index INTEGER,
      parent_tool_use_id TEXT,
      task_id TEXT,
      sdk_uuid TEXT,
      replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0,
      consumed_seq INTEGER
    );
    CREATE TABLE sdk_message_replacements (
      source_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      target_uuid TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (source_message_id, target_uuid, kind)
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, visible_message_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id);

    CREATE TABLE job_queue (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_count INTEGER NOT NULL DEFAULT 0,
      run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      heartbeat_at INTEGER,
      completed_at INTEGER
    );
  `);
  const sdkRepo = new SDKMessageRepository(db as never);
  const jobQueue = new JobQueueRepository(db as never);
  return {
    db,
    sdkRepo,
    jobQueue,
    userRowCount(sessionId: string): number {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = ? AND message_type = 'user'`
          )
          .get(sessionId) as { n: number }
      ).n;
    },
    userRowIdByUuid(sessionId: string, uuid: string): string | null {
      const row = db
        .prepare(
          `SELECT id FROM sdk_messages WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ? LIMIT 1`
        )
        .get(sessionId, uuid) as { id: string } | undefined;
      return row?.id ?? null;
    },
    sendStatus(sessionId: string, uuid: string): string | null | undefined {
      return sdkRepo.getDeliveryContent(sessionId, uuid)?.sendStatus;
    },
    pendingDeliveryJobCount(sessionId: string, uuid?: string): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM job_queue
            WHERE queue = ?
              AND json_extract(payload, '$.sessionId') = ?
              ${uuid ? "AND json_extract(payload, '$.messageUuid') = ?" : ''}
              AND status IN ('pending', 'processing')`
        )
        .get(...(uuid ? [MESSAGE_DELIVERY, sessionId, uuid] : [MESSAGE_DELIVERY, sessionId])) as {
        n: number;
      };
      return row.n;
    },
    completeDeliveryJobs(sessionId: string, uuid: string): void {
      db.prepare(
        `UPDATE job_queue SET status = 'completed'
            WHERE queue = ?
              AND json_extract(payload, '$.sessionId') = ?
              AND json_extract(payload, '$.messageUuid') = ?`
      ).run(MESSAGE_DELIVERY, sessionId, uuid);
    },
    breakingEnqueue(): JobQueueRepository {
      return new Proxy(jobQueue, {
        get(target, prop, receiver) {
          if (prop === 'enqueue') {
            return () => {
              throw new Error('job queue unavailable');
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as JobQueueRepository;
    },
  };
}
