import { mkdtemp, rm } from 'node:fs/promises';
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
import { frontSession } from '../../../../src/lib/neo/front-session.ts';
import { admitCreateSessionConfig } from '../../../../src/lib/session/create-session-config.ts';
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
      admitCreateSessionConfig(input.config);
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
  expect(session.config.systemPrompt).toContain('You are Convo');
  expect(session.config.systemPrompt).toContain('The daemon records the terminal outcome');
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

test.each(['archived', 'ended'] as const)(
  'reactivating an %s Front session retains its SDK history',
  async (status) => {
    await db.createSession({
      ...createTestSession(front),
      status,
      archivedAt: new Date().toISOString(),
      sdkSessionId: 'retained-front-history',
    });
    const session = await frontSession(
      service,
      { conversationId, askOrigin: { sessionId: root, messageId: crypto.randomUUID() } },
      model
    );
    expect(session.status).toBe('active');
    expect(session.archivedAt).toBeUndefined();
    expect(db.captureSessionRuntimeSettings(front)?.archivedAt).toBeNull();
    expect(session.sdkSessionId).toBe('retained-front-history');
  }
);

test('concurrent first Front deliveries converge on one session', async () => {
  const create = service.sessions.createSession.bind(service.sessions);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  vi.spyOn(service.sessions, 'createSession').mockImplementation(async (input) => {
    arrivals++;
    if (arrivals === 2) release();
    await gate;
    return create(input);
  });
  const ask = { conversationId, askOrigin: { sessionId: root, messageId: crypto.randomUUID() } };
  const sessions = await Promise.all([
    frontSession(service, ask, model),
    frontSession(service, ask, model),
  ]);
  expect(sessions.map((session) => session.id)).toEqual([front, front]);
  expect(arrivals).toBe(2);
  expect(attach).toHaveBeenCalledTimes(2);
});

test('concurrent Front tool alignment accepts an already-converged selection', async () => {
  const existing = createTestSession(front);
  await db.createSession({
    ...existing,
    config: {
      ...existing.config,
      toolSelection: {
        version: 1,
        choices: { 'mcp:legacy': { selected: true, aliases: ['legacy'] } },
      },
    },
  });
  const commit = db.casSessionRuntimeSettings.bind(db);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  vi.spyOn(db, 'casSessionRuntimeSettings').mockImplementation(async (snapshot, patch) => {
    arrivals++;
    if (arrivals === 2) release();
    await gate;
    return commit(snapshot, patch);
  });
  const ask = { conversationId, askOrigin: { sessionId: root, messageId: crypto.randomUUID() } };
  const sessions = await Promise.all([
    frontSession(service, ask, model),
    frontSession(service, ask, model),
  ]);
  expect(sessions.map((session) => session.config.toolSelection)).toEqual([
    { version: 1, choices: {} },
    { version: 1, choices: {} },
  ]);
  expect(arrivals).toBe(2);
});

