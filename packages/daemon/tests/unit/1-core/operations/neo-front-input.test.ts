import { NEO_FRONT_INFERENCE } from '../../../../src/lib/job-queue-constants.ts';
import { createFakeNeoFrontHandler } from '../../../../src/lib/neo/front-job.ts';
import { neoIntakeMessage } from '../../../../src/lib/neo/intake.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoFrontInputRepository } from '../../../../src/storage/repositories/neo-front-input-worker.ts';

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

test('front and Neo contend for the same durable input and a replay cannot take ownership', () => {
  inputs.accept('conversation', 'input', true);
  expect(inputs.claim('conversation', ['input'], 'front')).toBe(true);
  expect(inputs.claim('conversation', ['input'], 'neo')).toBe(false);
  expect(inputs.claim('conversation', ['input'], 'front')).toBe(false);
});

test('a mixed batch does not partially claim when one message already belongs to the front', () => {
  inputs.accept('conversation', 'first', true);
  inputs.accept('conversation', 'second', true);
  inputs.claim('conversation', ['first'], 'front');
  expect(inputs.claim('conversation', ['first', 'second'], 'neo')).toBe(false);
  expect(inputs.get('conversation', 'second')?.owner).toBe(null);
});

test('missing, cross-conversation and disabled inputs cannot be claimed', () => {
  inputs.accept('conversation', 'input', false);
  expect(inputs.claim('conversation', ['input'], 'front')).toBe(false);
  expect(inputs.claim('other', ['input'], 'front')).toBe(false);
  expect(inputs.claim('conversation', ['missing'], 'neo')).toBe(false);
  expect(inputs.claim('conversation', [], 'neo')).toBe(false);
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
  'eligible %s intake enqueues once and the fake front hands off through the gateway',
  async (inputMode) => {
    await db.createSession(createTestSession(sessionId));
    await db.updateGlobalSettings({ neo: { front: { enabled: true } } });
    expect(await intake(inputMode)).toMatchObject({ accepted: true, created: true });
    const jobs = db.getJobQueueRepo().listJobs({ queue: NEO_FRONT_INFERENCE });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ conversationId, messageId: requestId });
    expect(await createFakeNeoFrontHandler(db.gateway)(jobs[0])).toEqual({ handedOff: true });
    expect(inputs.get(conversationId, requestId)).toEqual({ eligible: true, owner: 'neo' });
    expect(await createFakeNeoFrontHandler(db.gateway)(jobs[0])).toEqual({ handedOff: false });
    await db.updateGlobalSettings({ neo: { front: { enabled: false } } });
    expect(await intake(inputMode)).toMatchObject({ accepted: true, created: false });
    expect(db.getJobQueueRepo().listJobs({ queue: NEO_FRONT_INFERENCE })).toHaveLength(1);
    expect(inputs.get(conversationId, requestId)).toEqual({ eligible: true, owner: 'neo' });
  }
);
