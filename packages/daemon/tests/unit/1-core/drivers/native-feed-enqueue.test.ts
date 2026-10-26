import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { scheduleClaudeFeed, WORK_FEED_CLAUDE } from '../../../../src/lib/drivers/claude-feed';
import { scheduleCodexFeed, WORK_FEED_CODEX } from '../../../../src/lib/drivers/codex-feed';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

for (const feed of [
  { scope: 'claude', queue: WORK_FEED_CLAUDE, schedule: scheduleClaudeFeed },
  { scope: 'codex', queue: WORK_FEED_CODEX, schedule: scheduleCodexFeed },
]) {
  describe(`${feed.scope} native-feed admission`, () => {
    let fixture: MailboxTestDb;
    beforeEach(() => {
      fixture = createMailboxTestDb();
    });
    afterEach(() => fixture.close());

    const pending = () => fixture.jobQueue.listJobs({ queue: feed.queue, status: 'pending' });

    test('retains the scope, retry budget and one-minute due time', async () => {
      const before = Date.now();
      await feed.schedule(fixture.jobQueue);
      const jobs = pending();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toEqual({ scope: feed.scope });
      expect(jobs[0].runAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(jobs[0].runAt).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(jobs[0].maxRetries).toBe(3);
      expect(jobs[0].retryCount).toBe(0);
    });

    test('retains one pending successor unchanged across concurrent retries', async () => {
      await feed.schedule(fixture.jobQueue);
      const original = pending();
      await Promise.all([feed.schedule(fixture.jobQueue), feed.schedule(fixture.jobQueue)]);
      expect(pending()).toEqual(original);
    });

    test('admits a pending successor while its matching predecessor is processing', async () => {
      const predecessor = fixture.jobQueue.enqueue({
        queue: feed.queue,
        payload: { scope: feed.scope },
      });
      fixture.jobQueue.dequeue(feed.queue);
      await feed.schedule(fixture.jobQueue);
      expect(fixture.jobQueue.getJob(predecessor.id)?.status).toBe('processing');
      expect(pending()).toHaveLength(1);
      expect(pending()[0].id).not.toBe(predecessor.id);
    });

    test('does not deduplicate another scope in the same queue', async () => {
      fixture.jobQueue.enqueue({ queue: feed.queue, payload: { scope: 'different-scope' } });
      await feed.schedule(fixture.jobQueue);
      expect(pending()).toHaveLength(2);
      expect(pending().filter((job) => job.payload.scope === feed.scope)).toHaveLength(1);
    });

    test('waits for its writer receipt before resolving admission', async () => {
      const inline = new DbGateway(':memory:', fixture.db);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const requested = new Promise<void>((resolve) => {
        entered = resolve;
      });
      bindGateway(fixture.db, {
        call: async (...args) => {
          entered();
          await gate;
          return Reflect.apply(inline.call, inline, args);
        },
      } as DbGateway);
      let settled = false;
      const result = feed.schedule(fixture.jobQueue).then(() => {
        settled = true;
      });
      await requested;
      try {
        expect(settled).toBe(false);
        expect(pending()).toEqual([]);
      } finally {
        release();
      }
      await result;
      expect(settled).toBe(true);
      expect(pending()).toHaveLength(1);
    });

    test('does not replay admission on main when its writer is unavailable', async () => {
      bindGateway(fixture.db, {
        call: async () => {
          throw new Error('writer unavailable');
        },
      } as unknown as DbGateway);
      await expect(feed.schedule(fixture.jobQueue)).rejects.toThrow('writer unavailable');
      expect(pending()).toEqual([]);
    });

    test('rolls back insertion when receipt loading fails', async () => {
      const getJob = spyOn(JobQueueRepository.prototype, 'getJob').mockImplementation(() => {
        throw new Error('receipt unavailable');
      });
      try {
        await expect(feed.schedule(fixture.jobQueue)).rejects.toThrow('receipt unavailable');
        expect(pending()).toEqual([]);
      } finally {
        getJob.mockRestore();
      }
    });
  });
}
