import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let store: NeoAskTodoRepository;
const session = 'neo:10000000-0000-4000-8000-000000000002';
const socket = join(tmpdir(), 'synthetic-agent.sock');
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession(session));
  store = new NeoAskTodoRepository(db.getDatabase());
});
afterEach(() => db.close());

const request = () => store.requestWorkerSocket(session, socket)!;

test('a socket request raises exactly one card across repository re-creation', () => {
  const question = request();
  expect(question.text).toContain(socket);
  expect(question.text).toContain('restart a worker that is already running');
  store = new NeoAskTodoRepository(db.getDatabase());
  expect(request().id).toBe(question.id);
});

test.each(['yes', 'no'] as const)('human %s persists without asking again', (answer) => {
  const question = request();
  store.answerQuestion(question, answer, 'button', Date.now());
  expect(db.getGlobalSettings().workerUnixSockets ?? []).toEqual(answer === 'yes' ? [socket] : []);
  store = new NeoAskTodoRepository(db.getDatabase());
  expect(request().state).toBe('answered');
  if (answer === 'yes') {
    db.updateGlobalSettings({ workerUnixSockets: [] });
    expect(request().state).toBe('open');
    expect(db.getGlobalSettings().workerUnixSockets).toEqual([]);
    expect(request().id).toBe(question.id);
    store.answerQuestion(request(), 'yes', 'button', Date.now());
    expect(db.getGlobalSettings().workerUnixSockets).toEqual([socket]);
  }
});

test('approval shows bidirectional controls as visible escapes', () => {
  const path = join(tmpdir(), 'agent-\u202e.sock');
  const question = store.requestWorkerSocket(session, path)!;
  expect(question.text).not.toContain('\u202e');
  expect(question.text).toContain('\\u202e');
});
