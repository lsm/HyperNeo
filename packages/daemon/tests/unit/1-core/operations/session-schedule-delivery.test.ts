import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createScheduleDelivery } from '../../../../src/lib/scheduler/session-schedule-delivery';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules';
import { z } from 'zod';
import { createSessionScheduleFire } from '../../../../src/lib/scheduler/session-schedule-fire';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';
import { NeoInputOriginRepository } from '../../../../src/storage/repositories/neo-input-origin-repository';
import { createTestDb, createTestSession } from '../../../helpers/database';

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession('recipient'));
});
afterEach(() => db.close());

describe('createScheduleDelivery', () => {
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
    const trigger = new NeoInputOriginRepository(db.getDatabase()).trigger('recipient', messageId)!;
    expect(JSON.parse(trigger.slice('scheduled_wake:'.length))).toEqual({
      scheduleId: row.id,
      sourceKind: 'reminder',
      sourceId: 'release',
    });
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
  test('archival during source lookup completes without a mailbox delivery', async () => {
    const { scheduler, row, job } = create();
    scheduler.registerSource({
      kind: 'reminder',
      facts: async () => {
        db.updateSession('recipient', { status: 'archived' });
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
      dueCount: 1,
      factsDigest: null,
    });
  });
});
