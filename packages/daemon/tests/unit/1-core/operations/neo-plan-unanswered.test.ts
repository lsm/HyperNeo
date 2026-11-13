import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { neoPlanContextHooks } from '../../../../src/lib/agent/neo-plan-hook.ts';

const conversation = '10000000-0000-4000-8000-00000000a001';
const answered = '10000000-0000-4000-8000-00000000a011';
const pending = '10000000-0000-4000-8000-00000000a012';
const pendingSecond = '10000000-0000-4000-8000-00000000a013';
const cardAnswered = '10000000-0000-4000-8000-00000000a014';
const revisionAnswered = '10000000-0000-4000-8000-00000000a015';
const pendingText = 'Ship the compact summary with the full message id';
const secondText = 'And keep the original wording';
let db: Database;

function seedInput(messageId: string, owner: 'neo' | 'front' | null, text: string) {
  db.prepare(
    'INSERT INTO neo_conversation_asks(conversation_id, request_id, payload_json, created_at) VALUES (?,?,?,?)'
  ).run(
    conversation,
    messageId,
    JSON.stringify({
      conversationId: conversation,
      requestId: messageId,
      askOrigin: { sessionId: 'neo:source', messageId },
      content: [{ type: 'text', text }],
    }),
    new Date().toISOString()
  );
  db.prepare(
    'INSERT INTO neo_front_inputs (conversation_id, message_id, eligible, owner) VALUES (?,?,1,?)'
  ).run(conversation, messageId, owner);
}

function seedAnswer(messageId: string) {
  db.prepare(
    'INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at) VALUES (?,?,?,?)'
  ).run(
    conversation,
    `publication-${messageId}`,
    JSON.stringify({ fullText: 'Answer', replyTo: [messageId], publishedBy: 'neo' }),
    new Date().toISOString()
  );
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.prepare(
    "INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata) VALUES ('neo:source','Synthetic','/synthetic',1,1,'active','{}','{}')"
  ).run();
  db.prepare('INSERT INTO neo_conversation (singleton, id, created_at) VALUES (1, ?, 1)').run(
    conversation
  );
});

afterEach(() => db.close());

test('reads the inputs Neo owns and has not answered, with the full id and text', async () => {
  seedInput(answered, 'neo', 'Already handled');
  seedInput(pending, 'neo', pendingText);
  seedInput(pendingSecond, 'front', secondText);
  seedAnswer(answered);

  const facts = await new NeoAskTodoRepository(db).read('planContext', true);

  expect(facts.unanswered).toEqual([{ id: pending, text: pendingText }]);
});

test('scans unanswered inputs only for the compact context', async () => {
  seedInput(pending, 'neo', pendingText);
  const todos = new NeoAskTodoRepository(db);
  let scans = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (sql.includes('neo_front_inputs')) scans++;
    return prepare(sql);
  }) as typeof db.prepare;

  expect((await todos.read('planContext')).unanswered).toBeUndefined();
  expect(scans).toBe(0);

  expect((await todos.read('planContext', true)).unanswered).toEqual([
    { id: pending, text: pendingText },
  ]);
  expect(scans).toBeGreaterThan(0);
  db.prepare = prepare;
});

test('lists an image-only input by its id with placeholder text', async () => {
  db.prepare(
    'INSERT INTO neo_conversation_asks(conversation_id, request_id, payload_json, created_at) VALUES (?,?,?,?)'
  ).run(
    conversation,
    pending,
    JSON.stringify({
      conversationId: conversation,
      requestId: pending,
      askOrigin: { sessionId: 'neo:source', messageId: pending },
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }],
    }),
    new Date().toISOString()
  );
  db.prepare(
    'INSERT INTO neo_front_inputs (conversation_id, message_id, eligible, owner) VALUES (?,?,1,?)'
  ).run(conversation, pending, 'neo');

  const facts = await new NeoAskTodoRepository(db).read('planContext', true);

  expect(facts.unanswered).toEqual([{ id: pending, text: '(non-text message)' }]);
});

test('counts a card reply as an answer', async () => {
  seedInput(cardAnswered, 'neo', 'Answered by a card');
  seedInput(pending, 'neo', pendingText);
  db.prepare(
    'INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at) VALUES (?,?,?,?)'
  ).run(
    conversation,
    'card-publication',
    JSON.stringify({
      fullText: 'Card answer',
      cardReply: {
        askId: 'ask-1',
        questionId: 'question-1',
        mutationId: 'mutation-1',
        sourceMessageIds: [cardAnswered],
      },
      publishedBy: 'neo',
    }),
    new Date().toISOString()
  );
  const facts = await new NeoAskTodoRepository(db).read('planContext', true);

  expect(facts.unanswered).toEqual([{ id: pending, text: pendingText }]);
});

