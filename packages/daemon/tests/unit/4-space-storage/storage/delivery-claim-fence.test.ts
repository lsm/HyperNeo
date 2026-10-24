import { describe, expect, test } from 'bun:test';
import { activatePrompts, retryPrompt } from '../../../../src/lib/agent/message-delivery-outbox';
import { MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

const SESSION = 'sess-fence';

type Claim = 'live' | 'stale' | 'cancelled';
type Gate = 'admit' | 'settled' | 'blocked';

function setup(claim: Claim, status: 'deferred' | 'failed') {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys = OFF');
  const jobQueue = new JobQueueRepository(db);
  jobQueue.enqueue({
    queue: MAILBOX_LANE,
    payload: { to: { kind: 'session', sessionId: SESSION } },
  });
  const [job] = jobQueue.dequeue(MAILBOX_LANE, 1);
  if (claim === 'cancelled')
    db.prepare(`UPDATE job_queue SET status = 'dead' WHERE id = ?`).run(job.id);
  db.prepare(
    `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
     VALUES ('row-1', ?, 'user', ?, ?, ?, 'fenced')`
  ).run(
    SESSION,
    JSON.stringify({ type: 'user', uuid: 'fenced', message: { role: 'user', content: 'hi' } }),
    new Date().toISOString(),
    status
  );
  const claimToken = claim === 'stale' ? 'another-attempt' : job.claimToken;
  return { db, jobQueue, claim: { jobId: job.id, claimToken } };
}

function gate(kind: Gate, calls: string[]): () => boolean {
  return () => {
    calls.push(kind);
    if (kind === 'blocked') throw new Error('mailbox: direct owner unavailable');
    return kind === 'admit';
  };
}

function todayOutcome(claim: Claim, kind: Gate): 'write' | 'skip' | 'throw' {
  if (claim !== 'live') return 'skip';
  if (kind === 'blocked') return 'throw';
  return kind === 'admit' ? 'write' : 'skip';
}

const cases = (['live', 'stale', 'cancelled'] as const).flatMap((claim) =>
  (['admit', 'settled', 'blocked'] as const).map((kind) => ({ claim, kind }))
);

describe('activatePrompts and retryPrompt claim fence', () => {
  test.each(cases)(
    'activatePrompts with a $claim claim and a $kind gate matches the old isClaimCurrent && canDeliver outcome',
    async ({ claim, kind }) => {
      const { db, jobQueue, claim: fence } = setup(claim, 'deferred');
      const calls: string[] = [];
      const run = activatePrompts({
        db,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['fenced'],
        origin: 'chat',
        claim: fence,
        canDeliver: gate(kind, calls),
      });
      const expected = todayOutcome(claim, kind);
      if (expected === 'throw') await expect(run).rejects.toThrow('direct owner unavailable');
      else expect((await run).activated.length).toBe(expected === 'write' ? 1 : 0);
      expect(calls).toEqual(claim === 'live' ? [kind] : []);
      db.close();
    }
  );

  test.each(cases)(
    'retryPrompt with a $claim claim and a $kind gate matches the old isClaimCurrent && canDeliver outcome',
    async ({ claim, kind }) => {
      const { db, jobQueue, claim: fence } = setup(claim, 'failed');
      const calls: string[] = [];
      const run = retryPrompt({
        db,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'fenced',
        origin: 'chat',
        claim: fence,
        canDeliver: gate(kind, calls),
      });
      const expected = todayOutcome(claim, kind);
      if (expected === 'throw') await expect(run).rejects.toThrow('direct owner unavailable');
      else expect((await run) === null).toBe(expected !== 'write');
      expect(calls).toEqual(claim === 'live' ? [kind] : []);
      db.close();
    }
  );

  test('a claim lost after the gate admits still blocks the write inside the transaction', async () => {
    const { db, jobQueue, claim: fence } = setup('live', 'deferred');
    const { activated } = await activatePrompts({
      db,
      jobQueue,
      sessionId: SESSION,
      messageUuids: ['fenced'],
      origin: 'chat',
      claim: fence,
      canDeliver: () => {
        db.prepare(`UPDATE job_queue SET status = 'dead' WHERE id = ?`).run(fence.jobId);
        return true;
      },
    });
    expect(activated).toEqual([]);
    db.close();
  });
});
