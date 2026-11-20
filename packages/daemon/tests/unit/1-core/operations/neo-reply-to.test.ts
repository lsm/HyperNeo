import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { createNeoConversationAskReadOperation } from '../../../../src/lib/neo/conversation-ask-read-operation.ts';
import {
  createNeoIntakeOperation,
  neoQuoteFact,
  neoReplyFact,
  neoReplySnapshot,
  readNeoReply,
} from '../../../../src/lib/neo/intake.ts';
import { prepareCodingTodoStorage } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { createNeoPublicationTable } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { runMigration344 } from '../../../../src/storage/schema/m344-neo-ask-forwards.ts';
import { runMigration387 } from '../../../../src/storage/schema/m387-neo-ask-todo-tables.ts';
import { runMigration398 } from '../../../../src/storage/schema/m398-neo-todo-blocked.ts';
import { runMigration420 } from '../../../../src/storage/schema/m420-neo-ask-goal.ts';
import { runMigration427 } from '../../../../src/storage/schema/m427-neo-question-confirm.ts';
import { runMigration428 } from '../../../../src/storage/schema/m428-pack-preference-proposals.ts';
import { runMigration429 } from '../../../../src/storage/schema/m429-neo-rule-proposals.ts';
import { runMigration433 } from '../../../../src/storage/schema/m433-neo-question-document.ts';
import { runMigration434 } from '../../../../src/storage/schema/m434-neo-todo-artifacts.ts';
import { runMigration442 } from '../../../../src/storage/schema/m442-neo-question-reply-to.ts';
import { runMigration446 } from '../../../../src/storage/schema/m446-neo-question-todo.ts';
import { runMigration450 } from '../../../../src/storage/schema/m450-neo-question-artifacts.ts';
import { runMigration452 } from '../../../../src/storage/schema/m452-neo-question-source.ts';
import { runMigration453 } from '../../../../src/storage/schema/m453-neo-ask-focused-session.ts';
import { runMigration463 } from '../../../../src/storage/schema/m463-neo-todo-priority.ts';
import { runMigration464 } from '../../../../src/storage/schema/m464-neo-todo-dependencies.ts';
import { runMigration466 } from '../../../../src/storage/schema/m466-neo-question-retire-when.ts';
import { runMigration476 } from '../../../../src/storage/schema/m476-neo-todo-approved-at.ts';
import { runMigration484 } from '../../../../src/storage/schema/m484-todo-approval-question.ts';
import { runMigration486 } from '../../../../src/storage/schema/m486-neo-ask-topic.ts';
import { runMigration495 } from '../../../../src/storage/schema/m495-neo-answer-provenance.ts';
import { runMigration502 } from '../../../../src/storage/schema/m502-neo-question-todos.ts';
import { runMigration507 } from '../../../../src/storage/schema/m507-neo-question-option-labels.ts';
import { runMigration508 } from '../../../../src/storage/schema/m508-neo-removed-prerequisites.ts';
import { runMigration510 } from '../../../../src/storage/schema/m510-neo-card-actions-applied.ts';
import { runMigration512 } from '../../../../src/storage/schema/m512-neo-todo-produces-follow-up.ts';
import { runMigration515 } from '../../../../src/storage/schema/m515-neo-question-held.ts';
import { runMigration527 } from '../../../../src/storage/schema/m527-neo-question-option-details.ts';
import { runMigration532 } from '../../../../src/storage/schema/m532-neo-question-desktop-app.ts';
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
    runMigration463(mailbox.db);
    runMigration464(mailbox.db);
    runMigration476(mailbox.db);
    runMigration484(mailbox.db);
    runMigration486(mailbox.db);
    runMigration420(mailbox.db);
    runMigration427(mailbox.db);
    runMigration428(mailbox.db);
    runMigration429(mailbox.db);
    runMigration433(mailbox.db);
    runMigration442(mailbox.db);
    runMigration446(mailbox.db);
    runMigration450(mailbox.db);
    runMigration452(mailbox.db);
    runMigration453(mailbox.db);
    runMigration466(mailbox.db);
    runMigration495(mailbox.db);
    runMigration502(mailbox.db);
    runMigration507(mailbox.db);
    runMigration508(mailbox.db);
    runMigration510(mailbox.db);
    runMigration512(mailbox.db);
    runMigration515(mailbox.db);
    runMigration527(mailbox.db);
    runMigration532(mailbox.db);
    createNeoPublicationTable(mailbox.db);
    runMigration344(mailbox.db);
    prepareCodingTodoStorage(mailbox.db);
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
    const raw: {
      session_id?: string;
      message: { content: { text?: string }[] };
    } = JSON.parse(
      (
        mailbox.db
          .prepare('SELECT session_id, sdk_message FROM sdk_messages WHERE sdk_uuid = ?')
          .get(requestId) as { sdk_message: string }
      ).sdk_message
    );
    const text = raw.message.content.map((block) => block.text ?? '').join('');
    expect(text).toMatch(/^\(local time: \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+\)\n/);
    expect(text).toContain(`\n<human-message id="${requestId}"`);
    expect(text).toEndWith('</human-message>');
    const reference = text.match(/<reference[^>]*>\n([\s\S]*?)\n<\/reference>/)?.[1] ?? '';
    const after = reference
      ? text.slice(text.indexOf('</reference>') + '</reference>'.length)
      : text.slice(text.indexOf('>\n') + 2);
    const words = after.replace(/<\/human-message>$/, '').trim();
    return { ...raw, reference, words, text };
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
    const sent = prompt(id);
    expect(sent).toMatchObject({ session_id: root, replyTo: { kind: 'question', id: 'q1' } });
    expect(sent.reference).toBe('What should the status say?');
    expect(sent.words).toBe('在做 / 做完');
    expect(sent.text).toContain(`\n<human-message id="${id}" ask="ask" question="q1">\n`);
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

  test.each([
    ['question', 'q1', 'What should the status say?'],
    ['todo', 't1', 'Todo rows'],
    ['ask', 'ask', 'iOS card'],
  ] as const)(
    'saves the resolved %s quote independently of visible cards',
    async (kind, id, excerpt) => {
      const requestId = crypto.randomUUID();
      expect(await send(requestId, 'A human reply', { kind, id })).toMatchObject({
        value: { ok: true },
      });
      expect(ledger(requestId).replyTo).toEqual({ kind, id, author: 'neo', excerpt });
    }
  );

  test('replaced and answered question quotes retain their exact target text on retries', async () => {
    mailbox.db
      .prepare("UPDATE neo_questions SET state='retired',replaced_by='q2' WHERE id='q1'")
      .run();
    store.askQuestion(
      'q2',
      'ask',
      {
        text: 'Replacement choice',
        kind: 'choice',
        options: ['Keep', 'Change'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
      },
      2
    );
    const oldId = crypto.randomUUID(),
      newId = crypto.randomUUID();
    await send(oldId, 'About the earlier card', { kind: 'question', id: 'q1' });
    await send(newId, 'Keep', { kind: 'question', id: 'q2' });
    expect(ledger(oldId).replyTo).toEqual({
      kind: 'question',
      id: 'q1',
      author: 'neo',
      excerpt: 'What should the status say?',
    });
    expect(ledger(newId).replyTo).toEqual({
      kind: 'question',
      id: 'q2',
      author: 'neo',
      excerpt: 'Replacement choice',
    });
    expect(await send(newId, 'Keep', { kind: 'question', id: 'q2' })).toMatchObject({
      value: { ok: true, created: false },
    });
    mailbox.db.prepare("UPDATE neo_questions SET text='Later wording' WHERE id='q2'").run();
    expect(ledger(newId).replyTo.excerpt).toBe('Replacement choice');
  });

  test('public history resolves legacy retired-card references without rewriting stored asks', async () => {
    mailbox.db.prepare("UPDATE neo_questions SET state='retired' WHERE id='q1'").run();
    const requestId = crypto.randomUUID(),
      conversationId = repo.conversationId()!;
    const asks = new NeoConversationAskRepository(mailbox.db);
    expect(
      asks.append({
        conversationId,
        requestId,
        askOrigin: { sessionId: root, messageId: requestId },
        content: 'Legacy reply',
        replyTo: { kind: 'question', id: 'q1' },
      }).accepted
    ).toBe(true);
    const before = ledger(requestId);
    const result = await invokeOperation(
      createOperationRegistry([
        createNeoConversationAskReadOperation(repo, asks, undefined, mailbox.db),
      ]),
      'neo.conversation.asks.read',
      { conversationId },
      human
    );
    expect(result).toMatchObject({
      kind: 'completed',
      value: {
        ok: true,
        items: [
          {
            replyTo: {
              kind: 'question',
              id: 'q1',
              author: 'neo',
              excerpt: 'What should the status say?',
            },
          },
        ],
      },
    });
    expect(ledger(requestId)).toEqual(before);
  });

  test('unknown card references stay unavailable on public history reads', async () => {
    const requestId = crypto.randomUUID(),
      conversationId = repo.conversationId()!;
    const asks = new NeoConversationAskRepository(mailbox.db),
      replyTo = { kind: 'question' as const, id: 'missing-card' };
    expect(
      asks.append({
        conversationId,
        requestId,
        askOrigin: { sessionId: root, messageId: requestId },
        content: 'Missing original',
        replyTo,
      }).accepted
    ).toBe(true);
    expect(
      await invokeOperation(
        createOperationRegistry([
          createNeoConversationAskReadOperation(repo, asks, undefined, mailbox.db),
        ]),
        'neo.conversation.asks.read',
        { conversationId },
        human
      )
    ).toMatchObject({ kind: 'completed', value: { ok: true, items: [{ replyTo }] } });
    expect(ledger(requestId).replyTo).toEqual(replyTo);
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

  test('a number reply to a removed-prerequisite card applies its decision', async () => {
    const draft = { doneWhen: 'Observed', check: null, instruction: null, named: null };
    const gone = store.addTodo('gone', 'ask', { ...draft, title: 'Gone', dependsOn: [] }, 1);
    store.addTodo('next', 'ask', { ...draft, title: 'Next', dependsOn: ['gone'] }, 1);
    store.updateTodo(gone, { state: 'removed' }, 1);
    store.askQuestion(
      'removed',
      'ask',
      {
        text: '"Gone" was removed. Continue "Next" without it, or remove this step too?',
        kind: 'choice',
        options: ['Continue', 'Remove these'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
        todos: ['next'],
        cause: 'removed_prerequisite',
      },
      1
    );
    await send(crypto.randomUUID(), '2', { kind: 'question', id: 'removed' });
    expect(store.getQuestion('removed')).toMatchObject({ answer: ['Remove these'] });
    expect(store.getTodo('next')?.state).toBe('removed');
  });

  test('a number reply to a choice question answers with that option, like a tap', async () => {
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
        },
        1
      );
    const replies: [string, string[]][] = [
      ['1', ['保留旧的列表布局，只调整间距']],
      ['选一', ['保留旧的列表布局，只调整间距']],
      ['第二个吧', ['Cards']],
      ['option 3', ['Use the compact table everywhere']],
      ['the third one.', ['Use the compact table everywhere']],
    ];
    for (const [index, [words, answer]] of replies.entries()) {
      choice(`c${index}`, false);
      const id = crypto.randomUUID();
      await send(id, words, { kind: 'question', id: `c${index}` });
      expect(store.getQuestion(`c${index}`)).toMatchObject({ answer, answeredBy: 'chat' });
      expect(prompt(id).reference).toBe('Which layout?');
    }
    store.askQuestion(
      'numeric-option',
      'ask',
      {
        text: 'How many days?',
        kind: 'choice',
        options: ['7', '30', '90'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
      },
      1
    );
    await send(crypto.randomUUID(), '30', { kind: 'question', id: 'numeric-option' });
    expect(store.getQuestion('numeric-option')?.answer).toEqual(['30']);
    store.askQuestion(
      'numeric-ambiguous',
      'ask',
      {
        text: 'How many days?',
        kind: 'choice',
        options: ['30', '1', '90'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
      },
      1
    );
    await send(crypto.randomUUID(), '1', { kind: 'question', id: 'numeric-ambiguous' });
    expect(store.getQuestion('numeric-ambiguous')?.answer).toEqual(['30']);
    choice('many', true);
    await send(crypto.randomUUID(), '1、3', { kind: 'question', id: 'many' });
    expect(store.getQuestion('many')?.answer).toEqual([
      '保留旧的列表布局，只调整间距',
      'Use the compact table everywhere',
    ]);
    choice('both', true);
    await send(crypto.randomUUID(), 'first and second', { kind: 'question', id: 'both' });
    expect(store.getQuestion('both')?.answer).toEqual(['保留旧的列表布局，只调整间距', 'Cards']);
    choice('glued', true);
    await send(crypto.randomUUID(), '第二天出发', { kind: 'question', id: 'glued' });
    expect(store.getQuestion('glued')?.answer).toBe('第二天出发');
    for (const [index, words] of ['A', 'no one', 'the one', 'a bit of both'].entries()) {
      choice(`raw${index}`, false);
      await send(crypto.randomUUID(), words, { kind: 'question', id: `raw${index}` });
      expect(store.getQuestion(`raw${index}`)?.answer).toBe(words);
    }
    for (const [index, words] of [
      '4',
      '第五个',
      '1、3',
      '7',
      '0',
      '七',
      'seventh',
      '第十个',
      '100',
    ].entries()) {
      choice(`bad${index}`, false);
      const id = crypto.randomUUID();
      await send(id, words, { kind: 'question', id: `bad${index}` });
      expect(store.getQuestion(`bad${index}`)).toMatchObject({ state: 'open', answer: null });
      expect(prompt(id).words).toBe(words);
    }
  });

  test('a reply about a todo goes to root Neo without answering anything', async () => {
    const id = crypto.randomUUID();
    await send(id, 'Use the new session', { kind: 'todo', id: 't1' });
    expect(prompt(id).reference).toBe('Todo rows');
    expect(store.getQuestion('q1')?.state).toBe('open');
  });

  test('a reply to a work card goes to root Neo with the card title as context', async () => {
    const id = crypto.randomUUID();
    await send(id, 'Where is this stuck?', { kind: 'ask', id: 'ask' });
    expect(prompt(id)).toMatchObject({
      session_id: root,
      replyTo: { kind: 'ask', id: 'ask' },
      reference: 'iOS card',
      words: 'Where is this stuck?',
      humanContent: [{ type: 'text', text: 'Where is this stuck?' }],
    });
    expect(store.getQuestion('q1')?.state).toBe('open');
  });

  test('a reply about an ask a holder still owns goes to root Neo without recording an answer', async () => {
    mailbox.db.prepare('UPDATE neo_asks SET session_id = ?').run(holder);
    const id = crypto.randomUUID();
    await send(id, '在做', { kind: 'question', id: 'q1' });
    const sent = prompt(id);
    expect(sent.session_id).toBe(root);
    expect(sent.text).toContain(`\n<human-message id="${id}" ask="ask" question="q1">\n`);
    expect(sent.words).toBe('在做');
    expect(sent.reference).toBe('');
    expect(sent.text).toMatch(/\n\n<\/human-message>$/);
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
      reference: 'Card is redone.',
      words: 'Thanks',
    });
    expect(ledger(id)).toEqual(
      expect.objectContaining({ content: [{ type: 'text', text: 'Thanks' }], replyTo: snapshot })
    );
    const unknown = crypto.randomUUID();
    await reply(unknown, 'pub-1');
    expect(prompt(unknown).session_id).toBe(root);
    expect([ledger(unknown).replyTo, prompt(unknown).words]).toEqual([
      { kind: 'message', id: 'pub-1' },
      'Thanks',
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
      'Ship it'
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
