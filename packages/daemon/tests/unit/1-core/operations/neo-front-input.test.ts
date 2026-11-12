import { NEO_FRONT_INFERENCE } from '../../../../src/lib/job-queue-constants.ts';
import { neoIntakeMessage } from '../../../../src/lib/neo/intake.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoFrontInputRepository } from '../../../../src/storage/repositories/neo-front-input-worker.ts';
import { createMailboxEntry } from '../../../../src/lib/mailbox/entry.ts';
import { runMigration504 } from '../../../../src/storage/schema/m504-neo-front-input-owner-backfill.ts';
import { runMigration503 } from '../../../../src/storage/schema/m503-neo-front-input-catch-up.ts';

let db: Database;
let inputs: NeoFrontInputRepository;
beforeEach(async () => {
  db = await createTestDb();
  inputs = new NeoFrontInputRepository(db.getDatabase());
});
afterEach(() => db.close());

test('eligibility is stamped once even when a retry flips the setting', () => {
  inputs.accept('conversation', 'off', false);
  inputs.accept('conversation', 'on', true);
  inputs.accept('conversation', 'off', true);
  inputs.accept('conversation', 'on', false);
  expect(inputs.get('conversation', 'off')?.eligible).toBe(false);
  expect(inputs.get('conversation', 'on')?.eligible).toBe(true);
});

test('the same lane keeps answering an input and the other lane is refused', () => {
  inputs.accept('conversation', 'input', true);
  expect(inputs.claim('conversation', ['input'], 'front')).toBe('claimed');
  expect(inputs.claim('conversation', ['input'], 'front')).toBe('claimed');
  expect(inputs.claim('conversation', ['input'], 'neo')).toBe('handed_off');
  expect(inputs.get('conversation', 'input')?.owner).toBe('front');
});

test('a batch with an input this lane already answered claims the rest', () => {
  inputs.accept('conversation', 'first', true);
  inputs.accept('conversation', 'second', true);
  inputs.claim('conversation', ['first'], 'neo');
  expect(inputs.claim('conversation', ['first', 'second'], 'neo')).toBe('claimed');
  expect(inputs.get('conversation', 'second')?.owner).toBe('neo');
});

test('a speakerless card reply claims only unowned inputs and is never refused', () => {
  inputs.accept('conversation', 'owned', true);
  inputs.accept('conversation', 'open', true);
  inputs.claim('conversation', ['owned'], 'front');
  expect(inputs.claim('conversation', ['owned', 'open'], 'neo', true)).toBe('claimed');
  expect(inputs.get('conversation', 'owned')?.owner).toBe('front');
  expect(inputs.get('conversation', 'open')?.owner).toBe('neo');
});

test('missing, cross-conversation and disabled inputs cannot be claimed', () => {
  inputs.accept('conversation', 'input', false);
  expect(inputs.claim('conversation', ['input'], 'front')).toBe('ineligible');
  expect(inputs.claim('other', ['input'], 'front')).toBe('ineligible');
  expect(inputs.claim('conversation', ['missing'], 'neo')).toBe('ineligible');
  expect(inputs.claim('conversation', [], 'neo')).toBe('ineligible');
});

test('fresh Neo tables support eligibility before migration replay', () => {
  const sql = new Sqlite(':memory:');
  try {
    createNeoTables(sql);
    const fresh = new NeoFrontInputRepository(sql);
    fresh.accept('conversation', 'input', false);
    expect(fresh.get('conversation', 'input')).toEqual({ eligible: false, owner: null });
  } finally {
    sql.close();
  }
});

const conversationId = '10000000-0000-4000-8000-000000000001';
const sessionId = `neo:${conversationId}`;
const requestId = '20000000-0000-4000-8000-000000000001';

async function intake(inputMode: 'text' | 'dictation' | 'live_voice' = 'text') {
  const message = neoIntakeMessage({
    sessionId,
    requestId,
    content: 'Original human words.',
    inputMode,
  });
  return new NeoConversationAskRepository(db.getDatabase()).acceptPrompt(
    conversationId,
    message,
    'manual',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
}

test('default-off intake stamps ineligible and schedules no front job', async () => {
  await db.createSession(createTestSession(sessionId));
  expect(await intake()).toMatchObject({ accepted: true, created: true });
  expect(inputs.get(conversationId, requestId)).toEqual({ eligible: false, owner: null });
  expect(db.getJobQueueRepo().listJobs({ queue: NEO_FRONT_INFERENCE })).toHaveLength(0);
});

test.each(['text', 'dictation', 'live_voice'] as const)(
  'eligible %s intake enqueues once without claiming ownership',
  async (inputMode) => {
    await db.createSession(createTestSession(sessionId));
    await db.updateGlobalSettings({ neo: { front: { enabled: true } } });
    expect(await intake(inputMode)).toMatchObject({ accepted: true, created: true });
    const jobs = db.getJobQueueRepo().listJobs({ queue: NEO_FRONT_INFERENCE });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ conversationId, messageId: requestId });
    await db.updateGlobalSettings({ neo: { front: { enabled: false } } });
    expect(await intake(inputMode)).toMatchObject({ accepted: true, created: false });
    expect(db.getJobQueueRepo().listJobs({ queue: NEO_FRONT_INFERENCE })).toHaveLength(1);
    expect(inputs.get(conversationId, requestId)).toEqual({ eligible: true, owner: null });
  }
);

