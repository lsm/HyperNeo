import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { handleGitHubPoll } from '../../../../src/lib/job-handlers/github-poll.handler';
import { GITHUB_POLL } from '../../../../src/lib/job-queue-constants';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

describe('handleGitHubPoll', () => {
  let mailbox: MailboxTestDb;
  let triggerPollMock: ReturnType<typeof mock>;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
    triggerPollMock = mock(async () => {});
  });

  afterEach(() => mailbox.close());

  function makeDeps(overrides: { intervalMs?: number; missing?: boolean; running?: boolean } = {}) {
    return {
      pollingService: overrides.missing
        ? undefined
        : ({
            triggerPoll: triggerPollMock,
            isRunning: () => overrides.running ?? true,
          } as never),
      jobQueue: mailbox.jobQueue,
      intervalMs: overrides.intervalMs ?? 60_000,
    };
  }

  const pending = () => mailbox.jobQueue.listJobs({ queue: GITHUB_POLL, status: 'pending' });

  it('calls triggerPoll and returns its successful result with a durable due time', async () => {
    const before = Date.now();
    const result = await handleGitHubPoll(makeDeps());
    expect(triggerPollMock).toHaveBeenCalledTimes(1);
    expect(result.polled).toBe(true);
    expect(result.nextRunAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(pending()).toHaveLength(1);
    expect(pending()[0].runAt).toBe(result.nextRunAt);
    expect(pending()[0].payload).toEqual({});
    expect(pending()[0].retryCount).toBe(0);
  });

  it('retains an existing pending successor and its due time', async () => {
    const existing = mailbox.jobQueue.enqueue({ queue: GITHUB_POLL, payload: {}, runAt: 123 });
    await handleGitHubPoll(makeDeps());
    expect(pending()).toHaveLength(1);
    expect(pending()[0].id).toBe(existing.id);
    expect(pending()[0].runAt).toBe(123);
  });

  it('self-schedules while the current poll is processing', async () => {
    const current = mailbox.jobQueue.enqueue({ queue: GITHUB_POLL, payload: {} });
    mailbox.jobQueue.dequeue(GITHUB_POLL);
    await handleGitHubPoll(makeDeps());
    expect(mailbox.jobQueue.getJob(current.id)?.status).toBe('processing');
    expect(pending()).toHaveLength(1);
    expect(pending()[0].id).not.toBe(current.id);
  });

  it('deduplicates concurrent successor requests', async () => {
    await Promise.all([handleGitHubPoll(makeDeps()), handleGitHubPoll(makeDeps())]);
    expect(triggerPollMock).toHaveBeenCalledTimes(2);
    expect(pending()).toHaveLength(1);
  });

  it('still schedules the next poll when triggerPoll throws', async () => {
    triggerPollMock = mock(async () => {
      throw new Error('poll failed');
    });
    expect((await handleGitHubPoll(makeDeps())).polled).toBe(false);
    expect(pending()).toHaveLength(1);
  });

  for (const overrides of [{ missing: true }, { running: false }]) {
    it(`skips polling but retains successor scheduling for ${JSON.stringify(overrides)}`, async () => {
      expect((await handleGitHubPoll(makeDeps(overrides))).polled).toBe(false);
      expect(triggerPollMock).not.toHaveBeenCalled();
      expect(pending()).toHaveLength(1);
    });
  }

  it('evaluates an interval callback after polling and keeps it outside transactions', async () => {
    let interval = 60_000;
    triggerPollMock = mock(async () => {
      interval = 10_000;
    });
    const deps = makeDeps();
    const before = Date.now();
    const result = await handleGitHubPoll({
      ...deps,
      intervalMs: () => {
        mailbox.db.exec('BEGIN');
        mailbox.db.exec('ROLLBACK');
        return interval;
      },
    });
    expect(result.nextRunAt).toBeGreaterThanOrEqual(before + 10_000);
    expect(result.nextRunAt).toBeLessThan(before + 60_000);
    expect(pending()[0].runAt).toBe(result.nextRunAt);
  });

  it('does not request a writer when its interval is disabled', async () => {
    bindGateway(mailbox.db, {
      call: async () => {
        throw new Error('unexpected writer');
      },
    } as unknown as DbGateway);
    expect(await handleGitHubPoll(makeDeps({ intervalMs: 0 }))).toEqual({
      polled: true,
      nextRunAt: 0,
    });
    expect(pending()).toEqual([]);
  });

  it('waits for admission to commit before resolving the poll result', async () => {
    const inline = new DbGateway(':memory:', mailbox.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    bindGateway(mailbox.db, {
      call: async (...args) => {
        entered();
        await gate;
        return Reflect.apply(inline.call, inline, args);
      },
    } as DbGateway);
    let settled = false;
    const result = handleGitHubPoll(makeDeps()).then((value) => {
      settled = true;
      return value;
    });
    await requested;
    try {
      expect(settled).toBe(false);
      expect(pending()).toEqual([]);
    } finally {
      release();
    }
    const receipt = await result;
    expect(pending()[0].runAt).toBe(receipt.nextRunAt);
    expect(pending()).toHaveLength(1);
    expect(settled).toBe(true);
  });

  it('rejects an unavailable writer without main-connection replay', async () => {
    bindGateway(mailbox.db, {
      call: async () => {
        throw new Error('writer unavailable');
      },
    } as unknown as DbGateway);
    await expect(handleGitHubPoll(makeDeps())).rejects.toThrow('writer unavailable');
    expect(pending()).toEqual([]);
  });

  it('rolls back insertion when the writer cannot load its receipt', async () => {
    const getJob = spyOn(JobQueueRepository.prototype, 'getJob').mockImplementation(() => {
      throw new Error('receipt unavailable');
    });
    try {
      await expect(handleGitHubPoll(makeDeps())).rejects.toThrow('receipt unavailable');
      expect(pending()).toEqual([]);
    } finally {
      getJob.mockRestore();
    }
  });
});
