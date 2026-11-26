import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { NEO_PACK_SWEEP, sweepNeoPacks } from '../../../../src/lib/neo/pack-sweep';
import type { NeoService } from '../../../../src/lib/neo/service';

function pendingSweeps(db: Database): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM job_queue WHERE queue = ? AND status = 'pending'`)
    .get(NEO_PACK_SWEEP) as { n: number };
  return row.n;
}

describe('sweepNeoPacks', () => {
  let db: Database;
  let queue: JobQueueRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE job_queue (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
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
    queue = new JobQueueRepository(db);
  });

  it('schedules the next sweep only after this one ends', async () => {
    let finish!: () => void;
    const service = {
      sweepPacks: () => new Promise<void>((resolve) => (finish = resolve)),
    } as unknown as NeoService;

    const run = sweepNeoPacks(queue, service);
    await Promise.resolve();
    expect(pendingSweeps(db)).toBe(0);

    finish();
    await run;
    expect(pendingSweeps(db)).toBe(1);
  });

  it('still schedules the next sweep when this one fails', async () => {
    const service = {
      sweepPacks: async () => {
        throw new Error('boom');
      },
    } as unknown as NeoService;

    await expect(sweepNeoPacks(queue, service)).rejects.toThrow('boom');
    expect(pendingSweeps(db)).toBe(1);
  });
});
