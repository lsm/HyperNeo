import { decodeUlidTimestamp } from '../../../../src/lib/mailbox/ulid';
import { mailboxEntryExpired } from '../../../../src/lib/mailbox/entry';
import {
  createDirectKickoffRecorder,
  readDirectKickoffIntent,
} from '../../../../src/lib/space/runtime/direct-kickoff-intent';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  createDirectAttemptActivator,
  requireDirectActivation,
} from '../../../../src/lib/space/runtime/activate-direct-attempt';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let spaces: SpaceRepository;
let attempts: DirectTaskExecutionRepository;
let spaceId: string;
let taskId: string;
const input = { attemptId: 'attempt', sessionId: 'worker' };
function activate() {
  return createDirectAttemptActivator({ db })(input);
}
beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaces = new SpaceRepository(db);
  spaceId = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' }).id;
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  attempts.select(taskId);
  attempts.claim(taskId, 'attempt', 'worker');
  createDirectKickoffRecorder(db)({
    ...input,
    message: { type: 'user', message: { content: 'Frozen kickoff' }, parent_tool_use_id: null },
  });
  sessions.createSession(
    {
      ...createTestSession('worker'),
      type: 'worker',
      workspacePath: '/repo',
      context: { spaceId, taskId },
    },
    { enforceWorkspaceOwnership: false }
  );
});
afterEach(() => db.close());

test('factory is inert and activation preserves repository timestamps and full task fields', () => {
  const start = createDirectAttemptActivator({ db });
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(attempts.get('attempt')?.phase).toBe('reserved');
  const result = start(input);
  expect(result).toMatchObject({
    activated: true,
    task: { id: taskId, status: 'in_progress', taskAgentSessionId: 'worker', title: 'Task' },
    attempt: { phase: 'running' },
  });
  expect(tasks.getTask(taskId)?.startedAt).toBeGreaterThan(0);
  expect(tasks.getTask(taskId)?.completedAt).toBeNull();
  expect(start(input)).toEqual({ activated: false, reason: 'unavailable' });
});

test.each(['cancelled', 'archived', 'stopped', 'space-archived', 'stop-requested'] as const)(
  'current %s state rejects activation without changing claim or session pointer',
  (state) => {
    if (state === 'space-archived')
      db.prepare("UPDATE spaces SET status = 'archived' WHERE id = ?").run(spaceId);
    else if (state === 'stop-requested') attempts.requestStop('attempt', 'worker', 'cancelled');
    else tasks.updateTask(taskId, { status: state });
    expect(activate()).toEqual({ activated: false, reason: 'unavailable' });
    expect(attempts.get('attempt')?.phase).toBe('reserved');
    expect(tasks.getTask(taskId)?.taskAgentSessionId).toBeFalsy();
  }
);

test('stale caller cannot activate its successor or another session', () => {
  attempts.stop('attempt', 'worker', 'cancelled');
  attempts.claim(taskId, 'next', 'next-worker');
  expect(activate()).toHaveProperty('activated', false);
  expect(
    createDirectAttemptActivator({ db })({ attemptId: 'next', sessionId: 'worker' })
  ).toHaveProperty('activated', false);
  expect(attempts.getActive(taskId)?.phase).toBe('reserved');
  expect(tasks.getTask(taskId)?.status).toBe('open');
});

test.each(['missing', 'inactive', 'workspace', 'foreign-task', 'coordinator', 'pointer'] as const)(
  'persisted %s session evidence is rejected',
  (state) => {
    if (state === 'missing') db.prepare('DELETE FROM sessions WHERE id = ?').run('worker');
    else if (state === 'pointer') tasks.updateTask(taskId, { taskAgentSessionId: 'different' });
    else
      sessions.updateSession(
        'worker',
        state === 'inactive'
          ? { status: 'archived' }
          : state === 'workspace'
            ? { workspacePath: '/other' }
            : state === 'foreign-task'
              ? { context: { spaceId, taskId: 'other' } }
              : { config: { ...sessions.getSession('worker')!.config, coordinatorMode: true } }
      );
    expect(activate()).toHaveProperty('activated', false);
    expect(attempts.get('attempt')?.phase).toBe('reserved');
  }
);

