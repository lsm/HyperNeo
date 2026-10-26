import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
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
let service: ReturnType<typeof createNeoService>;
const invoke = (name: string, input: unknown, caller = neo) =>
  invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, caller);
const publication = { requestId: 'one', shortText: 'Ready', fullText: 'The comparison is ready.' };
const question = { askId: 'work', kind: 'reply', text: 'Which comparison?' };
async function received(kind = 'human', target = sessionId, consumed = true) {
  const id = crypto.randomUUID();
  if (kind === 'human' && target === sessionId)
    await invoke(
      'neo.message.send',
      { sessionId, requestId: id, content: 'Compare the synthetic drafts.' },
      human
    );
  else {
    if (target !== sessionId) await db.createSession(createTestSession(target));
    db.getSDKMessageRepo().saveUserMessage(
      target,
      {
        type: 'user',
        uuid: id,
        session_id: target,
        parent_tool_use_id: null,
        inputKind: kind,
        message: { role: 'user', content: 'Synthetic note' },
      } as import('@hyperneo/shared/sdk').SDKUserMessage,
      'enqueued'
    );
  }
  if (consumed) {
    const repo = db.getSDKMessageRepo();
    repo.updateMessageStatus([repo.findMessageIdByUuid(target, id)!], 'consumed');
  }
  return id;
}
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession(sessionId));
  service = createNeoService(
    db,
    { getCachedSession: mock(() => undefined) } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
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

test('a publication explicitly answers exactly the named received human inputs', async () => {
  const ids = await Promise.all([received(), received(), received()]);
  const replyTo = [ids[0], ids[2]];
  expect(await invoke('neo.publication.publish', { ...publication, replyTo })).toMatchObject({
    value: { accepted: true, publication: { replyTo } },
  });
  for (const id of ids)
    expect(
      service.publications.toldSince(conversationId, { sessionId, messageId: id }, '1970-01-01')
    ).toBe(replyTo.includes(id));
  expect(await invoke('neo.publication.publish', { ...publication, replyTo })).toMatchObject({
    value: { accepted: true, created: false },
  });
});

test('questions retain explicit human references without marking them answered', async () => {
  const id = await received();
  expect(await invoke('neo.question.ask', { ...question, replyTo: [id] })).toMatchObject({
    value: { ok: true, question: { replyTo: [id] } },
  });
  expect(service.sessions.getCachedSession).not.toHaveBeenCalled();
  expect(service.publications.list(conversationId)).toMatchObject([
    { cardReply: { sourceMessageIds: [id], askId: 'work' } },
  ]);
  expect(service.publications.list(conversationId)?.[0].replyTo).toBeUndefined();
  const stored = service.todos.listQuestions('work')[0];
  expect(await invoke('neo.question.get', { questionId: stored.id })).toMatchObject({
    value: { ok: true, question: { replyTo: [id] } },
  });
  expect(service.todos.getQuestion(stored.id)).toMatchObject({ replyTo: [id] });
  expect(
    service.publications.toldSince(conversationId, { sessionId, messageId: id }, '1970-01-01')
  ).toBe(false);
});

test.each(['unknown', 'foreign', 'system', 'task', 'queued'])(
  'publication omits %s references while question admission remains unchanged',
  async (kind) => {
    const id =
      kind === 'unknown'
        ? crypto.randomUUID()
        : await received(
            kind === 'queued' || kind === 'foreign' ? 'human' : kind,
            kind === 'foreign' ? 'ordinary' : sessionId,
            kind !== 'queued'
          );
    expect(
      await invoke('neo.publication.publish', { ...publication, replyTo: [id] })
    ).toMatchObject({ value: { accepted: true, publication: { replyTo: [] } } });
    expect(await invoke('neo.question.ask', { ...question, replyTo: [id] })).toMatchObject({
      value: { ok: false },
    });
    expect(service.publications.list(conversationId)).toHaveLength(1);
    expect(service.todos.listQuestions('work')).toHaveLength(0);
  }
);

test('new publishes reject triggerId while legacy publications keep it readable', async () => {
  expect(
    await invoke('neo.publication.publish', { ...publication, triggerId: 'human:old' })
  ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  const publicationId = crypto.randomUUID();
  expect(
    service.publications.append({
      conversationId,
      publicationId,
      shortText: 'Old',
      fullText: 'Legacy',
      links: [],
      triggerId: 'human:old',
    })
  ).toMatchObject({ accepted: true });
  expect(service.publications.get(conversationId, publicationId)).toMatchObject({
    triggerId: 'human:old',
  });
});

test('mixed publication references retain only received human inputs', async () => {
  const replyTo = [await received(), crypto.randomUUID()];
  expect(await invoke('neo.publication.publish', { ...publication, replyTo })).toMatchObject({
    value: { accepted: true, publication: { replyTo: [replyTo[0]] } },
  });
  expect(await invoke('neo.question.ask', { ...question, replyTo })).toMatchObject({
    value: { ok: false },
  });
  expect(service.publications.list(conversationId)).toHaveLength(1);
  expect(service.todos.listQuestions('work')).toHaveLength(0);
});

test('rewording a start question retains its explicit human references', async () => {
  const id = await received();
  service.todos.askQuestion(
    'start',
    'work',
    {
      text: 'Start the comparison?',
      kind: 'start',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      startTodos: [],
    },
    1
  );
  expect(
    await invoke('neo.question.ask', { ...question, kind: 'start', replyTo: [id] })
  ).toMatchObject({ value: { ok: true, question: { id: 'start', replyTo: [id] } } });
  expect(
    await invoke('neo.question.ask', { ...question, kind: 'start', text: 'Start now?' })
  ).toMatchObject({ value: { ok: true, question: { id: 'start', replyTo: [id] } } });
});
