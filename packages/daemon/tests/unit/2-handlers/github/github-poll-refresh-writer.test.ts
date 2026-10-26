import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { GitHubService } from '../../../../src/lib/github/github-service';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

describe('GitHubService refresh writer', () => {
  let fixture: MailboxTestDb;
  let service: GitHubService;
  let inline: DbGateway;
  let interval: number;
  const pending = () => fixture.jobQueue.listJobs({ queue: 'github.poll', status: 'pending' });

  beforeEach(() => {
    fixture = createMailboxTestDb();
    inline = new DbGateway(':memory:', fixture.db);
    bindGateway(fixture.db, inline);
    interval = 60;
    service = new GitHubService({
      db: { getDatabase: () => fixture.db } as ConstructorParameters<typeof GitHubService>[0]['db'],
      internalEventBus: {} as ConstructorParameters<typeof GitHubService>[0]['internalEventBus'],
      config: {} as ConstructorParameters<typeof GitHubService>[0]['config'],
      apiKey: '',
      githubToken: 'synthetic-transport-only',
      jobQueue: fixture.jobQueue,
      jobProcessor: { register: () => {} } as ConstructorParameters<
        typeof GitHubService
      >[0]['jobProcessor'],
      getPollingIntervalSeconds: () => interval,
    });
  });
  afterEach(() => {
    service.stop();
    fixture.close();
  });

  test('concurrent starts and refreshes retain one initial job and its due time', async () => {
    const before = Date.now();
    await Promise.all([service.start(), service.start(), service.refreshPolling()]);
    const original = pending();
    expect(original).toHaveLength(1);
    expect(original[0].payload).toEqual({});
    expect(original[0].maxRetries).toBe(3);
    expect(original[0].runAt).toBeGreaterThanOrEqual(before);
    expect(original[0].runAt).toBeLessThanOrEqual(Date.now());
    await service.refreshPolling();
    expect(pending()).toEqual(original);
  });

  test('rescheduling replaces pending jobs while retaining completed and foreign jobs', async () => {
    await service.start();
    const original = pending()[0];
    const foreign = fixture.jobQueue.enqueue({ queue: 'other', payload: {} });
    fixture.jobQueue.enqueue({ queue: 'github.poll', payload: {}, runAt: 0 });
    const claim = fixture.jobQueue.dequeue('github.poll')[0];
    const completed = fixture.jobQueue.complete(claim.id, { polled: true }, claim.claimToken);
    await service.refreshPolling({ reschedulePending: true });
    expect(pending()).toHaveLength(1);
    expect(pending()[0].id).not.toBe(original.id);
    expect(fixture.jobQueue.getJob(original.id)).toBeNull();
    expect(fixture.jobQueue.getJob(foreign.id)).toEqual(foreign);
    expect(fixture.jobQueue.getJob(claim.id)).toEqual(completed);
  });

  test('disable and re-enable preserve a processing lease without admitting a duplicate', async () => {
    await service.start();
    const processing = fixture.jobQueue.dequeue('github.poll')[0];
    fixture.jobQueue.enqueue({ queue: 'github.poll', payload: {} });
    interval = 0;
    await service.refreshPolling();
    expect(pending()).toEqual([]);
    expect(service.isPolling()).toBe(false);
    expect(fixture.jobQueue.getJob(processing.id)).toEqual(processing);
    interval = 60;
    await service.refreshPolling({ reschedulePending: true });
    expect(pending()).toEqual([]);
    expect(service.isPolling()).toBe(true);
    expect(fixture.jobQueue.getJob(processing.id)).toEqual(processing);
  });

  test('retains the legacy hundred-row pending deletion bound', async () => {
    await service.start();
    for (let i = 0; i < 100; i++) fixture.jobQueue.enqueue({ queue: 'github.poll', payload: {} });
    interval = 0;
    await service.refreshPolling();
    expect(fixture.jobQueue.countByStatus('github.poll').pending).toBe(1);
  });

  test('start waits for the initial writer receipt', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    const result = service.start().then(() => {
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
    expect(pending()).toHaveLength(1);
  });

  test('a pending deletion failure restores jobs already deleted in the same refresh', async () => {
    await service.start();
    const original = pending()[0];
    fixture.jobQueue.enqueue({
      queue: 'github.poll',
      payload: {},
      createdAt: original.createdAt + 1,
    });
    const before = pending();
    fixture.db.exec(
      `CREATE TRIGGER reject_delete BEFORE DELETE ON job_queue WHEN OLD.id = '${original.id}' BEGIN SELECT RAISE(ABORT, 'deletion rejected'); END`
    );
    interval = 0;
    await expect(service.refreshPolling()).rejects.toThrow('deletion rejected');
    expect(pending()).toEqual(before);
    expect(service.isPolling()).toBe(true);
  });

  test('waits for the disabled receipt before stopping the runtime', async () => {
    await service.start();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    interval = 0;
    const result = service.refreshPolling();
    await requested;
    try {
      expect(service.isPolling()).toBe(true);
      expect(pending()).toHaveLength(1);
    } finally {
      release();
    }
    await result;
    expect(service.isPolling()).toBe(false);
    expect(pending()).toEqual([]);
  });

  test('a delayed disabled receipt cannot stop a newer enabled runtime', async () => {
    await service.start();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    bindGateway(fixture.db, {
      call: async (...args) => {
        const receipt = await Reflect.apply(inline.call, inline, args);
        if (!(args[2] as { enabled: boolean }).enabled) {
          entered();
          await gate;
        }
        return receipt;
      },
    } as DbGateway);
    interval = 0;
    const disabled = service.refreshPolling();
    await committed;
    try {
      interval = 60;
      await service.refreshPolling();
    } finally {
      release();
    }
    await disabled;
    expect(service.isPolling()).toBe(true);
    expect(pending()).toHaveLength(1);
  });

  test('unavailable writers leave pending jobs and runtime unchanged without main replay', async () => {
    await service.start();
    const original = pending();
    bindGateway(fixture.db, {
      call: async () => {
        throw new Error('writer unavailable');
      },
    } as unknown as DbGateway);
    interval = 0;
    await expect(service.refreshPolling()).rejects.toThrow('writer unavailable');
    expect(pending()).toEqual(original);
    expect(service.isPolling()).toBe(true);
  });

  for (const failure of ['insert', 'receipt']) {
    test(`replacement ${failure} failure rolls back deletion and admission together`, async () => {
      await service.start();
      const original = pending();
      if (failure === 'insert')
        fixture.db.exec(
          "CREATE TRIGGER reject_poll BEFORE INSERT ON job_queue BEGIN SELECT RAISE(ABORT, 'insertion rejected'); END"
        );
      const getJob =
        failure === 'receipt'
          ? spyOn(JobQueueRepository.prototype, 'getJob').mockImplementation(() => {
              throw new Error('receipt unavailable');
            })
          : undefined;
      try {
        await expect(service.refreshPolling({ reschedulePending: true })).rejects.toThrow();
        expect(pending()).toEqual(original);
      } finally {
        getJob?.mockRestore();
      }
    });
  }

  test('a lost committed receipt retains one replacement without main replay', async () => {
    await service.start();
    const original = pending()[0];
    bindGateway(fixture.db, {
      call: async (...args) => {
        await Reflect.apply(inline.call, inline, args);
        throw new Error('receipt lost');
      },
    } as DbGateway);
    await expect(service.refreshPolling({ reschedulePending: true })).rejects.toThrow(
      'receipt lost'
    );
    expect(pending()).toHaveLength(1);
    expect(pending()[0].id).not.toBe(original.id);
    const replacement = pending();
    bindGateway(fixture.db, inline);
    await service.refreshPolling();
    expect(pending()).toEqual(replacement);
  });
});
