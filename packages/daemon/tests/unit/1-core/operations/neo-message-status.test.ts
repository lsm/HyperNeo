import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { MessageSendStatus } from '@hyperneo/shared/types/message-delivery';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000002';
const sessionId = `neo:${conversationId}`;
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const neo: OperationCaller = { source: 'mcp', sessionId, role: 'neo' };
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: NeoService;
let bus: InternalEventBus<DaemonInternalEventMap>;
let notifications: string[];

const invoke = (name: string, input: unknown, caller = human) =>
  invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, caller);

async function input(content = 'Compare synthetic drafts.') {
  const requestId = crypto.randomUUID();
  expect(await invoke('neo.message.send', { sessionId, requestId, content })).toMatchObject({
    value: { ok: true, messageId: requestId },
  });
  return requestId;
}

function delivered(id: string, status: MessageSendStatus | null) {
  db.getDatabase()
    .prepare('UPDATE sdk_messages SET send_status = ? WHERE session_id = ? AND sdk_uuid = ?')
    .run(status, sessionId, id);
}

function processing(state: unknown) {
  db.updateSession(sessionId, {
    processingState: typeof state === 'string' ? state : JSON.stringify(state),
  });
}

async function reads(page: Record<string, unknown> = {}) {
  const asks = await invoke('neo.conversation.asks.read', { conversationId, ...page });
  const conversation = await invoke('neo.conversation.read', { conversationId });
  if (asks.kind !== 'completed' || conversation.kind !== 'completed')
    throw new Error(JSON.stringify({ asks, conversation }));
  const a = asks.value as { ok: boolean; items: NeoConversationAsk[] };
  const c = conversation.value as {
    ok: boolean;
    items: { role: string; ask?: NeoConversationAsk }[];
  };
  expect(a.ok && c.ok).toBe(true);
  for (const ask of a.items)
    expect(c.items.find((item) => item.ask?.requestId === ask.requestId)?.ask?.messageStatus).toBe(
      ask.messageStatus
    );
  return a.items;
}

beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession(sessionId));
  bus = new InternalEventBus<DaemonInternalEventMap>();
  notifications = [];
  service = new NeoService(
    db,
    {} as SessionManager,
    {
      event: mock((name: string) => {
        notifications.push(name);
      }),
    } as unknown as MessageHub,
    bus
  );
  service.deliverForward = async () => {};
  service.repo.reserveBinding({ sessionId, kind: 'neo', projectId: null });
  service.todos.openAsk({
    id: 'work',
    projectId: null,
    sessionId,
    originMessageId: null,
    title: 'Compare',
    request: 'Compare drafts',
    createdAt: 1,
  });
});

afterEach(() => {
  service.dispose();
  db.close();
});

test.each(['deferred', 'enqueued', 'submitted'] as const)(
  'both reads report %s input queued while idle',
  async (status) => {
    const id = await input();
    delivered(id, status);
    processing({ status: 'idle' });
    expect((await reads())[0]).toMatchObject({ requestId: id, messageStatus: 'queued' });
  }
);

test('a durable intake without consumption evidence is received and a failed send stays failed', async () => {
  const id = crypto.randomUUID();
  expect(
    service.asks.append({
      conversationId,
      requestId: id,
      askOrigin: { sessionId, messageId: id },
      content: 'Saved historical input.',
    }).accepted
  ).toBe(true);
  const failed = await input();
  delivered(failed, 'failed');
  expect((await reads()).map((ask) => [ask.requestId, ask.messageStatus, ask.delivery])).toEqual([
    [id, 'received', undefined],
    [failed, 'failed', { state: 'failed' }],
  ]);
});

test('only the exact consumed active input is working, never the oldest unanswered input', async () => {
  const ids = [await input(), await input(), await input()];
  for (const id of ids.slice(0, 2)) delivered(id, 'consumed');
  processing({ status: 'processing', phase: 'streaming', messageId: ids[1] });
  expect((await reads()).map((ask) => ask.messageStatus)).toEqual(['read', 'working', 'queued']);
  processing({ status: 'processing', phase: 'streaming', messageId: 'unrelated-system-input' });
  expect((await reads()).map((ask) => ask.messageStatus)).toEqual(['read', 'read', 'queued']);
  processing({ status: 'idle' });
  expect((await reads()).map((ask) => ask.messageStatus)).toEqual(['read', 'read', 'queued']);
});

test.each([
  { status: 'processing', phase: 'initializing' },
  { status: 'interrupted', reason: 'restart' },
  '{',
])(
  'a consumed unanswered input remains read through initialization or restart: %j',
  async (state) => {
    const id = await input();
    delivered(id, 'consumed');
    processing(typeof state === 'string' ? state : { ...state, messageId: id });
    expect((await reads())[0].messageStatus).toBe('read');
  }
);