test('migration 503 adds the catch-up range to an existing front input table', () => {
  const raw = new Sqlite(':memory:');
  raw.exec(`CREATE TABLE neo_front_inputs (
    conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
    eligible INTEGER NOT NULL, owner TEXT, PRIMARY KEY (conversation_id, message_id))`);
  raw.exec("INSERT INTO neo_front_inputs VALUES ('c', 'm', 1, NULL)");
  runMigration503(raw);
  runMigration503(raw);
  expect(raw.prepare('SELECT * FROM neo_front_inputs').get()).toEqual({
    conversation_id: 'c',
    message_id: 'm',
    eligible: 1,
    owner: null,
    catch_up_from: null,
    catch_up_through: null,
  });
  raw.close();
});

test('a front delivery with an invalid message records no range and no job', () => {
  inputs.accept('conversation', 'input', true);
  const entry = createMailboxEntry({
    to: { kind: 'session', sessionId: 'front' },
    origin: 'session:neo',
    messageUuid: 'input',
    message: { type: 'user', parent_tool_use_id: null, message: { content: 'Hello' } },
  });
  const invalid = {
    ...entry,
    message: { ...entry.message, message: { content: [{ type: 'text' as const, text: '' }] } },
  };
  expect(() => inputs.enqueueWithCatchUp('conversation', invalid)).toThrow();
  expect(db.getJobQueueRepo().listJobs({ queue: 'mailbox' })).toHaveLength(0);
  expect(
    db
      .getDatabase()
      .prepare('SELECT catch_up_through AS through FROM neo_front_inputs WHERE message_id = ?')
      .get('input')
  ).toEqual({ through: null });
});

test('migration 504 stores the owner earlier replies imply and keeps stored owners', () => {
  const raw = new Sqlite(':memory:');
  raw.exec(`CREATE TABLE neo_publications (sequence INTEGER PRIMARY KEY, conversation_id TEXT,
    publication_id TEXT, payload_json TEXT, created_at TEXT)`);
  raw.exec(`CREATE TABLE neo_front_inputs (conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
    eligible INTEGER NOT NULL, owner TEXT, PRIMARY KEY (conversation_id, message_id))`);
  const publish = raw.prepare(
    "INSERT INTO neo_publications (conversation_id, publication_id, payload_json, created_at) VALUES ('c', ?, ?, '')"
  );
  publish.run('1', JSON.stringify({ replyTo: ['reply'] }));
  publish.run('2', JSON.stringify({ cardReply: { sourceMessageIds: ['card'] } }));
  publish.run('3', JSON.stringify({ producerInput: { messageId: 'edited' }, revisionId: 'r' }));
  publish.run('4', JSON.stringify({ replyTo: ['front'] }));
  for (const [id, owner] of [
    ['reply', null],
    ['card', null],
    ['edited', null],
    ['open', null],
    ['front', 'front'],
  ])
    raw.prepare("INSERT INTO neo_front_inputs VALUES ('c', ?, 1, ?)").run(id, owner);
  runMigration504(raw);
  runMigration504(raw);
  expect(
    raw.prepare('SELECT message_id AS id, owner FROM neo_front_inputs ORDER BY message_id').all()
  ).toEqual([
    { id: 'card', owner: 'neo' },
    { id: 'edited', owner: 'neo' },
    { id: 'front', owner: 'front' },
    { id: 'open', owner: null },
    { id: 'reply', owner: 'neo' },
  ]);
  raw.close();
});

test('a hand-off reserves its inputs and enqueues the human message together, or neither', async () => {
  await db.createSession(createTestSession(sessionId));
  inputs.accept('conversation', 'handed', true);
  const message = (uuid: string) =>
    ({
      type: 'user',
      uuid,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Check the build.' },
    }) as never;
  expect(() =>
    inputs.reserve(
      'conversation',
      ['handed'],
      [{ sessionId: 'missing-session', message: message('a') }]
    )
  ).toThrow();
  expect(inputs.get('conversation', 'handed')?.owner).toBeNull();
  const uuid = crypto.randomUUID();
  expect(inputs.reserve('conversation', ['handed'], [{ sessionId, message: message(uuid) }])).toBe(
    true
  );
  expect(inputs.get('conversation', 'handed')?.owner).toBe('neo');
  expect(db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(sessionId, [uuid])).toHaveLength(1);
  expect(inputs.reserve('conversation', ['handed'], [])).toBe(false);
  expect(inputs.claim('conversation', ['handed'], 'front')).toBe('handed_off');
});