test('dependencies use the manager completed, existing and same-Space semantics', () => {
  const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  tasks.updateTask(taskId, { dependsOn: [dependency.id, dependency.id] });
  expect(activate()).toHaveProperty('activated', false);
  tasks.updateTask(dependency.id, { status: 'done' });
  expect(activate()).toHaveProperty('activated', true);
});

test('missing and foreign dependencies reject even when a referenced task is done', () => {
  tasks.updateTask(taskId, { dependsOn: ['missing'] });
  expect(activate()).toHaveProperty('activated', false);
  const other = spaces.createSpace({ name: 'Other', slug: 'other', workspacePath: '/other' });
  const dependency = tasks.createTask({ spaceId: other.id, title: 'Foreign', description: '' });
  tasks.updateTask(dependency.id, { status: 'done' });
  tasks.updateTask(taskId, { dependsOn: [dependency.id] });
  expect(activate()).toHaveProperty('activated', false);
});

test('pure admission rejects a competing workflow without changing lifecycle fields', () => {
  const task = tasks.getTask(taskId)!;
  const attempt = attempts.get('attempt')!;
  expect(
    requireDirectActivation(
      input,
      {
        task: { ...task, workflowRunId: 'competing-run' },
        attempt,
        active: attempt,
        space: spaces.getSpace(spaceId),
        session: sessions.getSession('worker'),
        selected: true,
        stopRequested: false,
        kickoff: readDirectKickoffIntent(db, input.attemptId),
        dependencies: [],
      },
      Date.now()
    )
  ).toHaveProperty('reason');
  expect(tasks.getTask(taskId)?.status).toBe('open');
});

test('attempt-write failure rolls back task binding and aborts buffered notifications', () => {
  const commitTransaction = mock(() => {});
  const abortTransaction = mock(() => {});
  const notifyChange = mock(() => {});
  const reactiveDb = {
    beginTransaction: mock(() => {}),
    commitTransaction,
    abortTransaction,
    notifyChange,
  } as unknown as ReactiveDatabase;
  db.exec(
    "CREATE TRIGGER fail_activation BEFORE UPDATE OF phase ON direct_task_execution_attempts WHEN NEW.phase = 'running' BEGIN SELECT RAISE(ABORT, 'activation write failed'); END"
  );
  expect(() => createDirectAttemptActivator({ db, reactiveDb })(input)).toThrow(
    'activation write failed'
  );
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(tasks.getTask(taskId)?.taskAgentSessionId).toBeFalsy();
  expect(attempts.get('attempt')?.phase).toBe('reserved');
  expect(commitTransaction).not.toHaveBeenCalled();
  expect(abortTransaction).toHaveBeenCalledTimes(1);
  expect(notifyChange).toHaveBeenCalled();
});

test('notifications commit only once both persisted states are visible', () => {
  const commitTransaction = mock(() => {
    expect(tasks.getTask(taskId)?.status).toBe('in_progress');
    expect(attempts.get('attempt')?.phase).toBe('running');
    db.exec('BEGIN');
    db.exec('ROLLBACK');
  });
  const reactiveDb = {
    beginTransaction: mock(() => {}),
    commitTransaction,
    abortTransaction: mock(() => {}),
    notifyChange: mock(() => {}),
  } as unknown as ReactiveDatabase;
  expect(createDirectAttemptActivator({ db, reactiveDb })(input)).toHaveProperty('activated', true);
  expect(commitTransaction).toHaveBeenCalledTimes(1);
});

test('workflow attachment committed before activation is preserved', () => {
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({
    spaceId,
    name: 'Workflow',
    nodes: [{ id: 'node', name: 'Node', agents: [] }],
  });
  const run = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  });
  tasks.updateTask(taskId, { workflowRunId: run.id });
  expect(activate()).toHaveProperty('activated', false);
  expect(tasks.getTask(taskId)?.workflowRunId).toBe(run.id);
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(attempts.get('attempt')?.phase).toBe('reserved');
});

