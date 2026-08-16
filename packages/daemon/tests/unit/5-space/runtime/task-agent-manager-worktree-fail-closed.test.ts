/**
 * Fail-closed worktree creation for workflow node agents (#2520).
 *
 * `spawnWorkflowNodeAgentForExecution` used to log a warning and fall back to
 * running the worker directly in `space.workspacePath` when
 * `createTaskWorktree` failed — letting concurrent tasks mutate the same
 * shared checkout and branch. These tests pin the fail-closed contract:
 *
 *   - worktree creation failure rejects the spawn with a plain error (so the
 *     runtime's bounded spawn-retry handling owns the pending → retry →
 *     blocked transition — see space-runtime-tick-loop.test.ts for that
 *     state machine).
 *   - No sub-session is created on that path — in particular none with
 *     cwd = space.workspacePath.
 *   - The spawn bookkeeping (spawningExecutionIds) is released so a later
 *     tick can retry.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type {
  NodeExecution,
  Space,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';

const SPACE_ID = 'space-worktree-fail';
const TASK_ID = 'task-worktree-fail';
const RUN_ID = 'run-worktree-fail';
const NODE_ID = 'node-coding';
const AGENT_ID = 'agent-coder';
const AGENT_NAME = 'coder';
const SPACE_WORKSPACE = '/tmp/space-source-checkout';

const task: SpaceTask = {
  id: TASK_ID,
  spaceId: SPACE_ID,
  workflowRunId: RUN_ID,
  title: 'Fix the parser',
  taskNumber: 42,
  status: 'in_progress',
} as SpaceTask;

const execution: NodeExecution = {
  id: 'exec-worktree-fail',
  workflowRunId: RUN_ID,
  workflowNodeId: NODE_ID,
  agentName: AGENT_NAME,
  agentId: AGENT_ID,
  agentSessionId: null,
  status: 'pending',
  result: null,
  data: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
  updatedAt: 1,
};

const workflow = {
  id: 'wf-worktree-fail',
  spaceId: SPACE_ID,
  name: 'Coding',
  nodes: [
    {
      id: NODE_ID,
      name: 'Coding',
      agents: [{ agentId: AGENT_ID, name: AGENT_NAME }],
    },
  ],
  channels: [],
  startNodeId: NODE_ID,
  endNodeId: NODE_ID,
} as unknown as SpaceWorkflow;

const run = { id: RUN_ID, spaceId: SPACE_ID, workflowId: workflow.id } as SpaceWorkflowRun;
const space = { id: SPACE_ID, workspacePath: SPACE_WORKSPACE } as Space;

function makeManager(worktreeError: string | null): {
  tam: TaskAgentManager;
  executionUpdates: Array<{ id: string; payload: Record<string, unknown> }>;
  registeredSessions: string[];
} {
  const executionUpdates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const registeredSessions: string[] = [];
  const tam = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
    sessionManager: {
      registerSession: (sessionId: string) => {
        registeredSessions.push(sessionId);
      },
    },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: { getTask: () => task },
    nodeExecutionRepo: {
      update: (id: string, payload: Record<string, unknown>) => {
        executionUpdates.push({ id, payload });
        return null;
      },
    },
    worktreeManager: {
      createTaskWorktree: async () => {
        if (worktreeError) throw new Error(worktreeError);
        return { path: '/tmp/task-worktree-ok', slug: 'fix-the-parser' };
      },
    },
  } as unknown as TaskAgentManagerConfig);
  return { tam, executionUpdates, registeredSessions };
}

describe('TaskAgentManager — fail closed when task worktree creation fails', () => {
  let fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;

  beforeEach(() => {
    // Any session creation on the fail-closed path is a bug — fail loudly
    // rather than letting a half-stubbed AgentSession crash confusingly.
    fromInitSpy = spyOn(AgentSession, 'fromInit').mockImplementation((() => {
      throw new Error('AgentSession.fromInit must not be called when worktree creation fails');
    }) as unknown as typeof AgentSession.fromInit);
  });

  afterEach(() => {
    fromInitSpy.mockRestore();
  });

  test('rejects the spawn and never creates a sub-session (no cwd = space.workspacePath)', async () => {
    const { tam, executionUpdates, registeredSessions } = makeManager(
      'git worktree add failed: No space left on device'
    );

    let caught: unknown;
    try {
      await tam.spawnWorkflowNodeAgentForExecution(task, space, workflow, run, execution);
    } catch (err) {
      caught = err;
    }

    // The rejection names the worktree failure, the refusal to use the shared
    // checkout, and the underlying cause.
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('Task worktree creation failed');
    expect(message).toContain('refusing to spawn a node agent in the shared space workspace');
    expect(message).toContain('git worktree add failed: No space left on device');

    // No session was created or registered anywhere — the worker never
    // started, in particular not in the shared source checkout.
    expect(fromInitSpy).not.toHaveBeenCalled();
    expect(registeredSessions).toHaveLength(0);
    // The execution was not flipped to in_progress (no spawn happened).
    expect(executionUpdates.some((update) => update.payload.status === 'in_progress')).toBe(false);
    // Spawn bookkeeping is released so the runtime can retry on a later tick.
    expect(tam.isExecutionSpawning(execution.id)).toBe(false);
  });
});
