import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { runMigration258 } from '../../../../src/storage/schema/m258-direct-process-ownership';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  DirectProcessOwnershipRepository,
  type DirectProcessLaunch,
} from '../../../../src/storage/repositories/direct-process-ownership-repository';
import { decideDirectGuardianTransition } from '../../../../src/lib/space/runtime/direct-guardian-protocol';

let dir: string;
let db: Database;
let ledger: DirectProcessOwnershipRepository;
let attempts: DirectTaskExecutionRepository;
let taskId: string;
const identity = { attemptId: 'attempt', sessionId: 'worker', generation: 1 };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'direct-owner-'));
  db = new Database(join(dir, 'db.sqlite'));
  runMigrations(db, () => {});
  createTables(db);
  ledger = new DirectProcessOwnershipRepository(db);
  const spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: dir,
  }).id;
  taskId = new SpaceTaskRepository(db).createTask({ spaceId, title: 'Task', description: '' }).id;
  attempts = new DirectTaskExecutionRepository(db);
  attempts.select(taskId);
  attempts.claim(taskId, 'attempt', 'worker');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function ownedLaunch(): DirectProcessLaunch {
  const launch = ledger.reserveLaunch(identity)!;
  expect(ledger.claimGuardian(launch, 'test-owner')).toBe(true);
  return launch;
}

function managedLaunch(): DirectProcessLaunch {
  expect(ledger.manageAttempt(identity)).toBe(true);
  expect(attempts.activate('attempt', 'worker')?.phase).toBe('running');
  return ownedLaunch();
}

test('coverage is opt-in before execution and zero launch rows do not imply managed ownership', () => {
  expect(ledger.hasCoverage(identity)).toBe(false);
  expect(ledger.listLaunches(identity)).toEqual([]);
  expect(ledger.reserveLaunch(identity)).toBeNull();
  attempts.activate('attempt', 'worker');
  expect(ledger.manageAttempt(identity)).toBe(false);
  expect(ledger.reserveLaunch(identity)).toBeNull();
});

test('coverage and launch reservation require exact identity and reject stop fences', () => {
  expect(ledger.manageAttempt({ ...identity, generation: 2 })).toBe(false);
  expect(ledger.manageAttempt({ ...identity, sessionId: 'other' })).toBe(false);
  attempts.requestStop('attempt', 'worker', 'cancelled');
  expect(ledger.manageAttempt(identity)).toBe(false);
});

test('authorization is committed once and a stop fence prevents new reservations and authorizations', () => {
  const first = managedLaunch();
  const second = ownedLaunch();
  expect(first.id).not.toBe(second.id);
  expect(first.token).not.toBe(second.token);
  expect(ledger.authorizeLaunch(first)).toBe(true);
  expect(ledger.authorizeLaunch(first)).toBe(false);
  attempts.requestStop('attempt', 'worker', 'cancelled');
  expect(ledger.reserveLaunch(identity)).toBeNull();
  expect(ledger.authorizeLaunch(second)).toBe(false);
  expect(ledger.get(first)?.state).toBe('authorized');
  expect(ledger.get(second)?.state).toBe('reserved');
});

for (const field of ['id', 'token', 'attemptId', 'sessionId', 'generation'] as const) {
  test(`authorization and terminal receipts reject mismatched ${field}`, () => {
    const launch = managedLaunch();
    const changed = { ...launch, [field]: field === 'generation' ? 2 : 'wrong' };
    expect(ledger.authorizeLaunch(changed)).toBe(false);
    expect(ledger.authorizeLaunch(launch)).toBe(true);
    expect(ledger.recordGuardianTerminal(changed, 'test-owner', 'exited')).toBe(false);
    expect(ledger.get(launch)?.state).toBe('authorized');
  });
}

test('all launch receipts survive reopening and deleting their attempt, without hiding older unknown launches', () => {
  const unknown = managedLaunch();
  const exited = ownedLaunch();
  ledger.authorizeLaunch(unknown);
  ledger.authorizeLaunch(exited);
  expect(ledger.recordGuardianTerminal(exited, 'test-owner', 'exited')).toBe(true);
  db.close();
  db = new Database(join(dir, 'db.sqlite'));
  ledger = new DirectProcessOwnershipRepository(db);
  runMigration258(db);
  runMigration258(db);
  expect(ledger.hasCoverage(identity)).toBe(true);
  expect(ledger.get(unknown)?.state).toBe('authorized');
  expect(ledger.get(exited)?.state).toBe('exited');
  expect(ledger.listLaunches(identity)).toHaveLength(2);
  db.prepare('DELETE FROM direct_task_execution_attempts WHERE id = ?').run('attempt');
  expect(ledger.hasCoverage(identity)).toBe(true);
  expect(ledger.listLaunches(identity)).toHaveLength(2);
  expect(ledger.reserveLaunch(identity)).toBeNull();
});

test('terminal attestation is idempotent but cannot change or authorize a terminal launch', () => {
  const beforeGo = managedLaunch();
  expect(ledger.recordGuardianTerminal(beforeGo, 'test-owner', 'exited')).toBe(false);
  expect(ledger.recordGuardianTerminal(beforeGo, 'test-owner', 'never_started')).toBe(true);
  expect(ledger.recordGuardianTerminal(beforeGo, 'test-owner', 'never_started')).toBe(true);
  expect(ledger.authorizeLaunch(beforeGo)).toBe(false);
  expect(ledger.recordGuardianTerminal(beforeGo, 'test-owner', 'exited')).toBe(false);
  const lostGo = ownedLaunch();
  ledger.authorizeLaunch(lostGo);
  expect(ledger.get(lostGo)?.state).toBe('authorized');
  expect(ledger.recordGuardianTerminal(lostGo, 'test-owner', 'never_started')).toBe(true);
  const exited = ownedLaunch();
  ledger.authorizeLaunch(exited);
  expect(ledger.recordGuardianTerminal(exited, 'test-owner', 'exited')).toBe(true);
  expect(ledger.recordGuardianTerminal(exited, 'test-owner', 'exited')).toBe(true);
  expect(ledger.recordGuardianTerminal(exited, 'test-owner', 'never_started')).toBe(false);
});

