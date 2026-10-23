import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  persistAndEnqueueDelivery,
  redeliverPrompt,
} from '../../../../src/lib/agent/message-delivery-outbox';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

const SESSION = 'sess-latest';

function seed(db: Database): void {
  const insert = db.prepare(
    `INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
     VALUES (?, ?, 'completed', ?, 0, 3, 0, ?, ?, ?)`
  );
  db.transaction(() => {
    for (let i = 0; i < 75_000; i++) {
      const delivery = i % 7 === 0;
      const payload = delivery
        ? JSON.stringify({ sessionId: `s${i % 300}`, messageUuid: `m${i}`, released: true })
        : JSON.stringify({ sessionId: `s${i % 300}`, path: '/feed' });
      insert.run(`j${i}`, delivery ? MESSAGE_DELIVERY : 'work.feed.claude', payload, i, i, i);
    }
  })();
}

describe('redeliverPrompt', () => {
  test('finds the latest delivery job of a message by its keys, not by reading every delivery job', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.exec('PRAGMA foreign_keys = OFF');
    seed(db);
    const jobQueue = new JobQueueRepository(db);
    const sdkMessageRepo = new SDKMessageRepository(db);
    persistAndEnqueueDelivery({
      db: db as never,
      jobQueue,
      sdkMessageRepo,
      sessionId: SESSION,
      message: {
        type: 'user',
        uuid: 'steered',
        message: { role: 'user', content: 'hi' },
      } as SDKMessage,
      sendStatus: 'enqueued',
      delivery: { origin: 'chat' },
    });
    const [job] = jobQueue.dequeue(MESSAGE_DELIVERY, 1);
    jobQueue.complete(job.id, {}, job.claimToken);
    const plans: string[] = [];
    const prepare = db.prepare.bind(db);
    const watched = Object.assign(Object.create(db), {
      transaction: (fn: () => unknown, mode?: string) => db.transaction(fn, mode as never),
      prepare: (sql: string) => {
        if (/ORDER BY created_at DESC/.test(sql))
          plans.push(
            ...(
              prepare(`EXPLAIN QUERY PLAN ${sql}`).all(SESSION, 'steered') as { detail: string }[]
            ).map((row) => row.detail)
          );
        return prepare(sql);
      },
    });
    expect(
      redeliverPrompt({
        db: watched,
        jobQueue,
        sdkMessageRepo,
        sessionId: SESSION,
        messageUuid: 'steered',
      })
    ).not.toBeNull();
    expect(plans.join('\n')).toMatch(/SEARCH job_queue USING INDEX \S+ \([^)]*<expr>=\?/);
    expect(
      db
        .prepare(
          `SELECT status FROM job_queue WHERE queue = ? AND json_extract(payload, '$.messageUuid') = 'steered'`
        )
        .all(MESSAGE_DELIVERY)
    ).toEqual([{ status: 'pending' }]);
    db.close();
  });
});
