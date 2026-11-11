import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createNeoService } from '../../helpers/neo-service.ts';
import { createNeoFrontHandler } from '../../../../src/lib/neo/front-job.ts';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database.ts';
import { neoIntakeMessage } from '../../../../src/lib/neo/intake.ts';
import { NEO_FRONT_INFERENCE } from '../../../../src/lib/job-queue-constants.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
const conversationId = '10000000-0000-4000-8000-000000000001';
const sessionId = `neo:${conversationId}`;
const requestId = '20000000-0000-4000-8000-000000000001';
const model = { model: 'front-fixture', provider: 'glm', thinkingLevel: 'off' as const };
const infer = vi.fn();
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession(sessionId));
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: vi.fn() } as unknown as MessageHub,
    await createTestInternalEventBus()
  );
  service.repo.reserveBinding({ sessionId, kind: 'neo', projectId: null });
  expect(service.repo.conversationId()).toBe(conversationId);
  infer.mockReset().mockResolvedValue('Hello!');
});
afterEach(async () => {
  await service.dispose();
  db.close();
});
async function accept(enabled: boolean, content = 'Hello', mode: 'text' | 'live_voice' = 'text') {
  await db.updateGlobalSettings({ neo: { front: { enabled, model } } });
  const result = await service.asks.acceptPrompt(
    conversationId,
    neoIntakeMessage({
      sessionId,
      requestId,
      content,
      inputMode: mode,
      speech: mode === 'live_voice',
    }),
    'manual',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  expect(result).toMatchObject({ accepted: true, created: true });
  return db.getJobQueueRepo().listJobs({ queue: NEO_FRONT_INFERENCE });
}
test('off keeps coordinator delivery and schedules no front inference', async () => {
  expect(await accept(false)).toEqual([]);
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(sessionId, [requestId])).toHaveLength(
    1
  );
  expect(infer).not.toHaveBeenCalled();
});
test.each(['text', 'live_voice'] as const)(
  'on delivers one front reply for %s and retries preserve it',
  async (mode) => {
    const [job] = await accept(true, 'Hello', mode);
    const speech = vi
      .spyOn(service.speech, 'publish')
      .mockResolvedValue({ listening: 'yes', spokenDelivered: true });
    const handler = createNeoFrontHandler(service, infer);
    await handler(job);
    await handler(job);
    expect(infer).toHaveBeenCalledTimes(1);
    const replies = service.publications.list(conversationId) ?? [];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ fullText: 'Hello!', replyTo: [requestId] });
    expect(speech).toHaveBeenCalledWith(sessionId, replies[0].publicationId, 'Hello!');
    expect(
      db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(sessionId, [requestId])
    ).toHaveLength(1);
    expect(db.getDatabase().prepare('SELECT owner FROM neo_front_inputs').get()).toEqual({
      owner: null,
    });
  }
);
test('an empty inference is a job failure while coordinator delivery remains available', async () => {
  const [job] = await accept(true, 'Book the appointment');
  infer.mockResolvedValue(null);
  await expect(createNeoFrontHandler(service, infer)(job)).rejects.toThrow('front_empty_reply');
  expect(service.publications.list(conversationId) ?? []).toEqual([]);
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(sessionId, [requestId])).toHaveLength(
    1
  );
});
test('a brief deferral is delivered once with the original message identity', async () => {
  const [job] = await accept(true, 'Please cancel it');
  infer.mockResolvedValue('Let me check.');
  await createNeoFrontHandler(service, infer)(job);
  await createNeoFrontHandler(service, infer)(job);
  expect((service.publications.list(conversationId) ?? []).map((item) => item.fullText)).toEqual([
    'Let me check.',
  ]);
});
test('turning the switch off prevents a queued front job from speaking', async () => {
  const [job] = await accept(true);
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  await createNeoFrontHandler(service, infer)(job);
  expect(infer).not.toHaveBeenCalled();
  expect(service.publications.list(conversationId) ?? []).toEqual([]);
});

test('model failure leaves coordinator delivery available without a front publication', async () => {
  const [job] = await accept(true);
  infer.mockRejectedValueOnce(new Error('Model unavailable'));
  await expect(createNeoFrontHandler(service, infer)(job)).rejects.toThrow('Model unavailable');
  expect(service.publications.list(conversationId) ?? []).toEqual([]);
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(sessionId, [requestId])).toHaveLength(
    1
  );
});

test('disabling fast replies during inference prevents late publication', async () => {
  const [job] = await accept(true);
  let finish!: (text: string) => void;
  infer.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  const running = createNeoFrontHandler(service, infer)(job);
  await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(1));
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  finish('Late reply');
  expect(await running).toEqual({ delivered: false });
  expect(service.publications.list(conversationId) ?? []).toEqual([]);
});

test('concurrent jobs publish at most one front answer', async () => {
  const [job] = await accept(true);
  infer.mockResolvedValueOnce('First answer').mockResolvedValueOnce('Second answer');
  const handler = createNeoFrontHandler(service, infer);
  await Promise.all([handler(job), handler(job)]);
  expect(service.publications.list(conversationId)).toHaveLength(1);
});
