import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';
import {
  NEO_DRIVER_REFRESH,
  refreshNeoDriverWork,
  scheduleDriverRefresh,
} from '../../../../src/lib/neo/driver-refresh.ts';
import type { NeoService } from '../../../../src/lib/neo/service.ts';

describe('refreshNeoDriverWork', () => {
  let mailbox: MailboxTestDb;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });
  afterEach(() => mailbox.close());

  test('keeps one next run scheduled and refreshes even when a refresh fails', async () => {
    const before = Date.now();
    scheduleDriverRefresh(mailbox.jobQueue);
    scheduleDriverRefresh(mailbox.jobQueue);
    expect(mailbox.rowCount()).toBe(1);
    expect(mailbox.rows()[0].run_at).toBeGreaterThanOrEqual(before + 60_000);
    mailbox.db.prepare('UPDATE job_queue SET run_at = 0').run();
    mailbox.jobQueue.dequeue(NEO_DRIVER_REFRESH);
    let calls = 0;
    const service = {
      refreshDriverWork: async () => {
        calls++;
        expect(
          mailbox.jobQueue.listJobs({ queue: NEO_DRIVER_REFRESH, status: 'pending' })
        ).toHaveLength(1);
        throw new Error('laptop asleep');
      },
    } as unknown as NeoService;
    await expect(refreshNeoDriverWork(mailbox.jobQueue, service)).rejects.toThrow('laptop asleep');
    expect(calls).toBe(1);
  });
});
