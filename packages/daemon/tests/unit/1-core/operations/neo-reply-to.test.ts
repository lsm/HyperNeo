import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import {
  createNeoIntakeOperation,
  neoReplyAuthor,
  neoReplyFact,
  readNeoReply,
  repliedNeoRoute,
} from '../../../../src/lib/neo/intake.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createNeoPublicationTable } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { runMigration387 } from '../../../../src/storage/schema/m387-neo-ask-todo-tables.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const root = 'neo:10000000-0000-4000-8000-000000000001';
const holder = 'neo:holder:c1';

describe('neo.message.send replyTo', () => {
  let mailbox: MailboxTestDb;
  let repo: NeoRepository;
  let store: NeoAskTodoRepository;
  let db: Database;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration283(mailbox.db);
    runMigration289(mailbox.db);
    runMigration387(mailbox.db);
    createNeoPublicationTable(mailbox.db);
    for (const id of [root, holder])
      mailbox.db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id);
    repo = new NeoRepository(mailbox.db);
    repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
    repo.saveProject({ id: 'c1', title: 'C1', summary: '', context: '' }, 0);
    repo.reserveBinding({ sessionId: holder, kind: 'project', projectId: 'c1' });
    const sessions = new Map(
      [root, holder].map((id) => [id, { id, status: 'active' as const, config: {} }])
    );
    db = {
      getDatabase: () => mailbox.db,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      getJobQueueRepo: () => mailbox.jobQueue,
      getSession: (id: string) => sessions.get(id) as Session | undefined,
    } as unknown as Database;
    store = new NeoAskTodoRepository(mailbox.db);
    store.openAsk({
      id: 'ask',
      projectId: 'c1',
      sessionId: holder,
      originMessageId: null,
      title: 'iOS card',
      request: 'Redo the iOS card',
      createdAt: 1,
    });
    store.askQuestion(
      'q1',
      'ask',
      {
        text: 'What should the status say?',
        kind: 'reply',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      1
    );
    store.addTodo(
      't1',
      'ask',
      { title: 'Todo rows', doneWhen: 'Merged', check: null, instruction: 'Do it', named: null },
      1
    );
  });
  afterEach(() => mailbox.close());

  const send = (requestId: string, content: string, replyTo: { kind: string; id: string }) =>
    invokeOperation(
      createOperationRegistry([createNeoIntakeOperation(db, repo)]),
      'neo.message.send',
      { sessionId: root, requestId, content, replyTo },
      human
    );
  const prompt = (requestId: string) =>
    JSON.parse(
      (
        mailbox.db
          .prepare('SELECT session_id, sdk_message FROM sdk_messages WHERE sdk_uuid = ?')
          .get(requestId) as { sdk_message: string }
      ).sdk_message
    );
  const ledger = (requestId: string) =>
    JSON.parse(
      (
        mailbox.db
          .prepare('SELECT payload_json FROM neo_conversation_asks WHERE request_id = ?')
          .get(requestId) as { payload_json: string }
      ).payload_json
    );

  test('a reply to a question goes to the ask owner and records the words as its answer', async () => {
    const id = crypto.randomUUID();
    expect(await send(id, '在做 / 做完', { kind: 'question', id: 'q1' })).toMatchObject({
      value: { ok: true, created: true },
    });
    expect(prompt(id)).toMatchObject({
      session_id: holder,
      replyTo: { kind: 'question', id: 'q1' },
      message: {
        content: [
          { type: 'text', text: 'The human answered your question "What should the status say?":' },
          { type: 'text', text: '在做 / 做完' },
        ],
      },
    });
    expect(ledger(id)).toMatchObject({
      content: [{ type: 'text', text: '在做 / 做完' }],
      replyTo: { kind: 'question', id: 'q1' },
    });
    expect(store.getQuestion('q1')).toMatchObject({
      state: 'answered',
      answer: '在做 / 做完',
      answeredBy: 'chat',
    });
    expect(await send(id, '在做 / 做完', { kind: 'question', id: 'q1' })).toMatchObject({
      value: { ok: true, created: false },
    });
  });

  test('a retry records an answer the first send missed, and a reply without words answers nothing', async () => {
    const id = crypto.randomUUID();
    await send(id, '在做', { kind: 'question', id: 'q1' });
    mailbox.db.exec("UPDATE neo_questions SET state = 'open', answer = NULL");
    await send(id, '在做', { kind: 'question', id: 'q1' });
    expect(store.getQuestion('q1')).toMatchObject({ state: 'answered', answer: '在做' });
    mailbox.db.exec("UPDATE neo_questions SET state = 'open', answer = NULL");
    await send(crypto.randomUUID(), '   ', { kind: 'question', id: 'q1' });
    expect(store.getQuestion('q1')?.state).toBe('open');
  });

  test('a reply about a todo goes to the ask owner without answering anything', async () => {
    const id = crypto.randomUUID();
    await send(id, 'Use the new session', { kind: 'todo', id: 't1' });
    expect(prompt(id).message.content[0].text).toBe('The human replied about todo t1:');
    expect(store.getQuestion('q1')?.state).toBe('open');
  });

  test('a reply whose owner session is unavailable goes to Neo without recording an answer', async () => {
    (db.getSession as unknown as (id: string) => { status: string } | undefined)(holder)!.status =
      'archived';
    const id = crypto.randomUUID();
    await send(id, '在做', { kind: 'question', id: 'q1' });
    expect(prompt(id)).toMatchObject({
      session_id: root,
      message: { content: [{ type: 'text', text: '在做' }] },
    });
    expect(store.getQuestion('q1')?.state).toBe('open');
  });

  test('a reply to a message goes to the session that wrote it, without the router', async () => {
    const publicationId = '30000000-0000-4000-8000-000000000001';
    const origin = { sessionId: holder, messageId: 'turn-1' };
    mailbox.db
      .prepare(
        'INSERT INTO neo_publications (conversation_id, publication_id, payload_json, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(
        root.slice(4),
        publicationId,
        JSON.stringify({
          conversationId: root.slice(4),
          publicationId,
          askOrigin: origin,
          producerInput: origin,
          shortText: 'Card is redone.',
          fullText: 'Card is redone.',
          links: [],
        }),
        new Date().toISOString()
      );
    const routed: string[] = [];
    const router = async (text: string) => {
      routed.push(text);
      return { choice: null };
    };
    const reply = (requestId: string, id: string) =>
      invokeOperation(
        createOperationRegistry([createNeoIntakeOperation(db, repo, () => {}, router)]),
        'neo.message.send',
        { sessionId: root, requestId, content: 'Thanks', replyTo: { kind: 'message', id } },
        human
      );
    const id = crypto.randomUUID();
    await reply(id, publicationId);
    expect(prompt(id)).toMatchObject({
      session_id: holder,
      replyTo: { kind: 'message', id: publicationId },
      message: { content: [{ type: 'text', text: 'Thanks' }] },
    });
    const unknown = crypto.randomUUID();
    await reply(unknown, 'pub-1');
    expect([prompt(unknown).session_id, routed]).toEqual([root, ['Thanks']]);
  });
});

