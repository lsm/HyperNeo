import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  stampActiveAttempt,
  stampActiveAttempts,
} from '../../../../src/lib/tasks/direct-attempt-flag';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let tasks: SpaceTaskRepository;
let attempts: DirectTaskExecutionRepository;
let spaceId: string;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  tasks = new SpaceTaskRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
});
afterEach(() => db.close());

function createTask(title: string) {
  return tasks.createTask({ spaceId, title, status: 'open' });
}

function claimAttempt(taskId: string, sessionId: string) {
  attempts.select(taskId);
  return attempts.claim(taskId, `attempt-${taskId}`, sessionId);
}

test('stampActiveAttempt reports false with no attempt', () => {
  const task = createTask('one');
  expect(stampActiveAttempt(db, task)).toMatchObject({ hasActiveDirectAttempt: false });
});

test('stampActiveAttempt reports true while an attempt is live', () => {
  const task = createTask('one');
  claimAttempt(task.id, 'session-1');
  expect(stampActiveAttempt(db, task)).toMatchObject({ hasActiveDirectAttempt: true });
});

test('stampActiveAttempt passes null through', () => {
  expect(stampActiveAttempt(db, null)).toBeNull();
});

test('stampActiveAttempts marks only the tasks with live attempts', () => {
  const live = createTask('live');
  const idle = createTask('idle');
  claimAttempt(live.id, 'session-1');
  const page = stampActiveAttempts(db, { tasks: [live, idle], total: 2, nextCursor: null });
  expect(page.tasks.map((t) => [t.id, t.hasActiveDirectAttempt])).toEqual([
    [live.id, true],
    [idle.id, false],
  ]);
});

test('stampActiveAttempts leaves an empty page alone', () => {
  const page = { tasks: [], total: 0, nextCursor: null };
  expect(stampActiveAttempts(db, page)).toBe(page);
});

test('getActiveTaskIds returns an empty set for no ids', () => {
  expect(attempts.getActiveTaskIds([]).size).toBe(0);
});

test('a standalone task is left unstamped, since it cannot hold an attempt', () => {
  const standalone = createStandaloneTask(db, { title: 'Loose' }, undefined, () => {});
  expect(stampActiveAttempt(db, standalone)).toBe(standalone);
  const page = { tasks: [standalone], total: 1, nextCursor: null };
  expect(stampActiveAttempts(db, page)).toBe(page);
});

test('a reserved attempt already counts as live, before activation', () => {
  const task = createTask('reserving');
  attempts.select(task.id);
  attempts.claim(task.id, `attempt-${task.id}`, 'session-1');
  expect(attempts.get(`attempt-${task.id}`)?.phase).toBe('reserved');
  expect(stampActiveAttempt(db, task)).toMatchObject({ hasActiveDirectAttempt: true });
});
