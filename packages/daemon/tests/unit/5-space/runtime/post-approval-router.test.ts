import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpawnSupersededError } from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import {
  PostApprovalRouter,
  isPostApprovalRoutingEnabled,
  POST_APPROVAL_ROUTING_FLAG_ENV,
  mapPostApprovalDispatchWarning,
} from '../../../../src/lib/space/runtime/post-approval-router.ts';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';

const SPACE_ID = 'space-par-test';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(SPACE_ID, `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
  return db;
}

function makeApprovedTask(taskRepo: SpaceTaskRepository): SpaceTask {
  const task = taskRepo.createTask({
    spaceId: SPACE_ID,
    title: 'Ship it',
    description: 'Do the thing',
    status: 'in_progress',
  });
  const approved = taskRepo.updateTask(task.id, {
    status: 'approved',
    approvalSource: 'agent',
    approvedAt: Date.now(),
  });
  if (!approved) throw new Error('failed to seed approved task');
  return approved;
}

function stubWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Test WF',
    description: '',
    version: 1,
    completionAutonomyLevel: 3,
    startNodeId: 'n1',
    endNodeId: 'n1',
    nodes: [],
    channels: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SpaceWorkflow;
}

interface Delegates {
  spawned: Array<{ taskId: string; targetAgent: string; kickoffMessage: string }>;
  spawner: {
    spawnPostApprovalSubSession: (args: {
      task: SpaceTask;
      workflow: SpaceWorkflow;
      targetAgent: string;
      kickoffMessage: string;
    }) => Promise<{ sessionId: string }>;
  };
  liveness: { isSessionAlive: (id: string) => boolean };
  aliveSessions: Set<string>;
}

function makeDelegates(): Delegates {
  const d: Delegates = {
    spawned: [],
    aliveSessions: new Set(),
    spawner: {
      async spawnPostApprovalSubSession(args) {
        const sessionId = `spawned-session-${d.spawned.length + 1}`;
        d.spawned.push({
          taskId: args.task.id,
          targetAgent: args.targetAgent,
          kickoffMessage: args.kickoffMessage,
        });
        d.aliveSessions.add(sessionId);
        return { sessionId };
      },
    },
    liveness: {
      isSessionAlive(id: string) {
        return d.aliveSessions.has(id);
      },
    },
  };
  return d;
}

describe('isPostApprovalRoutingEnabled', () => {
  test('returns true when env var unset (default ON)', () => {
    expect(isPostApprovalRoutingEnabled({})).toBe(true);
  });
  test('returns true when env var empty string', () => {
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: '' })).toBe(true);
  });
  test('returns true for explicit truthy values ("1", "true", "yes", "on")', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'ON']) {
      expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: v })).toBe(true);
    }
  });
  test('returns false only for explicit falsy kill-switch values', () => {
    for (const v of ['0', 'false', 'FALSE', 'no', 'NO', 'off', 'OFF']) {
      expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: v })).toBe(false);
    }
  });
  test('returns true for arbitrary strings (non-kill-switch values keep routing on)', () => {
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: 'maybe' })).toBe(true);
  });
});

describe('PostApprovalRouter.route', () => {
  let db: BunDatabase;
  let taskRepo: SpaceTaskRepository;

  beforeEach(() => {
    db = makeDb();
    taskRepo = new SpaceTaskRepository(db);
  });
  afterEach(() => {
    db.close();
  });

  test('no postApproval → closes task directly (done)', async () => {
    const task = makeApprovedTask(taskRepo);
    const delegates = makeDelegates();
    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });

    const result = await router.route(task, stubWorkflow(), {
      approvalSource: 'agent',
      spaceId: SPACE_ID,
    });

    expect(result.mode).toBe('no-route');
    if (result.mode === 'no-route') {
      expect(result.taskStatus).toBe('done');
    }
    const final = taskRepo.getTask(task.id);
    expect(final?.status).toBe('done');
    expect(delegates.spawned).toHaveLength(0);
  });

  test('a superseded spawn maps to a benign skipped route — task stays approved for a later tick (PR #2770 review)', async () => {
    const task = makeApprovedTask(taskRepo);
    const delegates = makeDelegates();
    const throwingSpawner = {
      spawnPostApprovalSubSession: () => {
        throw new SpawnSupersededError('exec-post-approval', 'fresh-create-bind');
      },
    };
    const router = new PostApprovalRouter({
      taskRepo,
      spawner: throwingSpawner,
      livenessProbe: delegates.liveness,
    });

    const workflow = stubWorkflow({
      postApproval: {
        targetAgent: 'deployer',
        instructions: 'Deploy {{task_title}} now.',
      },
    });

    const result = await router.route(task, workflow, {
      approvalSource: 'agent',
      task_title: task.title,
      spaceId: SPACE_ID,
    });

    expect(result.mode).toBe('skipped');
    if (result.mode === 'skipped') {
      expect(result.reason).toContain('superseded');
    }
    expect(taskRepo.getTask(task.id)?.status).toBe('approved');
    expect(taskRepo.getTask(task.id)?.postApprovalBlockedReason).toContain('superseded');
  });

  test('targetAgent pointing at node agent → spawn sub-session + stamp', async () => {
    const task = makeApprovedTask(taskRepo);
    const delegates = makeDelegates();
    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });

    const workflow = stubWorkflow({
      postApproval: {
        targetAgent: 'deployer',
        instructions: 'Deploy {{task_title}} now.',
      },
    });
    const before = Date.now();
    const result = await router.route(task, workflow, {
      approvalSource: 'agent',
      task_title: task.title,
    });
    const after = Date.now();

    expect(result.mode).toBe('spawn');
    expect(delegates.spawned).toHaveLength(1);
    expect(delegates.spawned[0].targetAgent).toBe('deployer');
    expect(delegates.spawned[0].kickoffMessage).toContain(task.title ?? '');
    expect(delegates.spawned[0].kickoffMessage).toContain('mark_complete');
    expect(delegates.spawned[0].kickoffMessage).toContain('Do NOT call approve_task');
    expect(delegates.spawned[0].kickoffMessage).not.toContain('request_human_input');
    expect(delegates.spawned[0].kickoffMessage).toMatch(/NON-result artifact/);
    expect(delegates.spawned[0].kickoffMessage).toContain('shape:"note", kind:"blocked"');

    const final = taskRepo.getTask(task.id);
    expect(final?.postApprovalSessionId).toBe('spawned-session-1');
    expect(final?.postApprovalStartedAt).toBeGreaterThanOrEqual(before);
    expect(final?.postApprovalStartedAt).toBeLessThanOrEqual(after);
    expect(final?.status).toBe('approved');
  });

  test('node-level postApproval on submitting node overrides legacy workflow route', async () => {
    const task = makeApprovedTask(taskRepo);
    const delegates = makeDelegates();
    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });

    const workflow = stubWorkflow({
      startNodeId: 'n1',
      endNodeId: 'n2',
      postApproval: {
        targetAgent: 'legacy',
        instructions: 'Legacy route should not run.',
      },
      nodes: [
        {
          id: 'n1',
          name: 'Build',
          agents: [{ agentId: 'coder-id', name: 'coder' }],
        },
        {
          id: 'n2',
          name: 'Review',
          agents: [{ agentId: 'reviewer-id', name: 'reviewer' }],
          postApproval: {
            targetAgent: 'reviewer',
            instructions: 'Merge {{task_title}}.',
          },
        },
      ],
    });

    const result = await router.route({ ...task, postApprovalSourceNodeId: 'n2' }, workflow, {
      approvalSource: 'agent',
      task_title: task.title,
    });

    expect(result.mode).toBe('spawn');
    expect(delegates.spawned).toHaveLength(1);
    expect(delegates.spawned[0].targetAgent).toBe('reviewer');
    expect(delegates.spawned[0].kickoffMessage).toContain('Merge Ship it.');
    expect(delegates.spawned[0].kickoffMessage).not.toContain('Legacy route');
    const final = taskRepo.getTask(task.id);
    expect(final?.pendingCompletionSubmittedByNodeId).toBeNull();
  });

  test('postApproval on any node fires on approval regardless of submitting node (fan-out)', async () => {
    const task = makeApprovedTask(taskRepo);
    const delegates = makeDelegates();
    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });

    const workflow = stubWorkflow({
      startNodeId: 'n1',
      endNodeId: 'n2',
      nodes: [
        {
          id: 'n1',
          name: 'Standalone',
          agents: [{ agentId: 'coder-id', name: 'coder' }],
        },
        {
          id: 'n2',
          name: 'Review',
          agents: [{ agentId: 'reviewer-id', name: 'reviewer' }],
          postApproval: {
            targetAgent: 'reviewer',
            instructions: 'Merge {{task_title}}.',
          },
        },
      ],
    });

    const result = await router.route({ ...task, postApprovalSourceNodeId: 'n1' }, workflow, {
      approvalSource: 'human',
      task_title: task.title,
    });

    expect(result.mode).toBe('spawn');
    expect(delegates.spawned).toHaveLength(1);
    expect(delegates.spawned[0].targetAgent).toBe('reviewer');
    expect(delegates.spawned[0].kickoffMessage).toContain('Merge Ship it.');
    const final = taskRepo.getTask(task.id);
    expect(final?.status).toBe('approved');
  });

  test('multi-route degrades to single dispatch: only the first declared route fires', async () => {
    const task = makeApprovedTask(taskRepo);
    const delegates = makeDelegates();
    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });

    const workflow = stubWorkflow({
      startNodeId: 'n1',
      endNodeId: 'n1',
      nodes: [
        {
          id: 'n1',
          name: 'Build',
          agents: [{ agentId: 'coder-id', name: 'coder' }],
          postApproval: { targetAgent: 'coder', instructions: 'Tag release.' },
        },
        {
          id: 'n2',
          name: 'Merge',
          agents: [{ agentId: 'merger-id', name: 'merger' }],
          postApproval: { targetAgent: 'merger', instructions: 'Merge PR.' },
        },
      ],
    });

    const result = await router.route(task, workflow, { approvalSource: 'agent' });

    expect(result.mode).toBe('spawn');
    expect(delegates.spawned).toHaveLength(1);
    expect(delegates.spawned[0].targetAgent).toBe('coder');
    expect(delegates.spawned[0].kickoffMessage).toContain('Tag release.');
    const final = taskRepo.getTask(task.id);
    expect(final?.postApprovalSessionId).toBe('spawned-session-1');
  });

  test('already-routed (live session) → no re-spawn', async () => {
    const task = makeApprovedTask(taskRepo);
    taskRepo.updateTask(task.id, {
      postApprovalSessionId: 'session-alive-1',
    });
    const updated = taskRepo.getTask(task.id);
    expect(updated?.postApprovalSessionId).toBe('session-alive-1');

    const delegates = makeDelegates();
    delegates.aliveSessions.add('session-alive-1');

    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });

    const workflow = stubWorkflow({
      postApproval: { targetAgent: 'deployer', instructions: 'deploy it' },
    });

    const result = await router.route({ ...updated! }, workflow, { approvalSource: 'agent' });

    expect(result.mode).toBe('already-routed');
    if (result.mode === 'already-routed') {
      expect(result.postApprovalSessionId).toBe('session-alive-1');
    }
    expect(delegates.spawned).toHaveLength(0);
  });

  test('stale postApprovalSessionId (dead session) → re-spawns', async () => {
    const task = makeApprovedTask(taskRepo);
    taskRepo.updateTask(task.id, { postApprovalSessionId: 'session-dead-1' });
    const updated = taskRepo.getTask(task.id)!;

    const delegates = makeDelegates();

    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });

    const workflow = stubWorkflow({
      postApproval: { targetAgent: 'deployer', instructions: 'retry deploy' },
    });

    const result = await router.route({ ...updated }, workflow, { approvalSource: 'agent' });
    expect(result.mode).toBe('spawn');
    expect(delegates.spawned).toHaveLength(1);
  });

  test('empty instructions on spawn path → skipped and clears pending completion state', async () => {
    const task = makeApprovedTask(taskRepo);
    taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'validation-node',
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'needs approval',
    });
    const updated = taskRepo.getTask(task.id)!;
    const delegates = makeDelegates();
    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });

    const result = await router.route(
      updated,
      stubWorkflow({ postApproval: { targetAgent: 'deployer', instructions: '' } }),
      { approvalSource: 'agent' }
    );
    expect(result.mode).toBe('skipped');
    expect(delegates.spawned).toHaveLength(0);
    const final = taskRepo.getTask(task.id);
    expect(final?.pendingCheckpointType).toBeNull();
    expect(final?.pendingCompletionSubmittedByNodeId).toBeNull();
  });

  test('task not in approved → skipped', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const delegates = makeDelegates();
    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });
    const result = await router.route(task, stubWorkflow(), { approvalSource: 'agent' });
    expect(result.mode).toBe('skipped');
  });

  test('legacy task-agent target → filtered out, task closes (no-route, no spawn)', async () => {
    const task = makeApprovedTask(taskRepo);
    taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'validation-node',
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'needs approval',
    });
    const updated = taskRepo.getTask(task.id)!;
    const delegates = makeDelegates();
    const router = new PostApprovalRouter({
      taskRepo,
      spawner: delegates.spawner,
      livenessProbe: delegates.liveness,
    });

    const workflow = stubWorkflow({
      postApproval: {
        targetAgent: 'task-agent',
        instructions: 'Deploy task {{task_id}} to production.',
      },
    });
    const result = await router.route(updated, workflow, {
      approvalSource: 'agent',
      spaceId: SPACE_ID,
      autonomyLevel: 4,
      task_id: task.id,
    });

    expect(result.mode).toBe('no-route');
    expect(delegates.spawned).toHaveLength(0);
    const final = taskRepo.getTask(task.id);
    expect(final?.status).toBe('done');
  });
});

describe('mapPostApprovalDispatchWarning', () => {
  test('always states the approval was recorded', () => {
    for (const detail of ['user interrupted', 'spawn failed: ENOTFOUND', '']) {
      expect(mapPostApprovalDispatchWarning(detail)).toContain('Approval recorded');
      expect(mapPostApprovalDispatchWarning(detail)).toContain('The task is approved');
    }
  });

  test('frames SDK interrupt/abort/cancel signatures distinctly from generic errors', () => {
    expect(mapPostApprovalDispatchWarning('user interrupted')).toContain('was interrupted');
    expect(mapPostApprovalDispatchWarning('Request was aborted by the user')).toContain(
      'was interrupted'
    );
    const generic = mapPostApprovalDispatchWarning('spawn failed: ENOTFOUND');
    expect(generic).toContain('hit an error');
    expect(generic).toContain('ENOTFOUND');
    expect(generic).not.toContain('was interrupted');
  });
});