test('keeps a message listed when only the front acknowledged the handoff', async () => {
  seedInput(answered, 'neo', 'Handed off to a worker');
  seedInput(pending, 'neo', pendingText);
  seedInput(revisionAnswered, 'neo', 'Replied and then revised by the front');
  const insert = db.prepare(
    'INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at) VALUES (?,?,?,?)'
  );
  insert.run(
    conversation,
    '10000000-0000-4000-8000-00000000b002',
    JSON.stringify({
      conversationId: conversation,
      publicationId: '10000000-0000-4000-8000-00000000b002',
      producerInput: { sessionId: 'neo:front', messageId: answered },
      verbatim: true,
      fullText: 'On it, I will start that work',
      links: [],
      publishedBy: 'front',
    }),
    new Date().toISOString()
  );
  insert.run(
    conversation,
    '10000000-0000-4000-8000-00000000b003',
    JSON.stringify({
      conversationId: conversation,
      publicationId: '10000000-0000-4000-8000-00000000b003',
      fullText: 'Revised by the front',
      revisions: [
        {
          revisionId: '10000000-0000-4000-8000-00000000b004',
          fullText: 'Revised by the front',
          createdAt: new Date().toISOString(),
          producerInput: { sessionId: 'neo:front', messageId: revisionAnswered },
        },
      ],
      publishedBy: 'front',
    }),
    new Date().toISOString()
  );

  const facts = await new NeoAskTodoRepository(db).read('planContext', true);

  expect(facts.unanswered).toEqual([
    { id: revisionAnswered, text: 'Replied and then revised by the front' },
    { id: pending, text: pendingText },
    { id: answered, text: 'Handed off to a worker' },
  ]);
});

test('stays fast on a long-lived conversation', async () => {
  const inputs = Array.from(
    { length: 200 },
    (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  );
  const insertAsk = db.prepare(
    'INSERT INTO neo_conversation_asks(conversation_id, request_id, payload_json, created_at) VALUES (?,?,?,?)'
  );
  const insertInput = db.prepare(
    'INSERT INTO neo_front_inputs (conversation_id, message_id, eligible, owner) VALUES (?,?,1,?)'
  );
  const insertPublication = db.prepare(
    'INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at) VALUES (?,?,?,?)'
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const id of inputs) {
      insertAsk.run(
        conversation,
        id,
        JSON.stringify({
          conversationId: conversation,
          requestId: id,
          askOrigin: { sessionId: 'neo:source', messageId: id },
          content: [{ type: 'text', text: 'Pending message' }],
        }),
        now
      );
      insertInput.run(conversation, id, 'neo');
    }
    for (let i = 0; i < 6_000; i++) {
      const answeredId = inputs[i % inputs.length];
      insertPublication.run(
        conversation,
        `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        JSON.stringify({
          conversationId: conversation,
          publicationId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          replyTo: [answeredId],
          fullText: 'Reply '.repeat(200),
          publishedBy: 'neo',
        }),
        now
      );
    }
  })();

  const started = performance.now();
  const facts = await new NeoAskTodoRepository(db).read('planContext', true);
  const elapsed = performance.now() - started;

  expect(facts.unanswered).toEqual([]);
  expect(elapsed).toBeLessThan(1_000);
});

test('sends unanswered messages to Neo after compaction and drops answered ones', async () => {
  seedInput(answered, 'neo', 'Already handled');
  seedInput(pending, 'neo', pendingText);
  seedAnswer(answered);
  const todos = new NeoAskTodoRepository(db);

  const hooks = neoPlanContextHooks(() => todos.read('planContext', true));
  const input = { session_id: 'synthetic', transcript_path: '', cwd: '/synthetic' };
  const context = await hooks.SessionStart![0].hooks[0](
    { ...input, hook_event_name: 'SessionStart', source: 'compact' } as never,
    undefined,
    { signal: new AbortController().signal }
  );
  const additionalContext = (context as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;

  expect(additionalContext).toContain(pending);
  expect(additionalContext).toContain(pendingText);
  expect(additionalContext).toContain(`replyTo: ["${pending}"]`);
  expect(additionalContext).not.toContain(answered);
  expect(additionalContext).not.toContain('Already handled');
});

test('leaves a fresh startup without unanswered messages', async () => {
  seedInput(pending, 'neo', pendingText);
  const todos = new NeoAskTodoRepository(db);

  const hooks = neoPlanContextHooks(() => todos.read('planContext', true));
  const context = await hooks.SessionStart![0].hooks[0](
    {
      session_id: 'synthetic',
      transcript_path: '',
      cwd: '/synthetic',
      hook_event_name: 'SessionStart',
      source: 'startup',
    } as never,
    undefined,
    { signal: new AbortController().signal }
  );

  expect(
    (context as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext
  ).not.toContain(pending);
});
