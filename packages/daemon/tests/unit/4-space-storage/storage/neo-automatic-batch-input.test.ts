import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestDb, createTestSession } from '../../../helpers/database';
import { createMailboxEntry } from '../../../../src/lib/mailbox/entry';
import { enqueueMailboxEntry } from '../../../../src/lib/mailbox/enqueue';
import { createMailboxDeliveryHandler } from '../../../../src/lib/mailbox/delivery';
import { boundDeliveryContent } from '../../../../src/lib/handoffs/bound-delivery';
import { NeoWakeQueueRepository } from '../../../../src/storage/repositories/neo-wake-queue-repository';
import { NeoSessionMessageRepository } from '../../../../src/storage/repositories/neo-session-message-repository';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';

const root = 'neo:10000000-0000-4000-8000-000000008762';
let db: Awaited<ReturnType<typeof createTestDb>>;
let queue: NeoWakeQueueRepository;
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession(root));
  new NeoRepository(db.getDatabase()).reserveBinding({
    sessionId: root,
    kind: 'neo',
    projectId: null,
  });
  queue = new NeoWakeQueueRepository(db.getDatabase());
});
afterEach(() => db.close());
const note = (text: string) =>
  createMailboxEntry({
    to: { kind: 'session', sessionId: root },
    origin: 'session:synthetic-worker',
    messageUuid: crypto.randomUUID(),
    message: { type: 'user', parent_tool_use_id: null, message: { content: text } },
  });

test('a structured wake delivers a public worker input before the unchanged event', async () => {
  queue.hold(note('Earlier worker note A'));
  queue.hold(note('Earlier worker note B'));
  const event = note('Decision needed');
  event.message.workerReportKind = 'blocked';
  enqueueMailboxEntry(db.getJobQueueRepo(), event);
  const [mail] = db.getJobQueueRepo().dequeue('mailbox');
  const deliver = createMailboxDeliveryHandler({
    db: db.getDatabase(),
    jobQueue: db.getJobQueueRepo(),
    sdkMessageRepo: db.getSDKMessageRepo(),
    getSession: async () => ({}),
    isSessionArchived: () => false,
    prepareEntry: async (entry, id) => queue.prepare(entry, id, true),
  });
  await deliver(mail);
  expect(
    db.getJobQueueRepo().listActiveByPayload('message_delivery', { sessionId: root })
  ).toHaveLength(2);
  const [first] = db.getJobQueueRepo().dequeueSessionFifo('message_delivery');
  expect(first.payload.messageUuid).not.toBe(event.messageUuid);
  const sdk = db.getSDKMessageRepo();
  const batch = sdk.getDeliveryContent(root, String(first.payload.messageUuid))!;
  expect(JSON.stringify(batch.content)).toContain('System-forwarded worker messages');
  expect(JSON.stringify(batch.content)).toContain('Earlier worker note A');
  expect(JSON.stringify(batch.content)).toContain('Earlier worker note B');
  expect(JSON.stringify(batch.content)).not.toContain('Decision needed');
  expect(sdk.getDeliveryContent(root, event.messageUuid!)!.content).toBe('Decision needed');
  await boundDeliveryContent(db.getDatabase(), first, batch);
  expect(new NeoSessionMessageRepository(db.getDatabase()).latest(root.slice(4), 10)).toEqual([
    expect.objectContaining({ text: expect.stringContaining('Earlier worker note A') }),
  ]);
  await deliver(db.getJobQueueRepo().getJob(mail.id)!);
  expect(
    db.getJobQueueRepo().listActiveByPayload('message_delivery', { sessionId: root })
  ).toHaveLength(2);
});

test('the fifteen-minute fallback delivers one visible batch without a placeholder turn', async () => {
  queue.hold(note('Timer worker note A'));
  queue.hold(note('Timer worker note B'));
  const oldest = db
    .getJobQueueRepo()
    .listActiveByPayload('neo_notes', { 'to.sessionId': root })[0].createdAt;
  queue.flushDue(oldest + 15 * 60_000 - 1);
  expect(
    db.getJobQueueRepo().listActiveByPayload('message_delivery', { sessionId: root })
  ).toHaveLength(0);
  new NeoWakeQueueRepository(db.getDatabase()).flushDue(oldest + 15 * 60_000);
  const jobs = db.getJobQueueRepo().listActiveByPayload('message_delivery', { sessionId: root });
  expect(jobs).toHaveLength(1);
  const batch = db
    .getSDKMessageRepo()
    .getDeliveryContent(root, String(jobs[0].payload.messageUuid))!;
  expect(JSON.stringify(batch.content)).toContain('System-forwarded worker messages');
  expect(JSON.stringify(batch.content)).toContain('Timer worker note A');
  expect(JSON.stringify(batch.content)).toContain('Timer worker note B');
  await boundDeliveryContent(db.getDatabase(), jobs[0], batch);
  expect(new NeoSessionMessageRepository(db.getDatabase()).latest(root.slice(4), 10)).toHaveLength(
    1
  );
  queue.flushDue(oldest + 30 * 60_000);
  expect(
    db.getJobQueueRepo().listActiveByPayload('message_delivery', { sessionId: root })
  ).toHaveLength(1);
  expect(
    db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': root })
  ).toHaveLength(0);
});
