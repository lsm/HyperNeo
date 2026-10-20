import { describe, expect, test } from 'bun:test';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function seed(db: Database): void {
  const insert = db.prepare(
    `INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
     VALUES (?, 'work.feed.claude', ?, '{"sessionId":"s"}', 0, 3, 0, ?, ?, ?)`
  );
  db.transaction(() => {
    for (let i = 0; i < 75_000; i++) {
      const at = NOW - (i % 6) * DAY_MS;
      insert.run(`recent-${i}`, i % 12 ? 'completed' : 'dead', at, at, at);
    }
    for (let i = 0; i < 400; i++) {
      const at = NOW - 8 * DAY_MS - i;
      insert.run(`old-${i}`, i % 10 ? 'completed' : 'failed', at, at, at);
    }
    for (let i = 0; i < 10; i++) insert.run(`pending-${i}`, 'pending', NOW, NOW - 9 * DAY_MS, null);
  })();
}

function cleanupPlan(db: Database, beforeMs: number): { plan: string; deleted: number } {
  const plan: string[] = [];
  const prepare = db.prepare.bind(db);
  const repository = new JobQueueRepository(
    Object.assign(Object.create(db), {
      prepare: (sql: string) => {
        if (sql.trim().startsWith('DELETE'))
          plan.push(
            ...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(beforeMs) as { detail: string }[]).map(
              (row) => row.detail
            )
          );
        return prepare(sql);
      },
    })
  );
  return { deleted: repository.cleanup(beforeMs), plan: plan.join('\n') };
}

describe('JobQueueRepository.cleanup', () => {
  test('deletes the finished jobs past retention by range, without walking every finished job', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    seed(db);
    const { deleted, plan } = cleanupPlan(db, NOW - 7 * DAY_MS);
    expect(deleted).toBe(400);
    expect(plan).toContain('completed_at<?');
    expect((db.prepare('SELECT count(*) AS n FROM job_queue').get() as { n: number }).n).toBe(
      75_010
    );
    db.close();
  });
});
