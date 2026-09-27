import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';
import {
  NEO_CONSULTATION_RECOVERY,
  recoverNeoConsultations,
  scheduleConsultationRecovery,
} from '../../../../src/lib/neo/consultation-recovery.ts';
import type { NeoService } from '../../../../src/lib/neo/service.ts';

describe('recoverNeoConsultations', () => {
  let mailbox: MailboxTestDb;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });
  afterEach(() => mailbox.close());

  test('schedules one durable next run before recovery, even if recovery fails', async () => {
    const before = Date.now();
    scheduleConsultationRecovery(mailbox.jobQueue);
    scheduleConsultationRecovery(mailbox.jobQueue);
    expect(mailbox.rowCount()).toBe(1);
    expect(mailbox.rows()[0].run_at).toBeGreaterThanOrEqual(before + 60_000);
    mailbox.db.prepare('UPDATE job_queue SET run_at = 0').run();
    const running = mailbox.jobQueue.dequeue(NEO_CONSULTATION_RECOVERY)[0];
    let calls = 0;
    const service = {
      recoverConsultations: async () => {
        calls++;
        expect(
          mailbox.jobQueue.listJobs({ queue: NEO_CONSULTATION_RECOVERY, status: 'pending' })
        ).toHaveLength(1);
        throw new Error('Temporary recovery failure');
      },
    } as unknown as NeoService;
    await expect(recoverNeoConsultations(mailbox.jobQueue, service)).rejects.toThrow(
      'Temporary recovery failure'
    );
    expect(calls).toBe(1);
    scheduleConsultationRecovery(mailbox.jobQueue);
    expect(mailbox.rowCount()).toBe(2);
    expect(mailbox.jobQueue.getJob(running.id)?.status).toBe('processing');
  });

  test('does not touch unrelated jobs and delegates recovery once', async () => {
    const unrelated = mailbox.jobQueue.enqueue({
      queue: 'mailbox',
      payload: { messageUuid: 'human' },
    });
    let calls = 0;
    const service = {
      recoverConsultations: async () => {
        calls++;
      },
    } as unknown as NeoService;
    expect(await recoverNeoConsultations(mailbox.jobQueue, service)).toEqual({ recovered: true });
    expect(calls).toBe(1);
    expect(mailbox.jobQueue.getJob(unrelated.id)).toEqual(unrelated);
    expect(
      mailbox.jobQueue.listJobs({ queue: NEO_CONSULTATION_RECOVERY, status: 'pending' })
    ).toHaveLength(1);
  });
});
