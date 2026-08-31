import { JobQueueRepository } from '../../src/storage/repositories/job-queue-repository';
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

export type MailboxTestDb = {
  db: Database;
  jobQueue: JobQueueRepository;
  rows: () => MailboxJobRow[];
  rowCount: () => number;
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
  `);
  const jobQueue = new JobQueueRepository(db);
  return {
    db,
    jobQueue,
    rows: () => db.prepare('SELECT * FROM job_queue ORDER BY rowid ASC').all() as MailboxJobRow[],
    rowCount: () => (db.prepare('SELECT COUNT(*) AS c FROM job_queue').get() as { c: number }).c,
    close: () => db.close(),
  };
}
