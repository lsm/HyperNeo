import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { runRateLimitManualRetry } from '../../../../src/lib/agent/rate-limit-manual-retry';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { createMailboxTestDb } from '../../../helpers/mailbox-test-db';

describe('persisted rate-limit retry writer boundary', () => {
  let fixture: ReturnType<typeof createMailboxTestDb>;
  let gateway: DbGateway;
  const sessionId = 'retry-session';
  const cooldown = JSON.stringify({ status: 'rate_limit_cooldown' });

  beforeEach(() => {
    fixture = createMailboxTestDb();
    fixture.db.exec('ALTER TABLE sessions ADD COLUMN processing_state TEXT');
    fixture.db.exec("ALTER TABLE sessions ADD COLUMN config TEXT DEFAULT '{}'");
    fixture.db.exec("ALTER TABLE sessions ADD COLUMN metadata TEXT DEFAULT '{}'");
    fixture.db
      .prepare('INSERT INTO sessions (id, processing_state) VALUES (?, ?)')
      .run(sessionId, cooldown);
    gateway = new DbGateway(':memory:', fixture.db);
    bindGateway(fixture.db, gateway);
  });

  afterEach(async () => {
    await gateway.close();
    fixture.close();
  });

  function state(value: string) {
    fixture.db
      .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
      .run(value, sessionId);
  }

  function retry(
    clearCooldown = async () => {
      state(JSON.stringify({ status: 'idle' }));
    }
  ) {
    return runRateLimitManualRetry({
      db: {
        getDatabase: () => fixture.db,
        getSession: (id) => {
          const row = fixture.db
            .prepare('SELECT processing_state FROM sessions WHERE id = ?')
            .get(id) as { processing_state: string } | undefined;
          return row ? { processingState: row.processing_state } : null;
        },
      },
      sessionId,
      clearCooldown,
    });
  }

  function seed(owner = sessionId, queue = 'message_delivery') {
    return fixture.jobQueue.enqueue({
      queue,
      payload: { sessionId: owner, messageUuid: `input-${owner}` },
      runAt: Date.now() + 600000,
    });
  }

  test('releases every session delivery, retaining retries and fencing the old claim', async () => {
    const owning = seed();
    fixture.db
      .prepare('UPDATE job_queue SET run_at = ? WHERE id = ?')
      .run(Date.now() - 1, owning.id);
    const [claim] = fixture.jobQueue.dequeue('message_delivery');
    fixture.db.prepare('UPDATE job_queue SET retry_count = 2 WHERE id = ?').run(owning.id);
    const next = seed();
    const other = seed('unrelated-session');
    const otherQueue = seed(sessionId, 'mailbox');
    expect(await retry()).toBe(true);
    for (const id of [owning.id, next.id]) {
      expect(fixture.jobQueue.getJob(id)).toMatchObject({
        status: 'pending',
        startedAt: null,
        heartbeatAt: null,
        claimToken: null,
      });
      expect(fixture.jobQueue.getJob(id)!.runAt).toBeLessThan(next.runAt);
    }
    expect(fixture.jobQueue.getJob(owning.id)!.retryCount).toBe(2);
    expect(fixture.jobQueue.heartbeat(owning.id, claim.claimToken)).toBe(false);
    expect(fixture.jobQueue.getJob(other.id)).toEqual(other);
    expect(fixture.jobQueue.getJob(otherQueue.id)).toEqual(otherQueue);
  });

  test('awaits cooldown clearing outside the writer transaction', async () => {
    const job = seed();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const pending = retry(async () => {
      fixture.db.exec('BEGIN IMMEDIATE');
      fixture.db.exec('ROLLBACK');
      await hold;
      state(JSON.stringify({ status: 'idle' }));
    }).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fixture.jobQueue.getJob(job.id)).toEqual(job);
    release();
    expect(await pending).toBe(true);
  });

  test('checks the latest cooldown after waiting for the writer', async () => {
    const job = seed();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = gateway.run.bind(gateway);
    let queued!: () => void;
    const arrived = new Promise<void>((resolve) => {
      queued = resolve;
    });
    gateway.run = async (op, input) => {
      queued();
      await hold;
      return run(op, input);
    };
    const pending = retry();
    await arrived;
    state(cooldown);
    release();
    expect(await pending).toBe(false);
    expect(fixture.jobQueue.getJob(job.id)).toEqual(job);
  });

  test('refuses to release when the cooldown callback leaves the persisted state active', async () => {
    const job = seed();
    expect(await retry(async () => {})).toBe(false);
    expect(fixture.jobQueue.getJob(job.id)).toEqual(job);
  });

  test('rolls back all releases if a later delivery update fails', async () => {
    const first = seed();
    const second = seed();
    fixture.db.exec(`CREATE TRIGGER reject_second BEFORE UPDATE ON job_queue
      WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    expect(await retry()).toBe(false);
    expect(fixture.jobQueue.getJob(first.id)).toEqual(first);
    expect(fixture.jobQueue.getJob(second.id)).toEqual(second);
  });

  test('rejects writer failure without an inline release', async () => {
    const job = seed();
    bindGateway(
      fixture.db,
      new DbGateway('synthetic-writer', null, undefined, () => {
        throw new Error('writer unavailable');
      })
    );
    expect(await retry()).toBe(false);
    expect(fixture.jobQueue.getJob(job.id)).toEqual(job);
  });

  test('reports a miss when there are no deliveries', async () => {
    expect(await retry()).toBe(false);
  });

  test('refuses orphaned deliveries if the session disappears before the commit', async () => {
    const job = seed();
    expect(
      await retry(async () => {
        fixture.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      })
    ).toBe(false);
    expect(fixture.jobQueue.getJob(job.id)).toEqual(job);
  });

  test('leaves jobs alone when cooldown clearing rejects', async () => {
    const job = seed();
    const clear = mock(async () => {
      throw new Error('clear failed');
    });
    await expect(retry(clear)).rejects.toThrow('clear failed');
    expect(fixture.jobQueue.getJob(job.id)).toEqual(job);
  });
});