test('failed authorization transaction never leaves an authorized launch', () => {
  const launch = managedLaunch();
  expect(() =>
    db.transaction(() => {
      expect(ledger.authorizeLaunch(launch)).toBe(true);
      throw new Error('commit failed');
    }, 'immediate')()
  ).toThrow('commit failed');
  expect(ledger.get(launch)?.state).toBe('reserved');
});

test('guardian GO requires its exact durable authorization and is admitted only once', () => {
  const launch = managedLaunch();
  const go = (authorization: DirectProcessLaunch) => ({ kind: 'go' as const, authorization });
  expect(decideDirectGuardianTransition(launch, 'waiting', go(launch))).toEqual({
    state: 'waiting',
    action: 'none',
  });
  ledger.authorizeLaunch(launch);
  const authorized = ledger.get(launch)!;
  for (const field of ['id', 'token', 'attemptId', 'sessionId', 'generation'] as const) {
    expect(
      decideDirectGuardianTransition(
        launch,
        'waiting',
        go({ ...authorized, [field]: field === 'generation' ? 2 : 'wrong' })
      ).action
    ).toBe('none');
  }
  expect(decideDirectGuardianTransition(launch, 'waiting', go(authorized))).toEqual({
    state: 'launching',
    action: 'spawn',
  });
  for (const state of ['launching', 'running', 'stopping_launch', 'stopping', 'terminal'] as const)
    expect(decideDirectGuardianTransition(launch, state, go(authorized)).action).toBe('none');
});

test('parent death before GO attests no launch; after GO only actual SDK exit permits an exit receipt', () => {
  const launch = managedLaunch();
  expect(decideDirectGuardianTransition(launch, 'waiting', { kind: 'parent_closed' })).toEqual({
    state: 'terminal',
    action: 'record_never_started',
  });
  expect(decideDirectGuardianTransition(launch, 'running', { kind: 'parent_closed' })).toEqual({
    state: 'stopping',
    action: 'stop',
  });
  expect(decideDirectGuardianTransition(launch, 'stopping', { kind: 'parent_closed' })).toEqual({
    state: 'stopping',
    action: 'none',
  });
  expect(decideDirectGuardianTransition(launch, 'stopping', { kind: 'sdk_exited' })).toEqual({
    state: 'terminal',
    action: 'record_exited',
  });
  expect(decideDirectGuardianTransition(launch, 'launching', { kind: 'spawn_failed' })).toEqual({
    state: 'terminal',
    action: 'record_never_started',
  });
  expect(decideDirectGuardianTransition(launch, 'waiting', { kind: 'sdk_exited' }).action).toBe(
    'none'
  );
  expect(decideDirectGuardianTransition(launch, 'terminal', { kind: 'sdk_exited' }).action).toBe(
    'none'
  );
});

test('parent loss during spawn cannot turn a later live SDK into never-started proof', () => {
  const launch = managedLaunch();
  for (const state of ['launching', 'stopping_launch'] as const)
    expect(decideDirectGuardianTransition(launch, state, { kind: 'sdk_exited' })).toEqual({
      state: 'terminal',
      action: 'record_exited',
    });
  expect(decideDirectGuardianTransition(launch, 'launching', { kind: 'parent_closed' })).toEqual({
    state: 'stopping_launch',
    action: 'stop',
  });
  expect(
    decideDirectGuardianTransition(launch, 'stopping_launch', { kind: 'sdk_started' })
  ).toEqual({ state: 'stopping', action: 'stop' });
  expect(decideDirectGuardianTransition(launch, 'launching', { kind: 'sdk_started' })).toEqual({
    state: 'running',
    action: 'none',
  });
  for (const state of ['running', 'stopping'] as const)
    expect(decideDirectGuardianTransition(launch, state, { kind: 'spawn_failed' }).action).toBe(
      'none'
    );
  expect(
    decideDirectGuardianTransition(launch, 'stopping_launch', { kind: 'spawn_failed' })
  ).toEqual({ state: 'terminal', action: 'record_never_started' });
});

test('only one guardian claims a launch and only its receipts are accepted', () => {
  ledger.manageAttempt(identity);
  attempts.activate('attempt', 'worker');
  const launch = ledger.reserveLaunch(identity)!;
  expect(ledger.authorizeLaunch(launch)).toBe(false);
  expect(ledger.claimGuardian(launch, '')).toBe(false);
  expect(ledger.claimGuardian(launch, 'first')).toBe(true);
  expect(ledger.claimGuardian(launch, 'first')).toBe(false);
  expect(ledger.claimGuardian(launch, 'second')).toBe(false);
  expect(ledger.authorizeLaunch(launch)).toBe(true);
  expect(ledger.recordGuardianTerminal(launch, 'second', 'exited')).toBe(false);
  expect(ledger.recordGuardianTerminal(launch, 'first', 'exited')).toBe(true);
  expect(ledger.recordGuardianTerminal(launch, 'second', 'exited')).toBe(false);
});
