import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  handoffDraftDirectory,
  publishHandoff,
  publicHandoffReference,
} from '../../../../src/lib/handoffs/outbox.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishTextHandoff } from '../../../../src/lib/handoffs/publish-text.ts';
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
  expect(session.config.toolSelection).toEqual({ version: 1, choices: {} });
  expect(session.config.disallowedTools).toContain('mcp__exa');
  expect(session.config.systemPrompt).toContain('Front Neo');
  expect(session.config.systemPrompt).toContain(
    'publication_edit for an existing answer, publication_publish only for a permitted new message'
  );
  expect(attach).toHaveBeenCalled();
});

test('Front removes inherited catalog tools from an existing session without replacing its history', async () => {
  const existing = createTestSession(front);
  await db.createSession({
    ...existing,
    sdkSessionId: 'retained-front-history',
    config: {
      ...existing.config,
      toolSelection: {
        version: 1,
        choices: { 'mcp:legacy': { selected: true, aliases: ['legacy'] } },
      },
    },
  });
  const session = await frontSession(
    service,
    { conversationId, askOrigin: { sessionId: root, messageId: crypto.randomUUID() } },
    model
  );
  expect(session.config.toolSelection).toEqual({ version: 1, choices: {} });
  expect(session.config.disallowedTools).toContain('mcp__exa');
  expect(session.sdkSessionId).toBe('retained-front-history');
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

test('human input reaches Front once without waking Back or auto-publishing', async () => {
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
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(0);
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

test('a queued Front delivery falls back to Back when dual mode is disabled', async () => {
  const { id, job } = await accept();
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  expect(await createNeoFrontHandler(service)(job)).toEqual({ delivered: true });
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(1);
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
  const { id } = await accept();
  createFrontTools(service, conversationId);
  const definitions = vi.mocked(createSdkMcpServer).mock.calls.at(-1)![0].tools!;
  const send = definitions.find((tool) => tool.name === 'neo_send')!;
  await send.handler(
    {
      requestId: 'clarification',
      messageIds: [id],
      text: 'Human message original-id needs clarification.',
    },
    {} as never
  );
  await send.handler(
    {
      requestId: 'clarification',
      messageIds: [id],
      text: 'Human message original-id needs clarification.',
    },
    {} as never
  );
  const jobs = db
    .getJobQueueRepo()
    .listJobs({ queue: 'mailbox' })
    .filter((j) => JSON.stringify(j.payload).includes('original-id'));
  expect(jobs).toHaveLength(1);
  expect(JSON.stringify(jobs[0].payload)).toContain(root);
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(1);
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

test('Front chooses the spoken text on the human listening session', async () => {
  await frontSession(
    service,
    { conversationId, askOrigin: { sessionId: root, messageId: root } },
    model
  );
  const speech = vi
    .spyOn(service.speech, 'publish')
    .mockResolvedValue({ listening: 'yes', spokenDelivered: true });
  await service.publish(
    { requestId: 'voice-reply', verbatim: true, fullText: 'Hello from Neo.', spoken: 'Hello.' },
    { source: 'mcp', sessionId: front }
  );
  expect(speech).toHaveBeenCalledWith(root, expect.any(String), 'Hello.');
});

test('Front receives the quoted card and forwards the original human input only on handoff', async () => {
  const id = crypto.randomUUID();
  const replyTo = {
    kind: 'question' as const,
    id: crypto.randomUUID(),
    author: 'neo' as const,
    excerpt: 'Review the native settings window.',
  };
  await service.asks.acceptPrompt(
    conversationId,
    neoIntakeMessage({ sessionId: root, requestId: id, content: 'Show me a screenshot', replyTo }),
    'immediate',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(0);
  const job = db.getJobQueueRepo().listJobs({ queue: 'neo.front' }).at(-1)!;
  await createNeoFrontHandler(service)(job);
  const jobs = db.getJobQueueRepo().listJobs({ queue: 'mailbox' });
  expect(JSON.stringify(jobs)).toContain(replyTo.excerpt);
  createFrontTools(service, conversationId);
  const send = vi
    .mocked(createSdkMcpServer)
    .mock.calls.at(-1)![0]
    .tools!.find((tool) => tool.name === 'neo_send')!;
  await send.handler(
    { requestId: 'screenshot', messageIds: [id], text: 'Capture the quoted settings window.' },
    {} as never
  );
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(1);
});

test('single mode still delivers the human message directly to Back', async () => {
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  const { id } = await accept();
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(1);
  expect(db.getJobQueueRepo().listJobs({ queue: 'neo.front' })).toHaveLength(0);
});

test('an unknown Front handoff creates no Back delivery', async () => {
  createFrontTools(service, conversationId);
  const send = vi
    .mocked(createSdkMcpServer)
    .mock.calls.at(-1)![0]
    .tools!.find((tool) => tool.name === 'neo_send')!;
  const id = crypto.randomUUID();
  const response = await send.handler(
    { requestId: 'unknown', messageIds: [id], text: 'Do this.' },
    {} as never
  );
  expect(JSON.stringify(response)).toContain('unknown_reply_target');
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(0);
  expect(db.getJobQueueRepo().listJobs({ queue: 'mailbox' })).toHaveLength(0);
});

test('Front has a dedicated reader for the existing handoff operation', async () => {
  createFrontTools(service, conversationId);
  const definitions = vi.mocked(createSdkMcpServer).mock.calls.at(-1)![0].tools!;
  expect(definitions.find((tool) => tool.name === 'handoff_read')).toBeTruthy();
  const session = await frontSession(
    service,
    { conversationId, askOrigin: { sessionId: root, messageId: root } },
    model
  );
  expect(session.config.allowedTools).toContain('mcp__front__handoff_read');
  expect(session.config.operationTools).toBe(false);
});

test('Front reads Back report text through the verified handoff reader', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'front-handoff-'));
  const previous = process.env.HYPERNEO_DATA_DIR;
  process.env.HYPERNEO_DATA_DIR = folder;
  try {
    const text = 'Verified report. 完整结果。'.repeat(200);
    const reference = await publishTextHandoff(folder, root, text);
    createFrontTools(service, conversationId);
    const reader = vi
      .mocked(createSdkMcpServer)
      .mock.calls.at(-1)![0]
      .tools!.find((tool) => tool.name === 'handoff_read')!;
    const response = await reader.handler(
      { reference, offset: 0, length: 256 * 1024 },
      {} as never
    );
    expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({
      kind: 'read',
      text,
      complete: true,
    });
    const invalid = await reader.handler(
      {
        reference: { ...reference, path: reference.path + '.other' },
        offset: 0,
        length: 256 * 1024,
      },
      {} as never
    );
    expect(JSON.stringify(invalid)).toContain('invalid_reference');
  } finally {
    if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = previous;
    await rm(folder, { recursive: true, force: true });
  }
});

test('Front forwards a ready Back reply by message ID without rewriting or duplicate publication', async () => {
  const { id, job } = await accept();
  await createNeoFrontHandler(service)(job);
  const { NeoSessionMessageRepository } = await import(
    '../../../../src/storage/repositories/neo-session-message-repository.ts'
  );
  const publication = {
    fullText: '  Exact reply.\n\nKeep this spacing.  ',
    verbatim: true as const,
    replyTo: [id],
  };
  const sent = await invokeOperation(
    createDatabaseOperationCatalog(db),
    'message.send',
    {
      to: front,
      text: JSON.stringify({ publication }),
      idempotencyKey: 'ready-reply',
    },
    { source: 'mcp', role: 'neo', sessionId: root }
  );
  expect(sent.kind).toBe('completed');
  if (sent.kind !== 'completed') throw new Error('Back send failed');
  const receipt = sent.value as { messageId: string };
  const stored = new NeoSessionMessageRepository(db.getDatabase()).get(
    conversationId,
    receipt.messageId
  );
  expect(stored?.text).toBe(JSON.stringify({ publication }));
  createFrontTools(service, conversationId);
  const forward = vi
    .mocked(createSdkMcpServer)
    .mock.calls.at(-1)![0]
    .tools!.find((tool) => tool.name === 'publication_forward');
  expect(forward).toBeTruthy();
  for (let i = 0; i < 2; i++) {
    const response = await forward!.handler({ messageId: receipt.messageId }, {} as never);
    expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({
      accepted: true,
      created: i === 0,
    });
  }
  expect(service.publications.list(conversationId)).toHaveLength(1);
  expect(service.publications.list(conversationId)?.[0]).toMatchObject(publication);
});

test('forwarding preserves a preview and its work session through ordinary publication checks', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'front-ready-reply-'));
  const previous = process.env.HYPERNEO_DATA_DIR;
  process.env.HYPERNEO_DATA_DIR = folder;
  try {
    const { id, job } = await accept();
    await createNeoFrontHandler(service)(job);
    const worker = crypto.randomUUID();
    await db.createSession(createTestSession(worker));
    const name = 'result.md';
    await writeFile(join(handoffDraftDirectory(folder, root), name), '# Complete result');
    const published = await publishHandoff(folder, root, name);
    if (published.kind !== 'published') throw new Error('Fixture publication failed');
    const publication = {
      fullText: 'Exact result. '.repeat(400),
      verbatim: true,
      replyTo: [id],
      session: worker,
      artifacts: [publicHandoffReference(published.reference)],
    };
    const sent = await invokeOperation(
      createDatabaseOperationCatalog(db),
      'message.send',
      { to: front, text: JSON.stringify({ publication }), idempotencyKey: 'ready-with-preview' },
      { source: 'mcp', role: 'neo', sessionId: root }
    );
    if (sent.kind !== 'completed') throw new Error('Back send failed');
    const { messageId } = sent.value as { messageId: string };
    createFrontTools(service, conversationId);
    const forward = vi
      .mocked(createSdkMcpServer)
      .mock.calls.at(-1)![0]
      .tools!.find((tool) => tool.name === 'publication_forward')!;
    const response = await forward.handler({ messageId }, {} as never);
    expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({
      accepted: true,
    });
    expect(service.publications.list(conversationId)?.[0]).toMatchObject(publication);
  } finally {
    if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = previous;
    await rm(folder, { recursive: true, force: true });
  }
});

test.each(['note', 'wrong-sender', 'wrong-recipient', 'unknown-input'])(
  'forwarding refuses %s without publishing',
  async (kind) => {
    const { id, job } = await accept();
    await createNeoFrontHandler(service)(job);
    const { NeoSessionMessageRepository } = await import(
      '../../../../src/storage/repositories/neo-session-message-repository.ts'
    );
    const messageId = crypto.randomUUID();
    await new NeoSessionMessageRepository(db.getDatabase()).record({
      conversationId,
      messageId,
      fromSession: kind === 'wrong-sender' ? front : root,
      fromName: null,
      toSession: kind === 'wrong-recipient' ? root : front,
      toName: null,
      text:
        kind === 'note'
          ? 'Internal note only.'
          : JSON.stringify({
              publication: {
                fullText: 'Answer',
                verbatim: true,
                replyTo: [kind === 'unknown-input' ? crypto.randomUUID() : id],
              },
            }),
      createdAt: new Date().toISOString(),
      kind: 'session',
    });
    createFrontTools(service, conversationId);
    const forward = vi
      .mocked(createSdkMcpServer)
      .mock.calls.at(-1)![0]
      .tools!.find((tool) => tool.name === 'publication_forward')!;
    const response = await forward.handler({ messageId }, {} as never);
    expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({
      accepted: false,
    });
    expect(service.publications.list(conversationId)).toHaveLength(0);
  }
);

test('Front gets the complete quoted question with its options and references', async () => {
  const id = crypto.randomUUID();
  const askId = crypto.randomUUID();
  const questionId = crypto.randomUUID();
  service.todos.openAsk({
    id: askId,
    projectId: null,
    sessionId: root,
    originMessageId: id,
    title: 'Native settings',
    request: 'Review the native window.',
    createdAt: Date.now(),
  });
  const text = 'Review the native settings window. '.repeat(20) + 'The quoted tail is required.';
  service.todos.askQuestion(
    questionId,
    askId,
    {
      kind: 'choice',
      text,
      options: ['Open the native window', 'Show screenshots'],
      multiple: false,
      noLabel: null,
      yesLabel: null,
      startTodos: null,
      document: '/fixture/native-review.md',
    },
    Date.now()
  );
  await service.asks.acceptPrompt(
    conversationId,
    neoIntakeMessage({
      sessionId: root,
      requestId: id,
      content: 'Show me a screenshot',
      replyTo: { kind: 'question', id: questionId, author: 'neo', excerpt: text.slice(0, 300) },
    }),
    'immediate',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  await createNeoFrontHandler(service)(
    db.getJobQueueRepo().listJobs({ queue: 'neo.front' }).at(-1)!
  );
  const content = JSON.stringify(db.getJobQueueRepo().listJobs({ queue: 'mailbox' }));
  for (const expected of [
    questionId,
    askId,
    'Show screenshots',
    '/fixture/native-review.md',
    'The quoted tail is required.',
  ])
    expect(content).toContain(expected);
});

test.each([
  {
    topic: 'the C explanation',
    original: 'C removes the write-plan preview.',
    updates: [
      'The preview returns adapter, place, model and effort.',
      'The preview returns adapter, place, model and effort. Neo uses it through prompt guidance.',
    ],
  },
  {
    topic: 'the native screenshot request',
    original: 'The screenshot is pending because the Mac is locked.',
    updates: [
      'The Mac is still locked; the screenshot remains pending.',
      'The Mac is still locked; three native screenshots will follow after unlock.',
    ],
  },
])(
  'Front updates the existing answer for $topic instead of publishing duplicates',
  async ({ original, updates }) => {
    const { id, job } = await accept();
    await createNeoFrontHandler(service)(job);
    const saved = await service.publish(
      { requestId: 'original', verbatim: true, fullText: original, replyTo: [id] },
      { source: 'mcp', sessionId: front }
    );
    if (!saved.accepted) throw new Error('Original publication failed');
    createFrontTools(service, conversationId);
    const edit = vi
      .mocked(createSdkMcpServer)
      .mock.calls.at(-1)![0]
      .tools!.find((tool) => tool.name === 'publication_edit');
    expect(edit).toBeTruthy();
    for (const [index, fullText] of updates.entries()) {
      const input = {
        publicationId: saved.publication.publicationId,
        requestId: `correction-${index}`,
        fullText,
      };
      for (let retry = 0; retry < 2; retry++) {
        const response = await edit!.handler(input, {} as never);
        expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({
          accepted: true,
        });
      }
    }
    const publications = service.publications.list(conversationId) ?? [];
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      publicationId: saved.publication.publicationId,
      fullText: updates.at(-1),
      replyTo: [id],
    });
    expect(publications[0].revisions).toHaveLength(updates.length);
  }
);
