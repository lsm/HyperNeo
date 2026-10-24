import { describe, expect, test } from 'bun:test';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { cleanupJobsInBatches } from '../../../../src/storage/repositories/job-queue-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

const NOW = 1_800_000_000_000;

describe('cleanupJobsInBatches', () => {
  test('deletes past-retention jobs in bounded writer ops and keeps the rest', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const insert = db.prepare(
      `INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
       VALUES (?, ?, ?, '{"body":"complete retained job"}', 0, 3, 0, ?, ?, ?)`
    );
    db.transaction(() => {
      for (let i = 0; i < 1_200; i++) insert.run(`old-${i}`, 'synthetic', 'completed', 1, 1, 1);
      for (let i = 0; i < 300; i++) insert.run(`lane-${i}`, 'reminder', 'completed', 2, 2, 2);
      insert.run('lane-failed', 'reminder', 'failed', NOW, NOW, NOW);
      insert.run('young', 'synthetic', 'completed', NOW, NOW, NOW);
      insert.run('pending', 'synthetic', 'pending', 1, 1, null);
    })();
    const inline = new DbGateway(':memory:', db);
    const batches: number[] = [];
    const gateway = {
      run: async (...args: Parameters<DbGateway['run']>) => {
        const deleted = (await inline.run(...args)) as number;
        batches.push(deleted);
        return deleted;
      },
    } as unknown as DbGateway;

    const deleted = await cleanupJobsInBatches(gateway, {
      beforeMs: 10,
      completed: [{ queue: 'reminder', beforeMs: 10 }],
    });

    expect(deleted).toBe(1_500);
    expect(batches).toEqual([500, 500, 500, 0]);
    expect(
      (db.prepare('SELECT id FROM job_queue ORDER BY id').all() as { id: string }[]).map(
        (row) => row.id
      )
    ).toEqual(['lane-failed', 'pending', 'young']);
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT rowid FROM job_queue
            WHERE status IN ('completed', 'dead', 'failed') AND completed_at < ? LIMIT ?`
        )
        .all(10, 500) as { detail: string }[]
    ).map((row) => row.detail);
    expect(plan.join('\n')).toContain('idx_job_queue_status_completed');
    db.close();
  });
});