describe('repliedNeoRoute', () => {
  test('an ask owned by the main Neo session stays there', () => {
    const repo = { getBindingBySession: () => ({ sessionId: root, kind: 'neo', projectId: null }) };
    const reply = {
      replyTo: { kind: 'question' as const, id: 'q' },
      ask: { sessionId: root } as never,
      question: null,
      todo: null,
    };
    expect(repliedNeoRoute(neoReplyAuthor(reply, null), repo as never)).toEqual({
      reason: { choice: null, fallback: 'reply' },
    });
    expect(repliedNeoRoute(null, repo as never)).toEqual({ value: null });
  });
});

describe('neoReplyAuthor', () => {
  test("names the ask's owner, else the session that wrote the message", () => {
    const ask = { sessionId: holder } as never;
    const reply = {
      replyTo: { kind: 'question' as const, id: 'q' },
      ask,
      question: null,
      todo: null,
    };
    const publication = { producerInput: { sessionId: 'neo:holder:c2' } };
    expect(neoReplyAuthor(reply, publication)).toBe(holder);
    expect(neoReplyAuthor(null, publication)).toBe('neo:holder:c2');
    expect(neoReplyAuthor(null, null)).toBeNull();
  });
});

describe('readNeoReply', () => {
  test('reads nothing without replyTo', () => {
    expect(readNeoReply(undefined, {} as never)).toBeNull();
  });
});

describe('neoReplyFact', () => {
  test('adds no fact for a message reply', () => {
    expect(
      neoReplyFact({
        replyTo: { kind: 'message', id: 'm' },
        ask: null,
        question: null,
        todo: null,
      })
    ).toBeNull();
  });
});
