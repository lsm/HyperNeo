import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { runMigration248 } from '../../../../src/storage/schema/m248-direct-task-execution';
import { createSpaceTables } from '../../helpers/space-test-db';

let directory: string;
let db: Database;
let peer: Database;
let repo: DirectTaskExecutionRepository;
let other: DirectTaskExecutionRepository;
let tasks: SpaceTaskRepository;
let taskId: string;
let spaceId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'direct-attempt-'));
  db = new Database(join(directory, 'test.db'));
  createSpaceTables(db);
  runMigration248(db);
  peer = new Database(join(directory, 'test.db'));
  peer.exec('PRAGMA foreign_keys = ON');
  repo = new DirectTaskExecutionRepository(db);
  other = new DirectTaskExecutionRepository(peer);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
});
afterEach(() => {
  peer.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('existing tasks remain unselected and migration reruns preserve attempt history', () => {
  expect(repo.isSelected(taskId)).toBe(false);
  expect(repo.claim(taskId, 'attempt', 'session')).toBeNull();
  expect(repo.select(taskId)).toBe(true);
  expect(repo.select(taskId)).toBe(true);
  const claimed = repo.claim(taskId, 'attempt', 'session');
  runMigration248(db);
  expect(other.get('attempt')).toEqual(claimed);
  expect(tasks.getTask(taskId)).toMatchObject({ status: 'open', workflowRunId: null });
});

test('concurrent processes compete for exactly one reservation', async () => {
  repo.select(taskId);
  const storage = new URL('../../../../src/storage/', import.meta.url);
  const clients = [0, 1].map((i) => {
    const script = `
      import { Database } from ${JSON.stringify(new URL('sqlite-compat.ts', storage).href)};
      import { DirectTaskExecutionRepository } from ${JSON.stringify(new URL('repositories/direct-task-execution-repository.ts', storage).href)};
      const db = new Database(${JSON.stringify(join(directory, 'test.db'))});
      db.exec('PRAGMA busy_timeout = 5000');
      const repo = new DirectTaskExecutionRepository(db);
      const attempt = repo.claim(${JSON.stringify(taskId)}, 'attempt-${i}', 'session-${i}');
      console.log(JSON.stringify(attempt));
      db.close();
    `;
    return Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
  });
  const claims = await Promise.all(
    clients.map(async (client) => {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(client.stdout).text(),
        new Response(client.stderr).text(),
        client.exited,
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
      return JSON.parse(stdout);
    })
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  const winner = claims.find(Boolean)!;
  expect(repo.getActive(taskId)).toEqual(winner);
  expect(other.getActive(taskId)).toEqual(winner);
  expect(other.claim(taskId, winner.id, winner.sessionId)).toEqual(winner);
  expect(other.claim(taskId, winner.id, 'wrong-session')).toBeNull();
  expect(repo.claim(taskId, 'new-attempt', winner.sessionId)).toBeNull();
});

test('activation and stop fence stale writers and next attempts increase generation', () => {
  repo.select(taskId);
  expect(repo.claim(taskId, 'first', 'session-1')?.generation).toBe(1);
  expect(other.activate('first', 'wrong-session')).toBeNull();
  expect(repo.activate('first', 'session-1')?.phase).toBe('running');
  expect(other.activate('first', 'session-1')).toBeNull();
  expect(other.claim(taskId, 'first', 'session-1')?.phase).toBe('running');
  expect(repo.stop('first', 'session-1', 'cancelled')?.outcome).toBe('cancelled');
  expect(repo.getActive(taskId)).toBeNull();
  const second = other.claim(taskId, 'second', 'session-2');
  expect(second).toMatchObject({ generation: 2, phase: 'reserved' });
  expect(repo.activate('first', 'session-1')).toBeNull();
  expect(repo.stop('first', 'session-1', 'late-success')).toBeNull();
  expect(repo.claim(taskId, 'first', 'session-1')).toBeNull();
  expect(repo.getActive(taskId)).toEqual(second);
  expect(repo.get('first')?.outcome).toBe('cancelled');
});

test('reservation can stop before activation and session identities cannot be reused', () => {
  repo.select(taskId);
  repo.claim(taskId, 'first', 'session');
  expect(repo.stop('first', 'session', 'spawn_failed')?.phase).toBe('stopped');
  expect(repo.claim(taskId, 'second', 'session')).toBeNull();
  expect(repo.claim(taskId, 'second', 'new-session')?.generation).toBe(2);
  const another = tasks.createTask({ spaceId, title: 'Other', description: '' }).id;
  repo.select(another);
  expect(repo.claim(another, 'second', 'new-session')).toBeNull();
  expect(repo.claim(another, 'third', 'new-session')).toBeNull();
  expect(repo.getActive(another)).toBeNull();
});

test.each(['draft', 'in_progress', 'review', 'done', 'archived'] as const)(
  'claims reject non-open task status %s',
  (status) => {
    repo.select(taskId);
    tasks.updateTask(taskId, { status });
    expect(repo.claim(taskId, 'attempt', 'session')).toBeNull();
    expect(repo.getActive(taskId)).toBeNull();
  }
);

test('missing, non-Space and workflow-attached targets cannot opt in or claim', () => {
  expect(repo.select('missing')).toBe(false);
  db.prepare('UPDATE space_tasks SET space_id = NULL WHERE id = ?').run(taskId);
  expect(repo.select(taskId)).toBe(false);
  db.prepare('UPDATE space_tasks SET space_id = ? WHERE id = ?').run(spaceId, taskId);
  repo.select(taskId);
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('UPDATE space_tasks SET workflow_run_id = ? WHERE id = ?').run('run', taskId);
  expect(repo.claim(taskId, 'attempt', 'session')).toBeNull();
  expect(repo.getActive(taskId)).toBeNull();
});

test('database uniqueness protects direct SQL writers and task deletion cascades', () => {
  repo.select(taskId);
  repo.claim(taskId, 'first', 'session');
  expect(() =>
    peer
      .prepare(`INSERT INTO direct_task_execution_attempts
    (id,task_id,generation,session_id,phase,created_at,updated_at)
    VALUES ('second',?,2,'second-session','reserved',1,1)`)
      .run(taskId)
  ).toThrow();
  db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
  expect(repo.isSelected(taskId)).toBe(false);
  expect(other.get('first')).toBeNull();
});