test('a publication answers exactly its explicit consumed ids; asking back does not answer', async () => {
  const ids = [await input(), await input(), await input()];
  for (const id of ids) delivered(id, 'consumed');
  expect(
    await invoke(
      'neo.publication.publish',
      {
        requestId: 'reply',
        shortText: 'Ready',
        fullText: 'Synthetic comparison.',
        replyTo: [ids[0], ids[2]],
      },
      neo
    )
  ).toMatchObject({ value: { accepted: true } });
  expect(
    await invoke(
      'neo.question.ask',
      { askId: 'work', kind: 'reply', text: 'Which draft?', replyTo: [ids[1]] },
      neo
    )
  ).toMatchObject({ value: { ok: true } });
  expect((await reads()).map((ask) => ask.messageStatus)).toEqual(['answered', 'read', 'answered']);
  const first = service.asks.find(conversationId, ids[0])!;
  expect((await reads({ after: first.sequence, limit: 1 }))[0]).toMatchObject({
    requestId: ids[1],
    messageStatus: 'read',
  });
});

test('legacy attribution and a foreign publication cannot answer a received human input', async () => {
  const id = await input();
  delivered(id, 'consumed');
  for (const foreign of [false, true])
    expect(
      service.publications.append({
        conversationId: foreign ? crypto.randomUUID() : conversationId,
        publicationId: crypto.randomUUID(),
        shortText: 'Historical',
        fullText: 'Stored reply.',
        links: [],
        ...(foreign ? { replyTo: [id] } : { askOrigin: { sessionId, messageId: id } }),
      }).accepted
    ).toBe(true);
  expect((await reads())[0].messageStatus).toBe('read');
});

test('null legacy send status uses ordinary consumed semantics without inferring an answer', async () => {
  const id = await input();
  delivered(id, null);
  expect((await reads())[0].messageStatus).toBe('read');
});

test('image-reference reads retain the same daemon status field', async () => {
  const id = await input();
  delivered(id, 'consumed');
  expect((await reads({ imageRefs: true }))[0]).toMatchObject({
    requestId: id,
    messageStatus: 'read',
  });
});

test('ordinary delivery changes notify clients to refetch computed status without another input', async () => {
  const id = await input();
  notifications.length = 0;
  delivered(id, 'consumed');
  await bus.publish('messages.statusChanged', { sessionId, messageIds: [id], status: 'consumed' });
  expect(notifications).toContain('neo.changed');
  expect((await reads())[0].messageStatus).toBe('read');
  notifications.length = 0;
  await bus.publish('messages.statusChanged', {
    sessionId: 'unrelated',
    messageIds: [id],
    status: 'consumed',
  });
  expect(notifications).toEqual([]);
});

test.each(['neo.conversation.asks.read', 'neo.conversation.read'])(
  '%s awaits asynchronous status facts without copying human content into the request',
  async (name) => {
    const content = 'Complete human research result 🦊\n'.repeat(300);
    const id = await input(content);
    delivered(id, 'consumed');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facts = mock(async () => {
      await gate;
      return [{ sendStatus: 'consumed', processing: null, answered: true }];
    });
    Object.assign(db, { getNeoMessageStatusFactsAsync: facts });
    let completed = false;
    const pending = invoke(name, { conversationId }).then((result) => {
      completed = true;
      return result;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(completed).toBe(false);
      expect(facts.mock.calls).toEqual([
        [
          [
            {
              conversationId,
              requestId: id,
              askOrigin: { sessionId, messageId: id },
            },
          ],
        ],
      ]);
    } finally {
      release();
    }
    const result = await pending;
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('Status read failed');
    const page = result.value as {
      items: Array<NeoConversationAsk | { role: string; ask?: NeoConversationAsk }>;
    };
    const item = page.items[0];
    const ask = 'role' in item ? item.ask : item;
    expect(ask).toMatchObject({
      requestId: id,
      content: [{ type: 'text', text: content }],
      messageStatus: 'answered',
    });
    expect(service.asks.find(conversationId, id)?.content).toEqual([
      { type: 'text', text: content },
    ]);
  }
);

test.each(['neo.conversation.asks.read', 'neo.conversation.read'])(
  '%s propagates a file-reader failure instead of serving synchronous status facts',
  async (name) => {
    await input();
    Object.assign(db, {
      getNeoMessageStatusFactsAsync: mock(async () => {
        throw new Error('Synthetic async status reader unavailable');
      }),
    });
    expect(await invoke(name, { conversationId })).toMatchObject({ kind: 'failed' });
  }
);

test.each(['neo.conversation.asks.read', 'neo.conversation.read'])(
  '%s refuses a foreign conversation before an asynchronous fact request',
  async (name) => {
    const facts = mock(async () => []);
    Object.assign(db, { getNeoMessageStatusFactsAsync: facts });
    expect(
      await invoke(name, { conversationId: '10000000-0000-4000-8000-000000000099' })
    ).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'conversation_not_found' },
    });
    expect(facts).not.toHaveBeenCalled();
  }
);