test('deleted selection cascades its claim and activation cannot reconstruct either', () => {
  db.prepare('DELETE FROM direct_task_execution_selection WHERE task_id = ?').run(taskId);
  expect(attempts.get('attempt')).toBeNull();
  expect(activate()).toEqual({ activated: false, reason: 'unavailable' });
  expect(attempts.get('attempt')).toBeNull();
  expect(attempts.isSelected(taskId)).toBe(false);
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(tasks.getTask(taskId)?.taskAgentSessionId).toBeFalsy();
});

test.each(['pause', 'stop'] as const)(
  'persisted Space %s prevents activation and reopening preserves frozen intent',
  (action) => {
    const frozen = readDirectKickoffIntent(db, 'attempt');
    if (action === 'pause') spaces.pauseSpace(spaceId);
    else spaces.stopSpace(spaceId);
    expect(spaces.getSpace(spaceId)?.status).toBe('active');
    expect(activate()).toEqual({ activated: false, reason: 'unavailable' });
    expect(tasks.getTask(taskId)?.status).toBe('open');
    expect(attempts.get('attempt')?.phase).toBe('reserved');
    spaces.startSpace(spaceId);
    expect(activate()).toHaveProperty('activated', true);
    expect(readDirectKickoffIntent(db, 'attempt')).toEqual(frozen);
  }
);

test.each(['missing', 'foreign-session', 'missing-uuid', 'wrong-origin', 'deferred'] as const)(
  'activation rejects %s intent without creating content or partially binding task',
  (state) => {
    if (state === 'missing')
      db.prepare('DELETE FROM direct_task_kickoff_intents WHERE attempt_id = ?').run('attempt');
    else {
      const entry = readDirectKickoffIntent(db, 'attempt')!;
      if (state === 'foreign-session') entry.to = { kind: 'session', sessionId: 'other-worker' };
      if (state === 'missing-uuid') delete entry.messageUuid;
      if (state === 'wrong-origin') entry.origin = 'chat';
      if (state === 'deferred') entry.deliveryMode = 'defer';
      db.prepare('UPDATE direct_task_kickoff_intents SET entry = ? WHERE attempt_id = ?').run(
        JSON.stringify(entry),
        'attempt'
      );
    }
    const before = readDirectKickoffIntent(db, 'attempt');
    expect(activate()).toEqual({ activated: false, reason: 'unavailable' });
    expect(tasks.getTask(taskId)?.status).toBe('open');
    expect(tasks.getTask(taskId)?.taskAgentSessionId).toBeFalsy();
    expect(attempts.get('attempt')?.phase).toBe('reserved');
    expect(readDirectKickoffIntent(db, 'attempt')).toEqual(before);
  }
);

test('a previous attempt intent cannot satisfy a successor activation', () => {
  const frozen = readDirectKickoffIntent(db, 'attempt');
  attempts.stop('attempt', 'worker', 'cancelled');
  attempts.claim(taskId, 'next', 'next-worker');
  const row = sessions.getSession('worker')!;
  sessions.createSession({ ...row, id: 'next-worker' }, { enforceWorkspaceOwnership: false });
  expect(
    createDirectAttemptActivator({ db })({ attemptId: 'next', sessionId: 'next-worker' })
  ).toHaveProperty('activated', false);
  expect(attempts.get('next')?.phase).toBe('reserved');
  expect(readDirectKickoffIntent(db, 'next')).toBeNull();
  expect(readDirectKickoffIntent(db, 'attempt')).toEqual(frozen);
});

test.each([-1, 0, 1])(
  'kickoff TTL boundary offset %s matches mailbox delivery exactly',
  (offset) => {
    const entry = readDirectKickoffIntent(db, 'attempt')!;
    const now = decodeUlidTimestamp(entry.id) + entry.policy.ttlMs + offset;
    expect(mailboxEntryExpired(entry, now)).toBe(offset > 0);
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(activate()).toHaveProperty('activated', offset <= 0);
      expect(attempts.get('attempt')?.phase).toBe(offset <= 0 ? 'running' : 'reserved');
      expect(tasks.getTask(taskId)?.status).toBe(offset <= 0 ? 'in_progress' : 'open');
      expect(readDirectKickoffIntent(db, 'attempt')).toEqual(entry);
    } finally {
      clock.mockRestore();
    }
  }
);
