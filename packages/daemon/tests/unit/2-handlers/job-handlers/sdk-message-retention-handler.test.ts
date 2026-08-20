import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createSdkMessageRetentionHandler,
  enqueueSdkMessageRetentionIfMissing,
} from '../../../../src/lib/job-handlers/sdk-message-retention.handler';
import { SDK_MESSAGE_RETENTION } from '../../../../src/lib/job-queue-constants';
import {
  type Job,
  JobQueueRepository,
} from '../../../../src/storage/repositories/job-queue-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function createTestDb(): Database {
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

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      type TEXT,
      session_context TEXT,
      visible_message_count INTEGER NOT NULL DEFAULT 0
    );

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
      consumed_seq INTEGER,
      replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE delivery_turn_end (
      session_id TEXT NOT NULL,
      message_uuid TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      PRIMARY KEY (session_id, message_uuid)
    );

    CREATE TABLE delivery_consumed_seq (
      singleton INTEGER PRIMARY KEY DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1
    );
    INSERT OR IGNORE INTO delivery_consumed_seq (singleton, next_seq) VALUES (1, 1);

    CREATE INDEX idx_sdk_messages_session_timestamp_id
      ON sdk_messages(session_id, timestamp DESC, id DESC);
  `);
  return db;
}

function insertSession(db: Database, id: string, status = 'archived'): void {
  db.prepare(
    `INSERT INTO sessions (id, title, status, type, session_context, visible_message_count)
     VALUES (?, '', ?, 'worker', NULL, 0)`
  ).run(id, status);
}

function insertMessage(db: Database, id: string, sessionId: string, daysAgo: number): void {
  db.prepare(
    `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status)
     VALUES (?, ?, 'assistant', '{}', ?, 'consumed')`
  ).run(id, sessionId, iso(daysAgo));
}

const fakeJob: Job = {
  id: 'retention-job',
  queue: SDK_MESSAGE_RETENTION,
  status: 'processing',
  payload: {},
  result: null,
  error: null,
  priority: 0,
  maxRetries: 3,
  retryCount: 0,
  runAt: Date.now(),
  createdAt: Date.now(),
  startedAt: Date.now(),
  completedAt: null,
};

describe('createSdkMessageRetentionHandler', () => {
  let db: Database;
  let jobQueue: JobQueueRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let settings: Record<string, unknown>;

  beforeEach(() => {
    db = createTestDb();
    jobQueue = new JobQueueRepository(db as any);
    sdkMessageRepo = new SDKMessageRepository(db as any);
    settings = {};
  });

  afterEach(() => {
    db.close();
  });

  it('is a no-op when retention is disabled and still self-schedules ~24h out', async () => {
    const handler = createSdkMessageRetentionHandler({
      getSettings: () => settings as never,
      sdkMessageRepo,
      jobQueue,
    });
    const before = Date.now();
    const result = await handler(fakeJob);
    const after = Date.now();

    expect(result.deleted).toBe(0);
    const pending = jobQueue.listJobs({
      queue: SDK_MESSAGE_RETENTION,
      status: 'pending',
      limit: 10,
    });
    expect(pending.length).toBe(1);
    expect(pending[0].runAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(pending[0].runAt).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
  });

  it('deletes expired archived-session messages when retention is enabled', async () => {
    insertSession(db, 's1');
    insertMessage(db, 'm-old', 's1', 60);
    insertMessage(db, 'm-recent', 's1', 2);
    settings = { sdkMessageRetentionDays: 30 };

    const handler = createSdkMessageRetentionHandler({
      getSettings: () => settings as never,
      sdkMessageRepo,
      jobQueue,
    });
    const result = await handler(fakeJob);

    expect(result.deleted).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(
      db
        .prepare(`SELECT id FROM sdk_messages`)
        .all()
        .map((r) => (r as { id: string }).id)
    ).toEqual(['m-recent']);
  });

  it('bounds an excessively large retention value without throwing', async () => {
    settings = { sdkMessageRetentionDays: 1_000_000_000 };
    const stubRepo = {
      deleteExpiredArchivedSessionMessages: () => ({
        deleted: 0,
        affectedSessions: [],
        hasMore: false,
      }),
    } as unknown as SDKMessageRepository;

    const handler = createSdkMessageRetentionHandler({
      getSettings: () => settings as never,
      sdkMessageRepo: stubRepo,
      jobQueue,
    });

    await expect(handler(fakeJob)).resolves.toMatchObject({ deleted: 0, hasMore: false });
  });

  it('schedules the next run sooner when the batch limit is hit', async () => {
    settings = { sdkMessageRetentionDays: 30 };
    const stubRepo = {
      deleteExpiredArchivedSessionMessages: () => ({
        deleted: 50_000,
        affectedSessions: ['s1'],
        hasMore: true,
      }),
    } as unknown as SDKMessageRepository;

    const handler = createSdkMessageRetentionHandler({
      getSettings: () => settings as never,
      sdkMessageRepo: stubRepo,
      jobQueue,
    });
    const before = Date.now();
    const result = await handler(fakeJob);
    const after = Date.now();

    expect(result.hasMore).toBe(true);
    const pending = jobQueue.listJobs({
      queue: SDK_MESSAGE_RETENTION,
      status: 'pending',
      limit: 10,
    });
    expect(pending.length).toBe(1);
    expect(pending[0].runAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
    expect(pending[0].runAt).toBeLessThanOrEqual(after + 5 * 60 * 1000);
  });

  it('does not create duplicate pending jobs when one already exists', async () => {
    jobQueue.enqueue({ queue: SDK_MESSAGE_RETENTION, payload: {}, runAt: Date.now() + 1000 });

    const handler = createSdkMessageRetentionHandler({
      getSettings: () => settings as never,
      sdkMessageRepo,
      jobQueue,
    });
    await handler(fakeJob);

    const pending = jobQueue.listJobs({
      queue: SDK_MESSAGE_RETENTION,
      status: 'pending',
      limit: 10,
    });
    expect(pending.length).toBe(1);
  });
});

describe('enqueueSdkMessageRetentionIfMissing', () => {
  let db: Database;
  let jobQueue: JobQueueRepository;

  beforeEach(() => {
    db = createTestDb();
    jobQueue = new JobQueueRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  it('schedules only when none is pending', () => {
    enqueueSdkMessageRetentionIfMissing(jobQueue, 123);
    enqueueSdkMessageRetentionIfMissing(jobQueue, 456);

    const pending = jobQueue.listJobs({
      queue: SDK_MESSAGE_RETENTION,
      status: 'pending',
      limit: 10,
    });
    expect(pending.length).toBe(1);
    expect(pending[0].runAt).toBe(123);
  });
});
