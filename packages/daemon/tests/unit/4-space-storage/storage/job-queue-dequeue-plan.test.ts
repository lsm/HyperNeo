import { describe, expect, test } from 'bun:test';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import { buildJobQueueSessionFifoSelection } from '../../../../src/storage/repositories/job-queue-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('buildJobQueueSessionFifoSelection', () => {
  test('filters active lanes inside the index that carries status and run_at', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const { sql, params } = buildJobQueueSessionFifoSelection({
      queue: MESSAGE_DELIVERY,
      now: 1_800_000_000_000,
      limit: 1,
    });
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((row) => row.detail)
      .filter((detail) => /job_queue USING/.test(detail));
    expect(plan).toEqual(['SEARCH job_queue USING INDEX idx_job_queue_dequeue (queue=?)']);
    db.close();
  });
});
