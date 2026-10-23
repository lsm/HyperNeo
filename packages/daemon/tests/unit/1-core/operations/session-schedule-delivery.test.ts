import { hyperneoWorkStatus } from '../../../../src/lib/drivers/hyperneo-adapter';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createScheduleDelivery } from '../../../../src/lib/scheduler/session-schedule-delivery';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules';
import { z } from 'zod';
import { createSessionScheduleFire } from '../../../../src/lib/scheduler/session-schedule-fire';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';
import { createTestDb, createTestSession } from '../../../helpers/database';

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession('recipient'));
});
afterEach(() => db.close());

describe('createScheduleDelivery', () => {
  test('root Neo is an available schedule target even though work discovery excludes it', async () => {
    await db.createSession(createTestSession('neo:root'));
    const delivery = createScheduleDelivery(db, () => createOperationRegistry([]));
    expect(await delivery.status({ adapter: 'hyperneo', id: 'neo:root' })).toBe('done');
    db.getDatabase()
      .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
      .run(JSON.stringify({ status: 'processing' }), 'neo:root');
    expect(await delivery.status({ adapter: 'hyperneo', id: 'neo:root' })).toBe('running');
    await db.updateSession('neo:root', { status: 'archived' });
    expect(await delivery.status({ adapter: 'hyperneo', id: 'neo:root' })).toBe('not_open');
  });
  test('concurrent retries enqueue one daemon note with verifiable wake metadata', async () => {
    const scheduler = new SessionScheduler(db.getDatabase(), db.getJobQueueRepo());
    const row = scheduler.create({
      target: { adapter: 'hyperneo', id: 'recipient' },
      sourceKind: 'reminder',
      sourceId: 'release',
      note: 'Check release',
      nudgeEvery: 1,
      cadence: { kind: 'every', everyMs: 60000 },
      createdBySession: null,
    });
    const delivery = createScheduleDelivery(db, () => createOperationRegistry([]));
    const messageId = `schedule:${row.id}:${row.nextRunAt}`;
    await Promise.all([
      delivery.deliver(row, messageId, 'Check release'),
      delivery.deliver(row, messageId, 'Check release'),
    ]);
    const messages = db
      .getJobQueueRepo()
      .listActiveByPayload('mailbox', { 'to.sessionId': 'recipient', messageUuid: messageId });
    expect(messages).toHaveLength(1);
    expect(messages[0].payload).toMatchObject({
      origin: expect.stringContaining('scheduled_wake:'),
      message: {
        inputKind: 'system',
        message: { content: '<daemon-note kind="scheduled_wake">\nCheck release\n</daemon-note>' },
      },
    });
    const wake = db
      .getDatabase()
      .prepare(
        'SELECT metadata_json AS metadata FROM session_schedule_wakes WHERE session_id = ? AND message_id = ?'
      )
      .get('recipient', messageId) as { metadata: string };
    expect(JSON.parse(wake.metadata)).toEqual({
      scheduleId: row.id,
      sourceKind: 'reminder',
      sourceId: 'release',
    });
  });
});

