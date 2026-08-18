import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { createSpaceTables } from '../../helpers/space-test-db';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TaskAgentManager agent-activity listener', () => {
  let db: Database;
  let nodeExecutionRepo: NodeExecutionRepository;
  let bus: ReturnType<typeof createDaemonInternalEventBus>;
  let manager: TaskAgentManager;
  let executionId: string;
  let workflowRunId: string;
  let spaceId: string;
  const subSessionId = 'worker-session-1';

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaceRepo = new SpaceRepository(
      db as unknown as Parameters<typeof SpaceRepository.prototype.constructor>[0]
    );
    const runRepo = new SpaceWorkflowRunRepository(
      db as unknown as Parameters<typeof SpaceWorkflowRunRepository.prototype.constructor>[0]
    );
    nodeExecutionRepo = new NodeExecutionRepository(
      db as unknown as Parameters<typeof NodeExecutionRepository.prototype.constructor>[0]
    );
    const taskRepo = new SpaceTaskRepository(
      db as unknown as Parameters<typeof SpaceTaskRepository.prototype.constructor>[0]
    );
    const space = spaceRepo.createSpace({ workspacePath: '/w', slug: 's', name: 'S' });
    spaceId = space.id;
    taskRepo.createTask({ spaceId: space.id, title: 'T', description: '' });

    const now = Date.now();
    (db as unknown as { prepare: (sql: string) => { run: (...args: unknown[]) => void } })
      .prepare(
        `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run('wf-1', space.id, 'WF', now, now);
    const run = runRepo.createRun({ spaceId: space.id, workflowId: 'wf-1', title: 'R' });
    workflowRunId = run.id;

    const exec = nodeExecutionRepo.create({
      workflowRunId: run.id,
      workflowNodeId: 'node-1',
      agentName: 'coder',
      agentSessionId: subSessionId,
      status: 'in_progress',
    });
    executionId = exec.id;
    expect(exec.lastActivityAt).toBeNull();

    bus = createDaemonInternalEventBus();

    const config = {
      db: { getDatabase: () => db },
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
    } as unknown as TaskAgentManagerConfig;
    manager = new TaskAgentManager(config);
  });

  afterEach(() => {
    db.close();
  });

  it('refreshes lastActivityAt on sdk.toolUse.created', async () => {
    const ts = 1_700_000_000_000;
    bus.publish('sdk.toolUse.created', {
      sessionId: subSessionId,
      toolUseId: 'tu-1',
      toolName: 'bash',
      timestamp: ts,
    });
    await flush();

    expect(nodeExecutionRepo.getById(executionId)!.lastActivityAt).toBe(ts);
  });

  it('refreshes lastActivityAt on sdk.toolUse.consumed', async () => {
    const ts = 1_700_000_000_001;
    bus.publish('sdk.toolUse.consumed', {
      sessionId: subSessionId,
      toolUseId: 'tu-2',
      timestamp: ts,
    });
    await flush();

    expect(nodeExecutionRepo.getById(executionId)!.lastActivityAt).toBe(ts);
  });

  it('does not bump updated_at when refreshing lastActivityAt', async () => {
    const before = nodeExecutionRepo.getById(executionId)!;
    expect(before.lastActivityAt).toBeNull();

    bus.publish('sdk.toolUse.created', {
      sessionId: subSessionId,
      toolUseId: 'tu-3',
      toolName: 'bash',
      timestamp: 1_700_000_000_002,
    });
    await flush();

    const after = nodeExecutionRepo.getById(executionId)!;
    expect(after.lastActivityAt).toBe(1_700_000_000_002);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('is a silent no-op for a session with no node execution row', async () => {
    expect(() => {
      bus.publish('sdk.toolUse.created', {
        sessionId: 'orphan-session',
        toolUseId: 'tu-x',
        toolName: 'bash',
        timestamp: 1_700_000_000_003,
      });
    }).not.toThrow();
    await flush();

    expect(nodeExecutionRepo.getById(executionId)!.lastActivityAt).toBeNull();
  });

  it('stamps lastActivityAt when a queued peer message is delivered via flushPendingMessagesForTarget', async () => {
    const pendingRepo = new PendingAgentMessageRepository(
      db as unknown as Parameters<typeof PendingAgentMessageRepository.prototype.constructor>[0]
    );
    const manager2 = new TaskAgentManager({
      db: { getDatabase: () => db },
      taskRepo: { getTask: () => null } as never,
      workflowRunRepo: { getRun: () => null } as never,
      nodeExecutionRepo,
      pendingMessageRepo: pendingRepo,
      internalEventBus: bus,
    } as unknown as TaskAgentManagerConfig);

    pendingRepo.enqueue({
      workflowRunId,
      spaceId,
      sourceAgentName: 'reviewer',
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'queued peer note',
      workflowNodeId: 'node-1',
    });
    expect(nodeExecutionRepo.getById(executionId)!.lastActivityAt).toBeNull();

    (
      manager2 as unknown as { injectSubSessionMessage: () => Promise<string> }
    ).injectSubSessionMessage = async () => 'flushed-msg-id';

    await manager2.flushPendingMessagesForTarget(workflowRunId, 'coder', subSessionId);

    expect(nodeExecutionRepo.getById(executionId)!.lastActivityAt).not.toBeNull();
  });
});
