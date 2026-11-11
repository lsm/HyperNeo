import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'node:crypto';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog.ts';
import { createFrontTools } from '../../../../src/lib/neo/front-model.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createNeoService } from '../../helpers/neo-service.ts';
import { createNeoFrontHandler } from '../../../../src/lib/neo/front-job.ts';
import { neoIntakeMessage } from '../../../../src/lib/neo/intake.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { frontSession } from '../../../../src/lib/neo/front-session.ts';
import { neoDerivedId } from '../../../../src/lib/neo/derived-id.ts';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const front = neoDerivedId(`front-session:${conversationId}`);
const model = { provider: 'glm', model: 'fixture', thinkingLevel: 'off' as const };
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
const attach = vi.fn();
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession(root));
  const sessions = {
    createSession: async (input: { sessionId: string; config: Partial<Session['config']> }) => {
      await db.createSession({
        ...createTestSession(input.sessionId),
        config: { ...createTestSession(input.sessionId).config, ...input.config },
      });
      return input.sessionId;
    },
    getSessionForControl: async (id: string) => ({
      updateMetadata: async (updates: Partial<Session>) => db.updateSession(id, updates),
      getSessionData: () => db.getSession(id),
      mergeRuntimeMcpServers: attach,
    }),
  } as unknown as SessionManager;
  attach.mockClear();
  service = createNeoService(
    db,
    sessions,
    { event: vi.fn() } as unknown as MessageHub,
    await createTestInternalEventBus()
  );
  service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  service.repo.conversationId();
  await db.updateGlobalSettings({ neo: { front: { enabled: true, model } } });
});
afterEach(async () => {
  await service.dispose();
  db.close();
});

test('Front uses the ordinary immediate session with its role and tools', async () => {
  const session = await frontSession(
    service,
    { conversationId, askOrigin: { sessionId: root, messageId: crypto.randomUUID() } },
    model
  );
  expect(session.id).toBe(front);
  expect(session.config.queryMode).toBe('immediate');
  expect(session.config.systemPrompt).toContain('Front Neo');
  expect(attach).toHaveBeenCalled();
});

test('dual mode refuses Back publication and single mode restores it', async () => {
  const draft = { requestId: 'result', verbatim: true, fullText: 'The work is ready.' };
  const caller = { source: 'mcp' as const, role: 'neo' as const, sessionId: root };
  expect(await service.publish(draft, caller)).toMatchObject({
    accepted: false,
    reason: 'dual_model_front_required',
  });
  expect(service.publications.list(conversationId)).toHaveLength(0);
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  expect(await service.publish(draft, caller)).toMatchObject({ accepted: true });
});

