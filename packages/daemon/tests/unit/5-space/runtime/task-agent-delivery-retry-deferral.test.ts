/**
 * TaskAgentManager delivery-retry error deferral tests (task #944).
 *
 * A RECOVERABLE provider error during a delivery-driven node-agent turn must be
 * INVISIBLE to Space: the durable message_delivery job retries it (PR #2471),
 * and only the job dead-lettering is terminal. These tests pin the
 * `registerCompletionCallback` behavior that implements that contract:
 *   - a recoverable `session.error` does NOT block the node,
 *   - the idle that follows it (turn produced no result; retry pending) is NOT a
 *     completion,
 *   - a later legitimate idle (retry succeeded) DOES complete the node,
 *   - the dead-letter settlement (`session.error` with no details) and a
 *     genuinely non-recoverable error DO block the node.
 *
 * The session→task→execution link is seeded directly; the listener logic
 * (registerCompletionCallback + handleSubSessionError) is what's under test,
 * exercised through the real internalEventBus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const SUB_SESSION_ID = 'worker-session-1';

/** A recoverable provider error as the QueryRunner broadcasts it (details.recoverable === true). */
const RECOVERABLE_DETAILS = {
  category: 'system',
  code: 'OVERLOADED_ERROR',
  message: 'The provider is overloaded',
  userMessage: 'The provider is overloaded',
  recoverable: true,
  timestamp: '2026-08-13T00:00:00.000Z',
};

/** A genuinely non-recoverable error as the QueryRunner broadcasts it. */
const NON_RECOVERABLE_DETAILS = {
  ...RECOVERABLE_DETAILS,
  recoverable: false,
  code: 'INVALID_API_KEY',
};

describe('TaskAgentManager delivery-retry error deferral (task #944)', () => {
  let db: BunDatabase;
  let taskRepo: SpaceTaskRepository;
  let nodeExecRepo: NodeExecutionRepository;
  let bus: ReturnType<typeof createDaemonInternalEventBus>;
  let manager: TaskAgentManager;
  let executionId: string;
  let completed: boolean;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);

    const spaceRepo = new SpaceRepository(
      db as unknown as Parameters<typeof SpaceRepository.prototype.constructor>[0]
    );
    const space = spaceRepo.createSpace({ workspacePath: '/w', slug: 's', name: 'S' });

    // Minimal workflow + run chain so node_executions / task FKs resolve.
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, start_node_id, end_node_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('wf-1', space.id, 'WF', 'n-1', 'n-1', now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', space.id, 'wf-1', 'R', 'in_progress', now, now);

    taskRepo = new SpaceTaskRepository(
      db as unknown as Parameters<typeof SpaceTaskRepository.prototype.constructor>[0]
    );
    const task = taskRepo.createTask({
      spaceId: space.id,
      title: 'T',
      description: '',
      workflowRunId: 'run-1',
    });
    taskRepo.updateTask(task.id, { status: 'in_progress' });

    nodeExecRepo = new NodeExecutionRepository(db);
    const execution = nodeExecRepo.create({
      workflowRunId: 'run-1',
      workflowNodeId: 'n-1',
      agentName: 'coder',
      agentSessionId: SUB_SESSION_ID,
      status: 'in_progress',
    });
    executionId = execution.id;

    bus = createDaemonInternalEventBus();

    const config = {
      db: { getDatabase: () => db },
      taskRepo,
      nodeExecutionRepo: nodeExecRepo,
      internalEventBus: bus,
    } as unknown as TaskAgentManagerConfig;
    manager = new TaskAgentManager(config);

    // Seed the in-memory session→task map both findParentTaskIdForSubSession and
    // getSubSession resolve through. The fake session reports a non-zero SDK
    // message count so the idle-completion path does not bail as "not started".
    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    subSessions.set(task.id, new Map());
    subSessions.get(task.id)!.set(SUB_SESSION_ID, {
      id: SUB_SESSION_ID,
      getSDKMessageCount: () => 5,
    });

    completed = false;
    manager.registerCompletionCallback(SUB_SESSION_ID, async () => {
      completed = true;
    });
  });

  afterEach(() => {
    db.close();
  });

  const publishError = async (details?: unknown): Promise<void> => {
    await bus.publish('session.error', { sessionId: SUB_SESSION_ID, error: 'boom', details });
    await flush();
  };
  const publishIdle = async (): Promise<void> => {
    await bus.publish('session.updated', {
      sessionId: SUB_SESSION_ID,
      processingState: { status: 'idle' },
    });
    await flush();
  };
  const nodeStatus = (): string | undefined => nodeExecRepo.getById(executionId)?.status;

  it('a recoverable error does not block the node (deferred to the dead-letter)', async () => {
    await publishError(RECOVERABLE_DETAILS);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress'); // not blocked — retry pending
  });

  it('the idle following a recoverable error is suppressed (retry in progress)', async () => {
    await publishError(RECOVERABLE_DETAILS);
    await publishIdle(); // turn produced no result → not a completion
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a later legitimate idle (retry success) completes the node', async () => {
    await publishError(RECOVERABLE_DETAILS);
    await publishIdle(); // post-error idle — suppressed
    await publishIdle(); // retry succeeded — genuine completion
    expect(completed).toBe(true);
  });

  it('the dead-letter settlement (session.error with no details) blocks the node', async () => {
    await publishError(undefined); // dead-letter publishes session.error with no details
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a non-recoverable error blocks the node immediately', async () => {
    await publishError(NON_RECOVERABLE_DETAILS);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a terminal error after a deferred recoverable error still blocks the node', async () => {
    await publishError(RECOVERABLE_DETAILS); // deferred
    await publishIdle(); // suppressed retry-pending idle
    await publishError(undefined); // retries exhausted → dead-letter
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('with delivery v2 disabled, a recoverable error blocks the node (legacy behavior)', async () => {
    const prev = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
    try {
      await publishError(RECOVERABLE_DETAILS);
      expect(completed).toBe(false);
      expect(nodeStatus()).toBe('blocked');
    } finally {
      if (prev === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = prev;
    }
  });
});
