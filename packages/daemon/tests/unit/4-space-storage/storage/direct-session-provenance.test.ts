import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { runMigration251 } from '../../../../src/storage/schema/m251-direct-session-provenance';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let attempts: DirectTaskExecutionRepository;
let tasks: SpaceTaskRepository;
let spaceId: string;
let taskId: string;
beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  attempts = new DirectTaskExecutionRepository(db);
  attempts.select(taskId);
});
afterEach(() => db.close());

test.each(['task', 'space'] as const)(
  'provenance survives %s deletion without owning a surviving session',
  (owner) => {
    const sessions = new SessionRepository(db);
    sessions.createSession(
      { ...createTestSession('worker'), context: { spaceId, taskId } },
      { enforceWorkspaceOwnership: false }
    );
    expect(attempts.claim(taskId, 'attempt', 'worker')).not.toBeNull();
    const claimed = attempts.get('attempt');
    expect(attempts.claim(taskId, 'attempt', 'worker')).toEqual(claimed);
    if (owner === 'task') db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
    else db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
    expect(sessions.getSession('worker')?.status).toBe('active');
    expect(attempts.get('attempt')).toBeNull();
    expect(attempts.getActive(taskId)).toBeNull();
    expect(attempts.hasSessionProvenance('worker')).toBe(true);
    expect(attempts.activate('attempt', 'worker')).toBeNull();
    expect(attempts.hasSessionProvenance('ordinary')).toBe(false);
  }
);

test('failed claims and transaction rollback do not create provenance', () => {
  expect(attempts.claim('missing', 'missing', 'missing-session')).toBeNull();
  expect(attempts.hasSessionProvenance('missing-session')).toBe(false);
  db.exec('BEGIN');
  expect(attempts.claim(taskId, 'rolled-back', 'rolled-back-session')).not.toBeNull();
  expect(attempts.hasSessionProvenance('rolled-back-session')).toBe(true);
  db.exec('ROLLBACK');
  expect(attempts.hasSessionProvenance('rolled-back-session')).toBe(false);
  expect(attempts.get('rolled-back')).toBeNull();
  expect(attempts.claim(taskId, 'winner', 'winner-session')).not.toBeNull();
  expect(attempts.claim(taskId, 'loser', 'loser-session')).toBeNull();
  expect(attempts.hasSessionProvenance('loser-session')).toBe(false);
});

test('session identities cannot be reused after attempt cascade or mutated by SQL writers', () => {
  attempts.claim(taskId, 'first', 'worker');
  expect(() =>
    db
      .prepare('UPDATE direct_task_execution_attempts SET session_id = ? WHERE id = ?')
      .run('changed', 'first')
  ).toThrow('immutable');
  db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
  const next = tasks.createTask({ spaceId, title: 'Next', description: '' }).id;
  attempts.select(next);
  expect(attempts.claim(next, 'second', 'worker')).toBeNull();
  expect(attempts.getActive(next)).toBeNull();
  expect(attempts.claim(next, 'third', 'new-worker')).not.toBeNull();
  expect(attempts.hasSessionProvenance('new-worker')).toBe(true);
});

test('migration backfills existing stopped claims and preserves provenance when rerun', () => {
  db.exec(`DROP TRIGGER direct_task_session_no_reuse;
    DROP TRIGGER direct_task_session_record_provenance;
    DROP TRIGGER direct_task_session_identity_immutable;
    DROP TABLE direct_task_session_provenance;`);
  attempts.claim(taskId, 'historical', 'historical-session');
  attempts.stop('historical', 'historical-session', 'cancelled');
  runMigration251(db);
  expect(attempts.hasSessionProvenance('historical-session')).toBe(true);
  db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
  runMigration251(db);
  expect(attempts.hasSessionProvenance('historical-session')).toBe(true);
});