async function accept() {
  const id = crypto.randomUUID();
  await service.asks.acceptPrompt(
    conversationId,
    neoIntakeMessage({ sessionId: root, requestId: id, content: 'Hello' }),
    'manual',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  return { id, job: db.getJobQueueRepo().listJobs({ queue: 'neo.front' }).at(-1)! };
}

test('human input reaches both ordinary sessions once and assistant text is not auto-published', async () => {
  const { id, job } = await accept();
  const handler = createNeoFrontHandler(service);
  expect(await handler(job)).toEqual({ delivered: true });
  await handler(job);
  const jobs = db
    .getJobQueueRepo()
    .listJobs({ queue: 'mailbox' })
    .filter((j) => (j.payload as { to?: { sessionId?: string } }).to?.sessionId === front);
  expect(jobs).toHaveLength(1);
  expect(JSON.stringify(jobs[0].payload)).toContain(id);
  expect(service.publications.list(conversationId)).toHaveLength(0);
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(1);
});

test('a Front publication succeeds only while dual mode is enabled', async () => {
  await frontSession(
    service,
    { conversationId, askOrigin: { sessionId: root, messageId: root } },
    model
  );
  const caller = { source: 'mcp' as const, sessionId: front };
  expect(
    await service.publish({ requestId: 'front-answer', verbatim: true, fullText: 'Hello' }, caller)
  ).toMatchObject({ accepted: true });
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  expect(
    await service.publish(
      { requestId: 'late-front-answer', verbatim: true, fullText: 'Late' },
      caller
    )
  ).toMatchObject({ accepted: false });
  expect(service.publications.list(conversationId)).toHaveLength(1);
});

test('the final database write rechecks the speaker after a mode switch', async () => {
  const ledger = new NeoPublicationRepository(db.getDatabase());
  const input = {
    conversationId,
    publicationId: crypto.randomUUID(),
    verbatim: true as const,
    fullText: 'Old Back result',
    links: [],
  };
  expect(ledger.append(input, root)).toMatchObject({
    accepted: false,
    reason: 'publication_superseded',
  });
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  expect(ledger.append(input, root)).toMatchObject({ accepted: true });
  expect(ledger.append({ ...input, publicationId: crypto.randomUUID() }, front)).toMatchObject({
    accepted: false,
  });
});

test('switching modes notifies the same two sessions and preserves the Front SDK identity', async () => {
  await frontSession(
    service,
    { conversationId, askOrigin: { sessionId: root, messageId: root } },
    model
  );
  const sdkSessionId = crypto.randomUUID();
  await db.updateSession(front, { sdkSessionId });
  await service.frontModeChanged();
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  await service.frontModeChanged();
  expect(db.getSession(front)?.sdkSessionId).toBe(sdkSessionId);
  const jobs = db.getJobQueueRepo().listJobs({ queue: 'mailbox' });
  const text = JSON.stringify(jobs);
  expect(text).toContain('Dual-model mode');
  expect(text).toContain('Single-model mode');
  expect(text).toContain(front);
  expect(text).toContain(root);
});

test('Back results use the ordinary Front mailbox with a separate delivery identity', async () => {
  const { id, job } = await accept();
  await createNeoFrontHandler(service)(job);
  const resultId = crypto.randomUUID();
  await service.deliverForward(
    front,
    resultId,
    `Result for human message ${id}: complete.`,
    root,
    'event'
  );
  await service.deliverForward(
    front,
    resultId,
    `Result for human message ${id}: complete.`,
    root,
    'event'
  );
  const jobs = db
    .getJobQueueRepo()
    .listJobs({ queue: 'mailbox' })
    .filter((j) => (j.payload as { to?: { sessionId?: string } }).to?.sessionId === front);
  expect(jobs).toHaveLength(2);
  expect(JSON.stringify(jobs)).toContain(resultId);
  expect(JSON.stringify(jobs)).toContain(id);
});

test('a queued Front delivery stops when dual mode is disabled', async () => {
  const { job } = await accept();
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  expect(await createNeoFrontHandler(service)(job)).toEqual({ delivered: false });
  expect(db.getSession(front)).toBeNull();
});

test('Front publication tools refuse unknown inputs and preserve the actual reply target', async () => {
  const { id, job } = await accept();
  await createNeoFrontHandler(service)(job);
  createFrontTools(service, conversationId);
  const definitions = vi.mocked(createSdkMcpServer).mock.calls.at(-1)![0].tools!;
  const publish = definitions.find((tool) => tool.name === 'publication_publish')!;
  const input = {
    requestId: 'tool-reply',
    verbatim: true as const,
    fullText: 'Hello',
    replyTo: [id],
  };
  const rejected = await publish.handler({ ...input, replyTo: [crypto.randomUUID()] }, {} as never);
  expect(JSON.stringify(rejected)).toContain('unknown_reply_target');
  expect(service.publications.list(conversationId)).toHaveLength(0);
  await db.saveUserMessage(
    front,
    {
      type: 'user',
      uuid: id as UUID,
      session_id: front,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    },
    'consumed'
  );
  const sent = await publish.handler(input, {} as never);
  expect(JSON.parse((sent.content[0] as { text: string }).text)).toMatchObject({ accepted: true });
  expect(service.publications.list(conversationId)?.[0].replyTo).toEqual([id]);
  const repeated = await publish.handler(input, {} as never);
  expect(JSON.parse((repeated.content[0] as { text: string }).text)).toMatchObject({
    created: false,
  });
  expect(service.publications.list(conversationId)).toHaveLength(1);
});

test('Front notes go to the existing Back session and carry their original input reference', async () => {
  createFrontTools(service, conversationId);
  const definitions = vi.mocked(createSdkMcpServer).mock.calls.at(-1)![0].tools!;
  const send = definitions.find((tool) => tool.name === 'neo_send')!;
  await send.handler(
    { requestId: 'clarification', text: 'Human message original-id needs clarification.' },
    {} as never
  );
  await send.handler(
    { requestId: 'clarification', text: 'Human message original-id needs clarification.' },
    {} as never
  );
  const jobs = db
    .getJobQueueRepo()
    .listJobs({ queue: 'mailbox' })
    .filter((j) => JSON.stringify(j.payload).includes('original-id'));
  expect(jobs).toHaveLength(1);
  expect(JSON.stringify(jobs[0].payload)).toContain(root);
});

test('dual mode also refuses Back speech', async () => {
  const say = service.speech.operations.find((op) => op.name === 'neo.speech.say')!;
  expect(
    await say.execute(
      { requestId: 'speech', text: 'Hello' },
      { source: 'mcp', role: 'neo', sessionId: root }
    )
  ).toMatchObject({ ok: false, reason: 'dual_model_front_required' });
});

test('Front keeps ordinary model settings and preserves a usable conversation', async () => {
  const ask = { conversationId, askOrigin: { sessionId: root, messageId: root } };
  const first = await frontSession(service, ask, {
    ...model,
    thinkingLevel: 'think24k',
    autoCompactPercent: 80,
  });
  const sdkSessionId = crypto.randomUUID();
  await db.updateSession(first.id, { sdkSessionId });
  const next = await frontSession(service, ask, {
    ...model,
    thinkingLevel: 'think24k',
    autoCompactPercent: 80,
  });
  expect(next.sdkSessionId).toBe(sdkSessionId);
  expect(next.config).toMatchObject({
    model: 'fixture',
    provider: 'glm',
    thinkingLevel: 'think24k',
    autoCompactPercent: 80,
    queryMode: 'immediate',
  });
  expect(next.config.allowedTools).toContain('mcp__front__publication_publish');
});

test('Back can use message.send to reach its ordinary Front session', async () => {
  await frontSession(
    service,
    { conversationId, askOrigin: { sessionId: root, messageId: root } },
    model
  );
  const registry = createDatabaseOperationCatalog(db);
  const send = (input: unknown, caller: Parameters<typeof invokeOperation>[3]) =>
    invokeOperation(registry, 'message.send', input, caller);
  const receipt = await send(
    { to: front, text: 'Result for original human input.', idempotencyKey: 'back-result' },
    { source: 'mcp', role: 'neo', sessionId: root }
  );
  expect(receipt).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
  const unrelated = crypto.randomUUID();
  await db.createSession(createTestSession(unrelated));
  expect(
    await send(
      { to: unrelated, text: 'Unrelated' },
      { source: 'mcp', role: 'neo', sessionId: root }
    )
  ).toMatchObject({ kind: 'completed', value: { kind: 'rejected' } });
});