describe('Neo schedule target lifecycle', () => {
  const target = { adapter: 'hyperneo', id: 'neo:root' };
  const create = () => {
    const scheduler = new SessionScheduler(db.getDatabase(), db.getJobQueueRepo());
    const row = scheduler.create(
      {
        target,
        sourceKind: 'reminder',
        sourceId: 'neo-check',
        note: 'Check the goal',
        nudgeEvery: 1,
        cadence: { kind: 'every', everyMs: 60000 },
        createdBySession: null,
      },
      Date.now() - 60000
    );
    const delivery = createScheduleDelivery(db, () => createOperationRegistry([]));
    const handler = createSessionScheduleFire({ scheduler, ...delivery });
    const mail = () =>
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': target.id });
    return { scheduler, row, delivery, handler, mail };
  };

  test.each(['{', 'null', '{"status":7}'])(
    'unreadable processing state %s does not strand an open Neo wake',
    async (processingState) => {
      await db.createSession(createTestSession(target.id));
      db.getDatabase()
        .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
        .run(processingState, target.id);
      const { scheduler, row, delivery, handler, mail } = create();
      expect(await delivery.status(target)).toBe('done');
      expect(await handler(db.getJobQueueRepo().getJob(row.pendingJobId!)!)).toEqual({
        outcome: 'fired',
      });
      expect(scheduler.repo.get(row.id)).toMatchObject({
        status: 'active',
        lastOutcome: 'fired',
        pendingJobId: expect.any(String),
      });
      expect(mail()).toHaveLength(1);
    }
  );

  test.each([
    ['missing', 'not_found'],
    ['ended', 'not_open'],
    ['archived', 'not_open'],
  ] as const)('%s Neo finishes target_gone instead of skipping busy', async (status, expected) => {
    if (status !== 'missing') await db.createSession({ ...createTestSession(target.id), status });
    const { scheduler, row, delivery, handler, mail } = create();
    expect(await delivery.status(target)).toBe(expected);
    await handler(db.getJobQueueRepo().getJob(row.pendingJobId!)!);
    expect(scheduler.repo.get(row.id)).toMatchObject({
      status: 'done',
      lastOutcome: 'target_gone',
      pendingJobId: null,
      nextRunAt: null,
      lastMessageId: null,
    });
    expect(mail()).toEqual([]);
  });

  test('open interrupted Neo remains active and can fire after returning to idle', async () => {
    await db.createSession(createTestSession(target.id));
    const state = (status: string) =>
      db
        .getDatabase()
        .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
        .run(JSON.stringify({ status, reason: 'user' }), target.id);
    state('interrupted');
    const { scheduler, row, delivery, handler, mail } = create();
    expect(await delivery.status(target)).toBe('stopped');
    await handler(db.getJobQueueRepo().getJob(row.pendingJobId!)!);
    const next = scheduler.repo.get(row.id)!;
    expect(next).toMatchObject({
      status: 'active',
      lastOutcome: 'skipped_busy',
      dueCount: 0,
      pendingJobId: expect.any(String),
    });
    expect(mail()).toEqual([]);
    state('idle');
    expect(await delivery.status(target)).toBe('done');
    const clock = spyOn(Date, 'now').mockReturnValue(next.nextRunAt!);
    try {
      await handler(db.getJobQueueRepo().getJob(next.pendingJobId!)!);
      expect(scheduler.repo.get(row.id)).toMatchObject({
        status: 'active',
        lastOutcome: 'fired',
        dueCount: 0,
      });
      expect(mail()).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  test('Neo closed after the status check is rejected at delivery time', async () => {
    await db.createSession(createTestSession(target.id));
    const { scheduler, row, handler, mail } = create();
    scheduler.registerSource({
      kind: 'reminder',
      facts: async () => {
        await db.updateSession(target.id, { status: 'ended' });
        return { digest: 'changed', summary: 'Check the goal' };
      },
      message: (_id, change) => change.summary,
    });
    await handler(db.getJobQueueRepo().getJob(row.pendingJobId!)!);
    expect(scheduler.repo.get(row.id)).toMatchObject({
      status: 'done',
      lastOutcome: 'target_gone',
      lastMessageId: null,
    });
    expect(mail()).toEqual([]);
  });
});

describe('schedule target lifecycle and external delivery', () => {
  const create = (adapter = 'hyperneo') => {
    const scheduler = new SessionScheduler(db.getDatabase(), db.getJobQueueRepo());
    const row = scheduler.create(
      {
        target: { adapter, id: 'recipient' },
        sourceKind: 'reminder',
        sourceId: 'release',
        note: 'Check release',
        nudgeEvery: 1,
        cadence: { kind: 'every', everyMs: 60000 },
        createdBySession: null,
      },
      Date.now() - 60000
    );
    return { scheduler, row, job: db.getJobQueueRepo().getJob(row.pendingJobId!)! };
  };
  test.each(['not_found', 'not_open', 'stopped'] as const)(
    '%s completes the schedule instead of retrying or reporting fired',
    async (reason) => {
      const { scheduler, row, job } = create();
      if (reason === 'stopped') await db.updateSession('recipient', { status: 'archived' });
      const registry = createOperationRegistry([
        defineOperation({
          name: 'work.status',
          description: 'Test target status',
          inputSchema: z.unknown(),
          resultSchema: z.unknown(),
          execute: async () =>
            reason === 'stopped'
              ? { ok: true, value: { status: reason } }
              : { ok: false, reason, detail: 'Target closed' },
        }),
      ]);
      await createSessionScheduleFire({ scheduler, ...createScheduleDelivery(db, () => registry) })(
        job
      );
      expect(scheduler.repo.get(row.id)).toMatchObject({
        status: 'done',
        lastOutcome: 'target_gone',
        pendingJobId: null,
      });
      expect(
        db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': row.target.id })
      ).toEqual([]);
    }
  );
  test('an interrupted open session skips one due run and can fire when idle again', async () => {
    const { scheduler, row, job } = create();
    const setState = (status: string) =>
      db
        .getDatabase()
        .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
        .run(JSON.stringify({ status, reason: 'user' }), 'recipient');
    setState('interrupted');
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.status',
        description: 'Real HyperNeo status projection',
        inputSchema: z.unknown(),
        resultSchema: z.unknown(),
        execute: async () => {
          const session = db.getSession('recipient')!;
          return {
            ok: true,
            value: {
              status: hyperneoWorkStatus(
                session.status,
                JSON.parse(session.processingState ?? '{}').status ?? null
              ),
            },
          };
        },
      }),
    ]);
    const handler = createSessionScheduleFire({
      scheduler,
      ...createScheduleDelivery(db, () => registry),
    });
    await handler(job);
    const next = scheduler.repo.get(row.id)!;
    expect(next).toMatchObject({ status: 'active', lastOutcome: 'skipped_busy', dueCount: 0 });
    expect(next.nextRunAt).toBeGreaterThan(Date.now());
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': row.target.id })
    ).toEqual([]);
    setState('idle');
    const clock = spyOn(Date, 'now').mockReturnValue(next.nextRunAt!);
    try {
      await handler(db.getJobQueueRepo().getJob(next.pendingJobId!)!);
      expect(scheduler.repo.get(row.id)).toMatchObject({
        status: 'active',
        lastOutcome: 'fired',
        dueCount: 0,
      });
      expect(
        db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': row.target.id })
      ).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
  test('archival during source lookup completes without a mailbox delivery', async () => {
    const { scheduler, row, job } = create();
    scheduler.registerSource({
      kind: 'reminder',
      facts: async () => {
        await db.updateSession('recipient', { status: 'archived' });
        return { digest: 'reminder', summary: 'Check release' };
      },
      message: (_id, change) => change.summary,
    });
    const delivery = createScheduleDelivery(db, () => createOperationRegistry([]));
    await createSessionScheduleFire({
      scheduler,
      status: async () => 'done',
      deliver: delivery.deliver,
    })(job);
    expect(scheduler.repo.get(row.id)).toMatchObject({
      status: 'done',
      lastOutcome: 'target_gone',
    });
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': row.target.id })
    ).toEqual([]);
  });
  test('a retry after an external send cannot deliver the same occurrence again or claim it fired', async () => {
    const { scheduler, row, job } = create('external');
    const received: string[] = [];
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.send',
        description: 'Test external inbox',
        inputSchema: z.object({ message: z.string() }),
        resultSchema: z.unknown(),
        execute: async (input) => {
          received.push(input.message);
          return { ok: true, value: { delivered: true } };
        },
      }),
    ]);
    const messageId = `schedule:${row.id}:${row.nextRunAt}`;
    await createScheduleDelivery(db, () => registry).deliver(row, messageId, 'Check release');
    const restarted = createScheduleDelivery(db, () => registry);
    await createSessionScheduleFire({
      scheduler,
      status: async () => 'done',
      deliver: restarted.deliver,
    })(job);
    expect(received).toHaveLength(1);
    expect(scheduler.repo.get(row.id)).toMatchObject({
      lastOutcome: 'skipped_delivery_unconfirmed',
      lastMessageId: messageId,
      dueCount: 0,
      factsDigest: null,
    });
  });
});
