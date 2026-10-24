import { sdkPendingRemoval } from '../../../../src/storage/repositories/sdk-message-transactions';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  requireOwnedQueuedInput,
  withdrawOwnedInput,
  type OwnedInputWithdrawalDeps,
} from '../../../../src/lib/drivers/owned-input-withdrawal';
import { createMailboxEntry } from '../../../../src/lib/mailbox/entry';
import { enqueueMailboxEntry } from '../../../../src/lib/mailbox/enqueue';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

describe('owned deferred input withdrawal', () => {
  let db: MailboxTestDb;
  let deps: OwnedInputWithdrawalDeps;
  let entry: ReturnType<typeof createMailboxEntry>;
  let removed: string[];

  beforeEach(() => {
    db = createMailboxTestDb();
    removed = [];
    entry = createMailboxEntry({
      to: { kind: 'session', sessionId: 'target' },
      origin: 'session:sender',
      message: { type: 'user', message: { content: 'later' }, parent_tool_use_id: null },
      messageUuid: 'input',
      deliveryMode: 'defer',
    });
    enqueueMailboxEntry(db.jobQueue, entry);
    deps = {
      jobs: db.jobQueue,
      transaction: (effect) => db.db.transaction(effect)(),
      messageId: (sessionId, uuid) => db.sdkMessageRepo.findMessageIdByUuid(sessionId, uuid),
      removeDeferred: async (sessionId, messageDbId, withdrawalJobId) => {
        removed.push(messageDbId);
        return !!(
          await db.sdkMessageRepo.runWrite(sdkPendingRemoval, {
            sessionId,
            messageDbId,
            mode: 'remove',
            expectedStatus: 'deferred',
            withdrawalJobId,
          })
        )?.uuid;
      },
    };
  });

  afterEach(() => db.close());

  const withdraw = () => withdrawOwnedInput('target', entry.id, 'session:sender', deps);

  function materialize(status: string) {
    db.db
      .prepare(`INSERT INTO sdk_messages
      (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
      VALUES ('db-input', 'target', 'user', '{"uuid":"input"}', '2026-10-16', ?, 'input')`)
      .run(status);
  }

  function jobStatus(status: string) {
    db.db.prepare('UPDATE job_queue SET status = ?').run(status);
  }

  test('cancels an unclaimed mailbox entry and retries without another effect', async () => {
    const expected = { ok: true, value: { queuedSubmissionId: entry.id, withdrawn: true } };
    expect(await withdraw()).toEqual(expected);
    expect(db.rows()[0]).toMatchObject({ status: 'dead', error: 'driver_input_withdrawn' });
    expect(await withdraw()).toEqual(expected);
    expect(removed).toEqual([]);
    expect(db.jobQueue.dequeue('mailbox')).toEqual([]);
  });

  test.each(['pending', 'completed'])(
    'removes the deferred SDK row as well as a %s mailbox job',
    async (status) => {
      materialize('deferred');
      jobStatus(status);
      expect(await withdraw()).toMatchObject({ ok: true, value: { withdrawn: true } });
      expect(db.sdkRows()).toEqual([]);
      expect(removed).toEqual(['db-input']);
      expect(await withdraw()).toMatchObject({ ok: true, value: { withdrawn: true } });
      expect(removed).toEqual(['db-input']);
    }
  );

  test.each(['processing', 'failed', 'dead'])(
    'does not touch a mailbox job already %s',
    async (status) => {
      materialize('deferred');
      jobStatus(status);
      expect(await withdraw()).toMatchObject({ value: { withdrawn: false, reason: 'not_queued' } });
      expect(db.sdkRows()).toHaveLength(1);
      expect(removed).toEqual([]);
      expect(db.rows()[0].status).toBe(status);
    }
  );

  test.each(['enqueued', 'consumed'])(
    'never claims to retract an SDK input already %s',
    async (status) => {
      materialize(status);
      jobStatus('completed');
      expect(await withdraw()).toMatchObject({ value: { withdrawn: false } });
      expect(db.sdkRows()[0].send_status).toBe(status);
      expect(db.rows()[0].status).toBe('completed');
    }
  );

  test('a completed job without a retained SDK row is not withdrawal evidence', async () => {
    jobStatus('completed');
    expect(await withdraw()).toMatchObject({ value: { withdrawn: false } });
    expect(db.rows()[0].status).toBe('completed');
  });

  test('fails conservatively if a worker claims the mailbox before the CAS', async () => {
    deps.jobs = {
      getLatestByPayload: (...args) => db.jobQueue.getLatestByPayload(...args),
      markDeadIfActive: (...args) => {
        jobStatus('processing');
        return db.jobQueue.markDeadIfActive(...args);
      },
    };
    expect(await withdraw()).toMatchObject({ value: { withdrawn: false } });
    expect(removed).toEqual([]);
    expect(db.rows()[0].status).toBe('processing');
  });

  test('SDK activation racing removal is not reported as withdrawn', async () => {
    materialize('deferred');
    deps.removeDeferred = async () => {
      db.db.exec("UPDATE sdk_messages SET send_status = 'enqueued'");
      return false;
    };
    expect(await withdraw()).toMatchObject({ value: { withdrawn: false } });
    expect(await withdraw()).toMatchObject({ value: { withdrawn: false } });
    expect(db.sdkRows()[0].send_status).toBe('enqueued');
  });

  test('a pending withdrawal resumes after a pre-delete interruption', async () => {
    materialize('deferred');
    const removeDeferred = deps.removeDeferred;
    deps.removeDeferred = async () => {
      throw new Error('runtime gone');
    };
    await expect(withdraw()).rejects.toThrow('runtime gone');
    expect(db.rows()[0].error).toBe('driver_input_withdrawing');
    expect(db.sdkRows()).toHaveLength(1);
    deps.removeDeferred = removeDeferred;
    expect(await withdraw()).toMatchObject({ value: { withdrawn: true } });
    expect(db.sdkRows()).toEqual([]);
  });

  test.each(['pending', 'completed'])(
    'retries a %s job after interruption following the committed delete',
    async (status) => {
      materialize('deferred');
      jobStatus(status);
      const removeDeferred = deps.removeDeferred;
      deps.removeDeferred = async (...args) => {
        await removeDeferred(...args);
        throw new Error('cleanup interrupted');
      };
      await expect(withdraw()).rejects.toThrow('cleanup interrupted');
      expect(db.sdkRows()).toEqual([]);
      expect(db.rows()[0].error).toBe('driver_input_withdrawn');
      expect(await withdraw()).toMatchObject({ value: { withdrawn: true } });
    }
  );

  test('a failed tombstone write rolls back the SDK deletion before retry', async () => {
    materialize('deferred');
    jobStatus('completed');
    db.db.exec(
      "CREATE TRIGGER fail_tombstone BEFORE UPDATE ON job_queue WHEN NEW.error='driver_input_withdrawn' BEGIN SELECT RAISE(ABORT,'storage failed'); END"
    );
    await expect(withdraw()).rejects.toThrow('storage failed');
    expect(db.sdkRows()).toHaveLength(1);
    expect(db.rows()[0].status).toBe('completed');
    db.db.exec('DROP TRIGGER fail_tombstone');
    expect(await withdraw()).toMatchObject({ value: { withdrawn: true } });
  });

  test.each(['target', 'sender', 'entry', 'mode', 'uuid', 'queue', 'missing'])(
    'admission rejects mismatched %s without mutation',
    async (field) => {
      const job = db.jobQueue.getLatestByPayload('mailbox', { id: entry.id })!;
      if (field === 'mode') job.payload.deliveryMode = 'immediate';
      if (field === 'uuid') delete job.payload.messageUuid;
      if (field === 'queue') job.queue = 'other';
      const gate = requireOwnedQueuedInput(
        field === 'missing' ? null : job,
        field === 'target' ? 'foreign' : 'target',
        field === 'entry' ? 'foreign' : entry.id,
        field === 'sender' ? 'session:foreign' : 'session:sender'
      );
      expect(gate).toMatchObject({ reason: { value: { withdrawn: false } } });
      expect(await withdrawOwnedInput('foreign', entry.id, 'session:sender', deps)).toMatchObject({
        value: { withdrawn: false },
      });
      expect(db.rows()[0].status).toBe('pending');
    }
  );
});
