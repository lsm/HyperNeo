/**
 * ChannelRouter — run reopening & archive tombstone semantics.
 *
 * Covers the acceptance criteria for the "communication allowed until task is
 * archived" fix. Archive (`SpaceTask.archivedAt`) is the only authoritative
 * tombstone for inter-agent communication and node activation — workflow run
 * statuses `done` and `cancelled` can always transition back to `in_progress`
 * when new inbound activity arrives before the parent task is archived.
 *
 * 1. deliverMessage auto-reopens a `done` run and activates the target node
 *    when the parent task is not archived.
 * 2. deliverMessage auto-reopens a `cancelled` run and activates the target
 *    node when the parent task is not archived.
 * 3. deliverMessage throws `ActivationError` with the archived-task message
 *    when the parent task is archived (regardless of run status).
 * 4. A `workflow_run_reopened` notification event is emitted to the
 *    InternalEventBus exactly once per reopen, with the correct `fromStatus`
 *    and `by` fields.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  ChannelRouter,
  ActivationError,
  ARCHIVED_TASK_ERROR_MESSAGE,
} from '../../../../src/lib/space/runtime/channel-router.ts';
import type { SpaceWorkflow, WorkflowChannel } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type {
  DaemonInternalEventMap,
  SpaceWorkflowRunReopenedEvent,
} from '../../../../src/lib/internal-event-bus.ts';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpace(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Recording notification collector (via InternalEventBus)
// ---------------------------------------------------------------------------

class RecordingCollector {
  readonly events: Array<SpaceWorkflowRunReopenedEvent> = [];
  private unsub: () => void;

  constructor(bus: InternalEventBus<DaemonInternalEventMap>) {
    this.unsub = bus.subscribe(
      'space.workflowRun.reopened',
      (payload) => {
        this.events.push(payload as SpaceWorkflowRunReopenedEvent);
      },
      { subscriberName: 'test-collector:space.workflowRun.reopened' }
    );
  }

  reopens(): Array<SpaceWorkflowRunReopenedEvent> {
    return this.events;
  }

  destroy(): void {
    this.unsub();
  }
}

// ---------------------------------------------------------------------------
// Workflow builder
// ---------------------------------------------------------------------------

function buildSimpleWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{ id: string; name: string; agentId: string }>,
  channels: WorkflowChannel[] = []
): SpaceWorkflow {
  return workflowManager.createWorkflow({
    spaceId,
    name: `WF ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: '',
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, agentId: n.agentId })),
    transitions: [],
    startNodeId: nodes[0].id,
    endNodeId: nodes[nodes.length - 1].id,
    rules: [],
    tags: [],
    channels,
    completionAutonomyLevel: 3,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ChannelRouter — reopen on inbound activity (archive tombstone)', () => {
  let db: BunDatabase;

  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let workflowManager: SpaceWorkflowManager;
  let agentManager: SpaceAgentManager;
  let channelCycleRepo: ChannelCycleRepository;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let collector: RecordingCollector;
  let router: ChannelRouter;

  const SPACE_ID = 'space-reopen-1';
  const AGENT_A = 'agent-a';
  const AGENT_B = 'agent-b';
  const NODE_A = 'node-a';
  const NODE_B = 'node-b';

  beforeEach(() => {
    db = makeDb();
    seedSpace(db, SPACE_ID);
    seedAgent(db, AGENT_A, SPACE_ID);
    seedAgent(db, AGENT_B, SPACE_ID);

    taskRepo = new SpaceTaskRepository(db);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    channelCycleRepo = new ChannelCycleRepository(db);

    // One-task-per-run: ensure every createRun also creates a canonical task.
    const createRunOriginal = workflowRunRepo.createRun.bind(workflowRunRepo);
    (workflowRunRepo as unknown as { createRun: typeof workflowRunRepo.createRun }).createRun = ((
      params: Parameters<typeof workflowRunRepo.createRun>[0]
    ) => {
      const run = createRunOriginal(params);
      taskRepo.createTask({
        spaceId: params.spaceId,
        title: params.title,
        description: params.description ?? '',
        status: 'open',
        workflowRunId: run.id,
      });
      return run;
    }) as typeof workflowRunRepo.createRun;

    agentManager = new SpaceAgentManager(new SpaceAgentRepository(db));
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    bus = new InternalEventBus<DaemonInternalEventMap>();
    collector = new RecordingCollector(bus);

    router = new ChannelRouter({
      taskRepo,
      workflowRunRepo,
      workflowManager,
      agentManager,
      channelCycleRepo,
      db,
      nodeExecutionRepo: new NodeExecutionRepository(db),
      internalEventBus: bus,
    });
  });

  afterEach(() => {
    collector.destroy();
    db.close();
  });

  // -------------------------------------------------------------------------
  // activateNode — reopen on terminal statuses
  // -------------------------------------------------------------------------

  describe('activateNode', () => {
    test('reopens a done run, activates the target, and emits workflow_run_reopened', async () => {
      const workflow = buildSimpleWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'A', agentId: AGENT_A },
        { id: NODE_B, name: 'B', agentId: AGENT_B },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Reopenable Done',
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'done');

      const tasks = await router.activateNode(run.id, NODE_B, {
        allowTerminalReopen: true,
        reopenReason: 'user followup',
        reopenBy: 'user',
      });
      expect(tasks.length).toBeGreaterThan(0);

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const reopens = collector.reopens();
      expect(reopens).toHaveLength(1);
      expect(reopens[0].fromStatus).toBe('done');
      expect(reopens[0].by).toBe('user');
      expect(reopens[0].runId).toBe(run.id);
      expect(reopens[0].spaceId).toBe(SPACE_ID);
      expect(reopens[0].reason).toBe('user followup');
    });

    test('reopens a cancelled run and emits workflow_run_reopened with fromStatus=cancelled', async () => {
      const workflow = buildSimpleWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'A', agentId: AGENT_A },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Reopenable Cancelled',
      });
      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      await router.activateNode(run.id, NODE_A, {
        allowTerminalReopen: true,
        reopenReason: 'peer ping',
        reopenBy: 'agent:buddy',
      });

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const reopens = collector.reopens();
      expect(reopens).toHaveLength(1);
      expect(reopens[0].fromStatus).toBe('cancelled');
      expect(reopens[0].by).toBe('agent:buddy');
    });

    test('rejects with ARCHIVED_TASK_ERROR_MESSAGE when parent task is archived', async () => {
      const workflow = buildSimpleWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'A', agentId: AGENT_A },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Archived',
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'done');
      for (const t of taskRepo.listByWorkflowRunIncludingArchived(run.id)) {
        taskRepo.archiveTask(t.id);
      }

      await expect(router.activateNode(run.id, NODE_A)).rejects.toBeInstanceOf(ActivationError);
      await expect(router.activateNode(run.id, NODE_A)).rejects.toThrow(
        ARCHIVED_TASK_ERROR_MESSAGE
      );
      expect(collector.reopens()).toHaveLength(0);
      // Status must remain done — we never transitioned.
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
    });

    test('does not emit workflow_run_reopened when the run is already in_progress', async () => {
      const workflow = buildSimpleWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'A', agentId: AGENT_A },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Fresh Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      await router.activateNode(run.id, NODE_A);
      expect(collector.reopens()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // deliverMessage — attribution forwarding
  // -------------------------------------------------------------------------

  describe('deliverMessage attribution', () => {
    test('forwards fromRole as agent:<name> when reopening via peer send_message', async () => {
      const workflow = buildSimpleWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'A', agentId: AGENT_A },
        { id: NODE_B, name: 'B', agentId: AGENT_B },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Peer reopen attribution',
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'done');

      // Agent A sends a message to Agent B on a done run — expect reopen
      // attributed to "agent:A".
      await router.deliverMessage(run.id, 'A', 'B', 'hello');

      const reopens = collector.reopens();
      expect(reopens).toHaveLength(1);
      expect(reopens[0].by).toBe('agent:A');
      expect(reopens[0].fromStatus).toBe('done');
      expect(reopens[0].reason).toContain('peer send_message');
      expect(reopens[0].reason).toContain('"A"');
      expect(reopens[0].reason).toContain('"B"');
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency & resilience
  // -------------------------------------------------------------------------

  describe('resilience', () => {
    test('a throwing InternalEventBus subscriber does not break activation', async () => {
      // Create a bus with a subscriber that throws — simulates a downstream
      // consumer crashing. The router must still complete the activation.
      const throwingBus = new InternalEventBus<DaemonInternalEventMap>();
      throwingBus.subscribe(
        'space.workflowRun.reopened',
        () => {
          throw new Error('boom');
        },
        { subscriberName: 'test-throwing-subscriber' }
      );

      const localRouter = new ChannelRouter({
        taskRepo,
        workflowRunRepo,
        workflowManager,
        agentManager,
        channelCycleRepo,
        db,
        nodeExecutionRepo: new NodeExecutionRepository(db),
        internalEventBus: throwingBus,
      });

      const workflow = buildSimpleWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'A', agentId: AGENT_A },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Resilient',
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'done');

      // Should not throw despite the bus subscriber failing.
      await localRouter.activateNode(run.id, NODE_A, { allowTerminalReopen: true });
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });
  });
});
