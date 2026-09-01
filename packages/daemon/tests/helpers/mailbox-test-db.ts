import { JobQueueRepository } from '../../src/storage/repositories/job-queue-repository';
import { SDKMessageRepository } from '../../src/storage/repositories/sdk-message-repository';
import { Database } from '../../src/storage/sqlite-compat';

export type MailboxJobRow = {
  id: string;
  queue: string;
  status: string;
  payload: string;
  result: string | null;
  error: string | null;
  priority: number;
  max_retries: number;
  retry_count: number;
  run_at: number;
  created_at: number;
  started_at: number | null;
  heartbeat_at: number | null;
  completed_at: number | null;
};

export type MailboxSdkMessageRow = {
  id: string;
  session_id: string;
  message_type: string;
  sdk_message: string;
  send_status: string;
  origin: string | null;
  sdk_uuid: string;
};

export type MailboxTestDb = {
  db: Database;
  jobQueue: JobQueueRepository;
  sdkMessageRepo: SDKMessageRepository;
  rows: () => MailboxJobRow[];
  rowCount: () => number;
  jobsByQueue: (queue: string) => MailboxJobRow[];
  sdkRows: () => MailboxSdkMessageRow[];
  close: () => void;
};

export function createMailboxTestDb(): MailboxTestDb {
  const db = new Database(':memory:');
  db.exec(`
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

    CREATE INDEX idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
    CREATE INDEX idx_job_queue_status ON job_queue(status);

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
  `);
  const jobQueue = new JobQueueRepository(db);
  const sdkMessageRepo = new SDKMessageRepository(db as never);
  return {
    db,
    jobQueue,
    sdkMessageRepo,
    rows: () => db.prepare('SELECT * FROM job_queue ORDER BY rowid ASC').all() as MailboxJobRow[],
    rowCount: () => (db.prepare('SELECT COUNT(*) AS c FROM job_queue').get() as { c: number }).c,
    jobsByQueue: (queue: string) =>
      db
        .prepare('SELECT * FROM job_queue WHERE queue = ? ORDER BY rowid ASC')
        .all(queue) as MailboxJobRow[],
    sdkRows: () =>
      db.prepare('SELECT * FROM sdk_messages ORDER BY rowid ASC').all() as MailboxSdkMessageRow[],
    close: () => db.close(),
  };
}
