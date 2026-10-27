import { runMigration453 } from '../../../../src/storage/schema/m453-neo-ask-focused-session.ts';
import { runMigration452 } from '../../../../src/storage/schema/m452-neo-question-source.ts';
import { runMigration450 } from '../../../../src/storage/schema/m450-neo-question-artifacts.ts';
import { runMigration446 } from '../../../../src/storage/schema/m446-neo-question-todo.ts';
import { runMigration442 } from '../../../../src/storage/schema/m442-neo-question-reply-to.ts';
import { runMigration433 } from '../../../../src/storage/schema/m433-neo-question-document.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import {
  createNeoIntakeOperation,
  neoQuoteFact,
  neoReplyFact,
  neoReplySnapshot,
  readNeoReply,
} from '../../../../src/lib/neo/intake.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { runMigration344 } from '../../../../src/storage/schema/m344-neo-ask-forwards.ts';
import { createNeoPublicationTable } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { runMigration387 } from '../../../../src/storage/schema/m387-neo-ask-todo-tables.ts';
import { runMigration398 } from '../../../../src/storage/schema/m398-neo-todo-blocked.ts';
import { runMigration434 } from '../../../../src/storage/schema/m434-neo-todo-artifacts.ts';
import { runMigration464 } from '../../../../src/storage/schema/m464-neo-todo-dependencies.ts';
import { runMigration420 } from '../../../../src/storage/schema/m420-neo-ask-goal.ts';
import { runMigration427 } from '../../../../src/storage/schema/m427-neo-question-confirm.ts';
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
    runMigration398(mailbox.db);
    runMigration434(mailbox.db);
    runMigration464(mailbox.db);
    runMigration420(mailbox.db);
    runMigration427(mailbox.db);
    runMigration433(mailbox.db);
    runMigration442(mailbox.db);
    runMigration446(mailbox.db);
    runMigration450(mailbox.db);
    runMigration452(mailbox.db);
    runMigration453(mailbox.db);
    createNeoPublicationTable(mailbox.db);
    runMigration344(mailbox.db);
    for (const id of [root, holder])
      mailbox.db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id);
    repo = new NeoRepository(mailbox.db);
    repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
    repo.saveProject({ id: 'c1', title: 'C1', summary: '', context: '' }, 0);
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
      sessionId: root,
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
  const prompt = (requestId: string) => {
    const stored = JSON.parse(
      (
        mailbox.db
          .prepare('SELECT session_id, sdk_message FROM sdk_messages WHERE sdk_uuid = ?')
          .get(requestId) as { sdk_message: string }
      ).sdk_message
    );
    const [identifier, time, ...content] = stored.message.content;
    expect(identifier.text).toBe(`[message id: ${requestId}]`);
    expect(time.text).toMatch(/^\(local time: \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+\)$/);
    return { ...stored, message: { ...stored.message, content } };
  };
  const ledger = (requestId: string) =>
    JSON.parse(
      (
        mailbox.db
          .prepare('SELECT payload_json FROM neo_conversation_asks WHERE request_id = ?')
          .get(requestId) as { payload_json: string }
      ).payload_json
    );

  test('a reply to a question goes to root Neo and records the words as its answer', async () => {
    const id = crypto.randomUUID();
    expect(await send(id, '在做 / 做完', { kind: 'question', id: 'q1' })).toMatchObject({
      value: { ok: true, created: true },
    });
    expect(prompt(id)).toMatchObject({
      session_id: root,
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

  test('a reply to a start question is a remark: it stays open and starts nothing', async () => {
    store.askQuestion(
      'q2',
      'ask',
      {
        text: 'Start "Todo rows"?',
        kind: 'start',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: ['t1'],
      },
      1
    );
    const id = crypto.randomUUID();
    await send(id, 'yes, but use the new session', { kind: 'question', id: 'q2' });
    expect(prompt(id).message.content[0].text).toBe(
      'The human replied about your start question "Start "Todo rows"?" (it stays open; only its Start button starts todos):'
    );
    expect(store.getQuestion('q2')).toMatchObject({ state: 'open', answer: null });
    expect(store.getTodo('t1')?.state).toBe('todo');
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

  test('a letter reply to a choice question answers with that option, like a tap', async () => {
    const choice = (id: string, multiple: boolean) =>
      store.askQuestion(
        id,
        'ask',
        {
          text: 'Which layout?',
          kind: 'choice',
          options: ['保留旧的列表布局，只调整间距', 'Cards', 'Use the compact table everywhere'],
          multiple,
          noLabel: null,
          yesLabel: null,
          startTodos: null,
        },
        1
      );
    const replies: [string, string[]][] = [
      ['A', ['保留旧的列表布局，只调整间距']],
      ['选A', ['保留旧的列表布局，只调整间距']],
      ['B吧', ['Cards']],
      ['option C', ['Use the compact table everywhere']],
      ['c.', ['Use the compact table everywhere']],
    ];
    for (const [index, [words, answer]] of replies.entries()) {
      choice(`c${index}`, false);
      const id = crypto.randomUUID();
      await send(id, words, { kind: 'question', id: `c${index}` });
      expect(store.getQuestion(`c${index}`)).toMatchObject({ answer, answeredBy: 'chat' });
      expect(prompt(id).message.content[0].text).toBe(
        `The human answered your question "Which layout?" with ${words.match(/[a-c]/i)?.[0].toUpperCase()} (${answer[0]}):`
      );
    }
    choice('many', true);
    await send(crypto.randomUUID(), 'A、C', { kind: 'question', id: 'many' });
    expect(store.getQuestion('many')?.answer).toEqual([
      '保留旧的列表布局，只调整间距',
      'Use the compact table everywhere',
    ]);
    choice('both', true);
    await send(crypto.randomUUID(), 'a and b', { kind: 'question', id: 'both' });
    expect(store.getQuestion('both')?.answer).toEqual(['保留旧的列表布局，只调整间距', 'Cards']);
    choice('glued', true);
    await send(crypto.randomUUID(), 'banda', { kind: 'question', id: 'glued' });
    expect(store.getQuestion('glued')?.answer).toBe('banda');
    for (const [index, words] of ['A、C', 'bad', 'D', 'a bit of both'].entries()) {
      choice(`raw${index}`, false);
      await send(crypto.randomUUID(), words, { kind: 'question', id: `raw${index}` });
      expect(store.getQuestion(`raw${index}`)?.answer).toBe(words);
    }
  });

  test('a reply about a todo goes to root Neo without answering anything', async () => {
    const id = crypto.randomUUID();
    await send(id, 'Use the new session', { kind: 'todo', id: 't1' });
    expect(prompt(id).message.content[0].text).toBe('The human replied about todo t1:');
    expect(store.getQuestion('q1')?.state).toBe('open');
  });

  test('a reply to a work card goes to root Neo with the card title as context', async () => {
    const id = crypto.randomUUID();
    await send(id, 'Where is this stuck?', { kind: 'ask', id: 'ask' });
    expect(prompt(id)).toMatchObject({
      session_id: root,
      replyTo: { kind: 'ask', id: 'ask' },
      message: {
        content: [
          { type: 'text', text: 'The human replied to the work card "iOS card":' },
          { type: 'text', text: 'Where is this stuck?' },
        ],
      },
      humanContent: [{ type: 'text', text: 'Where is this stuck?' }],
    });
    expect(store.getQuestion('q1')?.state).toBe('open');
  });

  test('a reply about an ask a holder still owns goes to root Neo without recording an answer', async () => {
    mailbox.db.prepare('UPDATE neo_asks SET session_id = ?').run(holder);
    const id = crypto.randomUUID();
    await send(id, '在做', { kind: 'question', id: 'q1' });
    expect(prompt(id)).toMatchObject({
      session_id: root,
      message: { content: [{ type: 'text', text: '在做' }] },
    });
    expect(store.getQuestion('q1')?.state).toBe('open');
  });

  test('a reply to a message a holder wrote goes to root Neo', async () => {
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
    const reply = (requestId: string, id: string) =>
      invokeOperation(
        createOperationRegistry([createNeoIntakeOperation(db, repo)]),
        'neo.message.send',
        { sessionId: root, requestId, content: 'Thanks', replyTo: { kind: 'message', id } },
        human
      );
    const id = crypto.randomUUID();
    await reply(id, publicationId);
    const snapshot = {
      kind: 'message',
      id: publicationId,
      author: 'neo',
      excerpt: 'Card is redone.',
    };
    expect(prompt(id)).toMatchObject({
      session_id: root,
      replyTo: snapshot,
      message: {
        content: [
          { type: 'text', text: 'The human replied to the Neo message "Card is redone.":' },
          { type: 'text', text: 'Thanks' },
        ],
      },
    });
    expect(ledger(id)).toEqual(
      expect.objectContaining({ content: [{ type: 'text', text: 'Thanks' }], replyTo: snapshot })
    );
    const unknown = crypto.randomUUID();
    await reply(unknown, 'pub-1');
    expect(prompt(unknown).session_id).toBe(root);
    expect([ledger(unknown).replyTo, prompt(unknown).message.content]).toEqual([
      { kind: 'message', id: 'pub-1' },
      [{ type: 'text', text: 'Thanks' }],
    ]);
  });

  test('a reply quoting the human’s own message goes to root Neo', async () => {
    const own = crypto.randomUUID();
    await send(own, '在做', { kind: 'question', id: 'q1' });
    expect(prompt(own).session_id).toBe(root);
    const id = crypto.randomUUID();
    await invokeOperation(
      createOperationRegistry([createNeoIntakeOperation(db, repo)]),
      'neo.message.send',
      {
        sessionId: root,
        requestId: id,
        content: 'And the badge?',
        replyTo: { kind: 'message', id: own },
      },
      human
    );
    expect(prompt(id).session_id).toBe(root);
    expect(ledger(id).replyTo).toEqual({
      kind: 'message',
      id: own,
      author: 'user',
      excerpt: '在做',
    });
  });
});

describe('neoReplySnapshot', () => {
  const ref = { kind: 'message' as const, id: 'm' };
  const ask = (content: unknown) => ({ content }) as never;
  test.each([300, 301, 500])(
    'keeps the stored excerpt limit for a %s-character publication summary',
    (length) => {
      const expected = length === 300 ? 'a'.repeat(300) : `${'a'.repeat(300)}…`;
      expect(
        neoReplySnapshot(
          ref,
          { shortText: 'a'.repeat(length), fullText: 'Detailed reply' } as never,
          null,
          null
        )
      ).toEqual({ ...ref, author: 'neo', excerpt: expected });
    }
  );
  test('quotes the first 300 characters of the original and keeps what a retry stored', () => {
    const long = `${'a'.repeat(299)} tail`;
    expect(neoReplySnapshot(ref, null, ask([{ type: 'text', text: long }]), null)).toEqual({
      ...ref,
      author: 'user',
      excerpt: `${'a'.repeat(299)}…`,
    });
    expect(neoReplySnapshot(ref, null, ask([{ type: 'image' }]), null)?.excerpt).toBe(
      '(attachment)'
    );
    expect(neoReplySnapshot(ref, null, null, null)).toEqual(ref);
    expect(neoReplySnapshot(ref, null, ask([]), { replyTo: ref } as never)).toEqual(ref);
    expect(neoReplySnapshot({ kind: 'todo', id: 't' }, null, null, null)).toEqual({
      kind: 'todo',
      id: 't',
    });
  });
});

describe('neoQuoteFact', () => {
  test('quotes the original only when the snapshot has one', () => {
    expect(neoQuoteFact({ kind: 'message', id: 'm', author: 'user', excerpt: 'Ship it' })).toBe(
      'The human replied to their earlier message "Ship it":'
    );
    expect(neoQuoteFact({ kind: 'message', id: 'm' })).toBeNull();
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
