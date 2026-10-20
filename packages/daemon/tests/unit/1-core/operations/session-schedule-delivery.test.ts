import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createScheduleDelivery } from '../../../../src/lib/scheduler/session-schedule-delivery';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
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