test('Front creation still propagates a failure when no session was created', async () => {
  vi.spyOn(service.sessions, 'createSession').mockRejectedValueOnce(new Error('create_refused'));
  await expect(
    frontSession(
      service,
      { conversationId, askOrigin: { sessionId: root, messageId: crypto.randomUUID() } },
      model
    )
  ).rejects.toThrow('create_refused');
  expect(db.getSession(front)).toBeNull();
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
  return {
    id,
    job: db
      .getJobQueueRepo()
      .listJobs({ queue: 'neo.front' })
      .find((job) => job.payload.messageId === id)!,
  };
}

test('human input reaches Front once without waking Back or auto-publishing', async () => {
  const { id, job } = await accept();
  const handler = createNeoFrontHandler(service);
  expect(await handler(job)).toEqual({ delivered: false, pending: true });
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
  expect(await createNeoFrontHandler(service)(job)).toEqual({
    delivered: true,
    outcome: 'handed_off',
  });
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(1);
  expect(db.getSession(front)).toBeNull();
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

test('canonical Neo speech retains its normal listener admission', async () => {
  const say = service.speech.operations.find((op) => op.name === 'neo.speech.say')!;
  expect(
    await say.execute(
      { requestId: 'speech', text: 'Hello' },
      { source: 'mcp', role: 'neo', sessionId: root }
    )
  ).toMatchObject({ ok: false, reason: 'voice_replies_off' });
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
  expect(next.config.allowedTools).toContain('mcp__front__neo_send');
  expect(next.config.allowedTools).not.toContain('mcp__front__publication_publish');
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
  'canonical Neo edits the existing answer for $topic instead of publishing duplicates',
  async ({ original, updates }) => {
    const { id, job } = await accept();
    await createNeoFrontHandler(service)(job);
    createFrontTools(service, conversationId);
    const send = vi
      .mocked(createSdkMcpServer)
      .mock.calls.at(-1)![0]
      .tools!.find((tool) => tool.name === 'neo_send');
    await send!.handler(
      { requestId: 'route-original', messageIds: [id], text: 'Handle the original request.' },
      {} as never
    );
    expect(db.getSDKMessageRepo().markDeliveryConsumedByUuid(root, id)).not.toBeNull();
    const saved = await service.publish(
      { requestId: 'original', verbatim: true, fullText: original, replyTo: [id] },
      { source: 'mcp', sessionId: root }
    );
    if (!saved.accepted) throw new Error('Original publication failed');
    for (const [index, fullText] of updates.entries()) {
      const input = {
        publicationId: saved.publication.publicationId,
        requestId: `correction-${index}`,
        fullText,
      };
      for (let retry = 0; retry < 2; retry++) {
        const response = await service.publications.reviseCurrent(input, {
          source: 'mcp',
          sessionId: root,
        });
        expect(response).toMatchObject({
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

test('Convo exposes only reads and neo_send', () => {
  createFrontTools(service, conversationId);
  const definitions = vi.mocked(createSdkMcpServer).mock.calls.at(-1)![0].tools!;
  expect(definitions.map((entry) => entry.name).sort()).toEqual([
    'asks_read',
    'cards_read',
    'handoff_read',
    'neo_send',
    'projects_read',
    'todos_read',
  ]);
});

test('the canonical Neo publication path remains available in dual mode', async () => {
  expect(
    await service.publish(
      { requestId: 'canonical', fullText: 'Canonical answer', verbatim: true },
      { source: 'mcp', role: 'neo', sessionId: root }
    )
  ).toMatchObject({ accepted: true });
});

test('Convo delivery remains pending until a terminal reply or handoff commits', async () => {
  await accept();
  const job = db.getJobQueueRepo().dequeue('neo.front', 1)[0];
  expect(await createNeoFrontHandler(service)(job)).toMatchObject({
    delivered: false,
    pending: true,
  });
  expect(db.getJobQueueRepo().getJob(job.id)?.status).toBe('pending');
});

test.each(['A plain terminal answer', ''])(
  'the daemon resolves a tool-free Convo terminal visibly (%s)',
  async (text) => {
    const { id, job } = await accept();
    const handler = createNeoFrontHandler(service);
    await handler(job);
    await db.saveUserMessage(
      front,
      {
        type: 'user',
        uuid: id as UUID,
        session_id: front,
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Hello' },
      },
      'enqueued'
    );
    expect(db.getSDKMessageRepo().markDeliveryConsumedByUuid(front, id)).not.toBeNull();
    await db.saveSDKMessage(front, {
      type: 'result',
      subtype: 'success',
      uuid: crypto.randomUUID(),
      session_id: front,
      result: text,
      is_error: false,
    } as import('@hyperneo/shared/sdk').SDKMessage);
    expect(await handler(job)).toMatchObject({ delivered: true });
    const replies = service.publications.list(conversationId)!;
    expect(replies).toHaveLength(1);
    expect(replies[0].replyTo).toEqual([id]);
    expect(replies[0].fullText.trim().length).toBeGreaterThan(0);
    if (text) expect(replies[0].fullText).toBe(text);
    await handler(job);
    expect(service.publications.list(conversationId)).toHaveLength(1);
  }
);

test.each(['creation', 'delivery'])(
  'a mode switch during %s hands the original input to Neo',
  async (phase) => {
    const { id, job } = await accept();
    const disable = () => db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
    if (phase === 'creation') {
      const create = service.sessions.createSession.bind(service.sessions);
      vi.spyOn(service.sessions, 'createSession').mockImplementation(async (input) => {
        const result = await create(input);
        await disable();
        return result;
      });
    } else {
      const deliver = service.deliverForward.bind(service);
      vi.spyOn(service, 'deliverForward').mockImplementation(async (...args) => {
        await deliver(...args);
        await disable();
      });
    }
    expect(await createNeoFrontHandler(service)(job)).toMatchObject({ delivered: true });
    expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id])).toHaveLength(1);
  }
);

test('the disabled-mode fallback preserves a manual Neo input hold', async () => {
  const { id, job } = await accept();
  await db.updateSession(root, { config: { ...db.getSession(root)!.config, queryMode: 'manual' } });
  await db.updateGlobalSettings({ neo: { front: { enabled: false, model } } });
  await createNeoFrontHandler(service)(job);
  const rows = db
    .getDatabase()
    .prepare('SELECT send_status FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?')
    .all(root, id);
  expect(rows).toEqual([{ send_status: 'deferred' }]);
});

test('a shared terminal still answers an unclaimed input after Neo answered its batch peer', async () => {
  const first = await accept();
  db.getDatabase()
    .prepare('UPDATE job_queue SET created_at = created_at - 1000 WHERE id = ?')
    .run(first.job.id);
  const second = await accept();
  expect(second.job.payload.messageId).toBe(second.id);
  const handler = createNeoFrontHandler(service);
  await handler(first.job);
  await handler(second.job);
  for (const { id } of [first, second]) {
    await db.saveUserMessage(
      front,
      {
        type: 'user',
        uuid: id as UUID,
        session_id: front,
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Hello' },
      },
      'enqueued'
    );
    expect(db.getSDKMessageRepo().markDeliveryConsumedByUuid(front, id)).not.toBeNull();
  }
  await db.saveSDKMessage(front, {
    type: 'result',
    subtype: 'success',
    uuid: crypto.randomUUID(),
    session_id: front,
    result: 'Remaining answer',
    is_error: false,
  } as import('@hyperneo/shared/sdk').SDKMessage);
  const { NeoPublicationRepository } = await import(
    '../../../../src/storage/repositories/neo-publication-repository.ts'
  );
  expect(
    new NeoPublicationRepository(db.getDatabase()).append({
      conversationId,
      publicationId: crypto.randomUUID(),
      fullText: 'First answer',
      verbatim: true,
      replyTo: [first.id],
      links: [],
    })
  ).toMatchObject({ accepted: true });
  expect(await handler(second.job)).toMatchObject({ delivered: true });
  const replies = service.publications.list(conversationId)!;
  expect(replies.filter((reply) => reply.replyTo?.includes(second.id))).toHaveLength(1);
  expect(replies.filter((reply) => reply.replyTo?.includes(first.id))).toHaveLength(1);
});

test('a pending Convo outcome does not reattach or redeliver the active session', async () => {
  const { id, job } = await accept();
  const deliver = vi.spyOn(service, 'deliverForward');
  const handler = createNeoFrontHandler(service);
  await handler(job);
  await db.saveUserMessage(
    front,
    {
      type: 'user',
      uuid: id as UUID,
      session_id: front,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    },
    'enqueued'
  );
  attach.mockClear();
  const update = vi.spyOn(db, 'updateSession');
  expect(await handler(job)).toMatchObject({ delivered: false, pending: true });
  expect(attach).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(deliver).toHaveBeenCalledTimes(1);
});
