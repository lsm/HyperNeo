import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  createDirectKickoffRecorder,
  readDirectKickoffIntent,
  requireDirectKickoffClaim,
  type DirectKickoffInput,
} from '../../../../src/lib/space/runtime/direct-kickoff-intent';
import { parseMailboxEntry } from '../../../../src/lib/mailbox/entry';
import { runMigration252 } from '../../../../src/storage/schema/m252-direct-kickoff-intents';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let peer: Database;
let directory: string;
let attempts: DirectTaskExecutionRepository;
let tasks: SpaceTaskRepository;
let taskId: string;
const input: DirectKickoffInput = {
  attemptId: 'attempt',
  sessionId: 'worker',
  message: {
    type: 'user',
    message: { role: 'user', content: 'Perform the captured task' },
    parent_tool_use_id: null,
    inputKind: 'task',
  },
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'direct-kickoff-'));
  db = new Database(join(directory, 'test.db'));
  createSpaceTables(db);
  peer = new Database(join(directory, 'test.db'));
  const space = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  });
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId: space.id, title: 'Task', description: '' }).id;
  attempts = new DirectTaskExecutionRepository(db);
  attempts.select(taskId);
  attempts.claim(taskId, 'attempt', 'worker');
});
afterEach(() => {
  peer.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('inert factory persists one validated entry with stable identity across connections and restart', () => {
  const record = createDirectKickoffRecorder(db);
  expect(readDirectKickoffIntent(db, 'attempt')).toBeNull();
  const first = record(input);
  expect(first.recorded).toBe(true);
  if (!first.recorded) throw new Error('expected recorded intent');
  expect(parseMailboxEntry(first.entry)).toEqual(first.entry);
  expect(first.entry.to).toEqual({ kind: 'session', sessionId: 'worker' });
  expect(first.entry.messageUuid).toBeTruthy();
  expect(createDirectKickoffRecorder(peer)(input)).toEqual(first);
  db.close();
  db = new Database(join(directory, 'test.db'));
  expect(createDirectKickoffRecorder(db)(input)).toEqual(first);
  expect(db.prepare('SELECT COUNT(*) AS count FROM direct_task_kickoff_intents').get()).toEqual({
    count: 1,
  });
  runMigration252(db);
  expect(readDirectKickoffIntent(db, 'attempt')).toEqual(first.entry);
});

test('content change cannot replace frozen entry, message UUID, priority or TTL', () => {
  const record = createDirectKickoffRecorder(db);
  const first = record(input);
  const changed = {
    ...input,
    message: { ...input.message, message: { content: 'Different task' } },
  };
  expect(record(changed)).toEqual({ recorded: false, reason: 'content_conflict' });
  expect(record({ ...input, message: { ...input.message, priority: 'now' } })).toHaveProperty(
    'reason',
    'content_conflict'
  );
  expect(record(input)).toEqual(first);
});

test.each(['stop-requested', 'running', 'stopped', 'wrong-session', 'missing'] as const)(
  'rejects %s claim before persisting an intent',
  (state) => {
    if (state === 'stop-requested') attempts.requestStop('attempt', 'worker', 'cancelled');
    if (state === 'running') attempts.activate('attempt', 'worker');
    if (state === 'stopped') attempts.stop('attempt', 'worker', 'cancelled');
    const target =
      state === 'wrong-session'
        ? { ...input, sessionId: 'other' }
        : state === 'missing'
          ? { ...input, attemptId: 'missing' }
          : input;
    expect(createDirectKickoffRecorder(db)(target)).toEqual({
      recorded: false,
      reason: 'unavailable',
    });
    expect(readDirectKickoffIntent(db, 'attempt')).toBeNull();
  }
);

test('pure claim gate rejects stale generation and stop fences', () => {
  const attempt = attempts.get('attempt')!;
  expect(requireDirectKickoffClaim(attempt, attempt, false, input)).toBe(true);
  expect(requireDirectKickoffClaim(attempt, { ...attempt, generation: 99 }, false, input)).toBe(
    false
  );
  expect(requireDirectKickoffClaim(attempt, attempt, true, input)).toBe(false);
});

test('invalid message creates no partial row and later valid request succeeds', () => {
  const record = createDirectKickoffRecorder(db);
  expect(record({ ...input, message: { ...input.message, message: { content: '' } } })).toEqual({
    recorded: false,
    reason: 'invalid_message',
  });
  expect(readDirectKickoffIntent(db, 'attempt')).toBeNull();
  expect(record(input)).toHaveProperty('recorded', true);
});

test('running recovery reads frozen content while missing running content is never invented', () => {
  const first = createDirectKickoffRecorder(db)(input);
  if (!first.recorded) throw new Error('expected recorded intent');
  tasks.updateTask(taskId, { description: 'Edited after capture' });
  attempts.activate('attempt', 'worker');
  expect(readDirectKickoffIntent(peer, 'attempt')).toEqual(first.entry);
  expect(createDirectKickoffRecorder(db)(input)).toHaveProperty('reason', 'unavailable');
  attempts.stop('attempt', 'worker', 'finished');
  attempts.claim(taskId, 'next', 'next-worker');
  attempts.activate('next', 'next-worker');
  expect(
    createDirectKickoffRecorder(db)({ ...input, attemptId: 'next', sessionId: 'next-worker' })
  ).toHaveProperty('reason', 'unavailable');
  expect(readDirectKickoffIntent(db, 'next')).toBeNull();
  expect(readDirectKickoffIntent(db, 'attempt')).toEqual(first.entry);
});

test('failed storage write leaves no intent and no attempt phase change', () => {
  db.exec(
    "CREATE TRIGGER fail_intent BEFORE INSERT ON direct_task_kickoff_intents BEGIN SELECT RAISE(ABORT, 'intent failure'); END"
  );
  expect(() => createDirectKickoffRecorder(db)(input)).toThrow('intent failure');
  expect(readDirectKickoffIntent(db, 'attempt')).toBeNull();
  expect(attempts.get('attempt')?.phase).toBe('reserved');
});
