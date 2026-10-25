import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';
import { NeoWakeQueueRepository } from '../../../../src/storage/repositories/neo-wake-queue-repository.ts';
import { createMailboxEntry, type MailboxMessage } from '../../../../src/lib/mailbox/entry.ts';
import { enqueueMailboxEntry } from '../../../../src/lib/mailbox/enqueue.ts';
import { createMailboxDeliveryHandler } from '../../../../src/lib/mailbox/delivery.ts';

describe('Neo queued worker reports', () => {
  let mailbox: MailboxTestDb;
  let queue: NeoWakeQueueRepository;
  const root = 'neo:root';
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    mailbox.db
      .prepare("INSERT INTO neo_session_bindings(session_id, kind) VALUES (?, 'neo')")
      .run(root);
    queue = new NeoWakeQueueRepository(mailbox.db);
  });
  afterEach(() => mailbox.close());
  const entry = (text: string, kind?: MailboxMessage['workerReportKind']) =>
    createMailboxEntry({
      to: { kind: 'session', sessionId: root },
      origin: 'session:worker',
      messageUuid: text,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        workerReportKind: kind,
        message: { content: text },
      },
    });
  const options = () => ({
    sdkMessageRepo: mailbox.sdkMessageRepo,
    jobQueue: mailbox.jobQueue,
    hold: 'immediate' as const,
  });
  const handler = (wake: boolean) =>
    createMailboxDeliveryHandler({
      jobQueue: mailbox.jobQueue,
      db: mailbox.db,
      sdkMessageRepo: mailbox.sdkMessageRepo,
      getSession: async () => ({}),
      isSessionArchived: () => false,
      prepareEntry: async (value, id) => queue.prepare(value, id, wake, options()),
    });

  test('a blocked delivery contains all earlier messages in order and retries the same batch', async () => {
    for (let i = 0; i < 20; i++)
      enqueueMailboxEntry(mailbox.jobQueue, entry(`chatty-${String(i).padStart(2, '0')}`));
    enqueueMailboxEntry(mailbox.jobQueue, entry('Decision needed', 'blocked'));
    const jobs = mailbox.jobQueue.dequeue('mailbox', 21);
    const report = jobs.at(-1)!;
    await handler(true)(report);
    expect(mailbox.sdkRows()).toHaveLength(2);
    const body = JSON.stringify(JSON.parse(mailbox.sdkRows()[0].sdk_message).message.content);
    let previous = -1;
    for (let i = 0; i < 20; i++) {
      const position = body.indexOf(`chatty-${String(i).padStart(2, '0')}`);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(body).not.toContain('Decision needed');
    expect(JSON.parse(mailbox.sdkRows()[1].sdk_message).message.content).toBe('Decision needed');
    await handler(true)(mailbox.jobQueue.getJob(report.id)!);
    expect(mailbox.sdkRows()).toHaveLength(2);
    for (const job of jobs.slice(0, -1)) await handler(false)(job);
    expect(mailbox.sdkRows()).toHaveLength(2);
  });

  test('a persisted queue releases one batch at fifteen minutes without another event', async () => {
    for (const text of ['first', 'second', 'third']) queue.hold(entry(text));
    const oldest = mailbox.jobQueue.listActiveByPayload('neo_notes', { 'to.sessionId': root })[0]
      .createdAt;
    new NeoWakeQueueRepository(mailbox.db).flushDue(oldest + 15 * 60_000 - 1, options());
    expect(mailbox.jobQueue.dequeue('mailbox', 10)).toHaveLength(0);
    new NeoWakeQueueRepository(mailbox.db).flushDue(Date.now() + 15 * 60_000, options());
    expect(mailbox.jobQueue.dequeue('mailbox', 10)).toHaveLength(0);
    expect(
      mailbox.jobQueue.listActiveByPayload('message_delivery', { sessionId: root })
    ).toHaveLength(1);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.sdkRows()[0].sdk_message).toContain('first');
    expect(mailbox.sdkRows()[0].sdk_message).toContain('second');
    expect(mailbox.sdkRows()[0].sdk_message).toContain('third');
    queue.flushDue(Date.now() + 30 * 60_000, options());
    expect(mailbox.jobQueue.dequeue('mailbox', 10)).toHaveLength(0);
  });

  test('an identical report retried after carrying a batch retains its original content', async () => {
    queue.hold(entry('queued note'));
    enqueueMailboxEntry(mailbox.jobQueue, entry('report original', 'blocked'));
    await handler(true)(mailbox.jobQueue.dequeue('mailbox')[0]);
    expect(JSON.parse(mailbox.sdkRows()[1].sdk_message).message.content).toBe('report original');
    enqueueMailboxEntry(mailbox.jobQueue, entry('report original', 'blocked'));
    await handler(true)(mailbox.jobQueue.dequeue('mailbox')[0]);
    expect(mailbox.sdkRows()).toHaveLength(2);
    expect(
      mailbox.jobQueue.listActiveByPayload('message_delivery', { sessionId: root })
    ).toHaveLength(2);
  });
  test('a queued retry cannot silently replace different content under the same message id', () => {
    const first = entry('first queued content');
    queue.hold(first);
    expect(() =>
      queue.hold({
        ...first,
        message: { ...first.message, message: { content: 'changed queued content' } },
      })
    ).toThrow('different content');
  });

  test('an already attached legacy batch keeps its complete delivery on replay', async () => {
    const legacy = entry('legacy event', 'blocked');
    legacy.message.neoBatchContent = [
      { type: 'text', text: 'legacy worker note' },
      { type: 'text', text: 'legacy event' },
    ];
    enqueueMailboxEntry(mailbox.jobQueue, Object.assign(legacy, { neoBatchAttached: true }));
    const [job] = mailbox.jobQueue.dequeue('mailbox');
    await handler(true)(job);
    await handler(true)(mailbox.jobQueue.getJob(job.id)!);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.sdkMessageRepo.getDeliveryContent(root, 'legacy event')!.content).toEqual(
      legacy.message.neoBatchContent
    );
    expect(
      mailbox.jobQueue.listActiveByPayload('message_delivery', { sessionId: root })
    ).toHaveLength(1);
  });

  test('a timed batch does not copy an already admitted processing message', async () => {
    enqueueMailboxEntry(mailbox.jobQueue, entry('already admitted'));
    const [processing] = mailbox.jobQueue.dequeue('mailbox');
    await handler(true)(processing);
    queue.hold(entry('later queued note'));
    queue.flushDue(Date.now() + 15 * 60_000, options());
    expect(mailbox.jobQueue.dequeue('mailbox')).toHaveLength(0);
    const messages = mailbox.sdkRows().map((row) => JSON.parse(row.sdk_message));
    expect(messages).toHaveLength(2);
    expect(messages[0].message.content).toBe('already admitted');
    expect(JSON.stringify(messages[1])).toContain('later queued note');
    expect(JSON.stringify(messages[1])).not.toContain('already admitted');
    expect(mailbox.jobQueue.isClaimCurrent(processing.id, processing.claimToken)).toBe(true);
  });

  test('session cancellation includes parked notes and prevents a later timed batch', () => {
    queue.hold(entry('cancelled report'));
    const cancelled = mailbox.jobQueue.cancelMailboxForSession(root);
    expect(cancelled.map((row) => JSON.parse(row.payload).messageUuid)).toEqual([
      'cancelled report',
    ]);
    queue.flushDue(Date.now() + 15 * 60_000, options());
    expect(mailbox.jobQueue.dequeue('mailbox')).toHaveLength(0);
  });
});
