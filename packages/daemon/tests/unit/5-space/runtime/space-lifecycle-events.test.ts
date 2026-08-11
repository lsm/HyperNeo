import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { SpaceGoal, SpaceTask } from '@hyperneo/shared';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { formatExternalEventEssence } from '../../../../src/lib/external-events/event-essence';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { SpaceLifecycleEventEmitter } from '../../../../src/lib/space/lifecycle/space-lifecycle-event-emitter';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

setDefaultTimeout(10_000);

const SPACE_ID = 'space-lifecycle-events';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: SPACE_ID,
    taskNumber: 1,
    title: 'Ship the thing',
    description: '',
    status: 'open',
    priority: 'normal',
    labels: [],
    dependsOn: [],
    activeSession: null,
    archivedAt: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    pendingCheckpointType: null,
    pendingCompletionSubmittedByNodeId: null,
    pendingCompletionSubmittedAt: null,
    pendingCompletionReason: null,
    reportedStatus: null,
    reportedSummary: null,
    postApprovalSessionId: null,
    postApprovalStartedAt: null,
    postApprovalBlockedReason: null,
    result: null,
    createdAt: 1_000,
    startedAt: null,
    completedAt: null,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeGoal(overrides: Partial<SpaceGoal> = {}): SpaceGoal {
  return {
    id: 'goal-1',
    spaceId: SPACE_ID,
    title: 'Improve quality',
    description: '',
    status: 'active',
    type: 'measurable',
    priority: 'normal',
    labels: [],
    metrics: {},
    summary: '',
    progress: 0,
    nextSteps: [],
    preferredWorkflowId: null,
    taskScheduleId: null,
    autoTriggerNext: false,
    pendingNextRun: false,
    activeTaskId: null,
    lastTaskId: null,
    lastCheckInAt: null,
    nextCheckInAt: null,
    completedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('SpaceLifecycleEventEmitter', () => {
  let db: Database;
  let store: ExternalEventStore;
  let service: ExternalEventService;
  let bus: ReturnType<typeof createDaemonInternalEventBus>;
  let emitter: SpaceLifecycleEventEmitter;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(SPACE_ID, SPACE_ID, '/tmp/lifecycle', 'Lifecycle', now, now);
    store = new ExternalEventStore(db);
    bus = createDaemonInternalEventBus();
    service = new ExternalEventService(store, bus);
    emitter = new SpaceLifecycleEventEmitter(service);
  });

  describe('task lifecycle topics + payloads', () => {
    test('emitTaskCreated publishes space/task.created with task details', async () => {
      const task = makeTask({ id: 't-create', taskNumber: 7, title: 'New thing' });
      const result = await emitter.emitTaskCreated(task);

      expect(result.outcome).toBe('published');
      const rows = db
        .prepare(
          `SELECT topic, summary, payload_json FROM space_external_events WHERE source = 'space'`
        )
        .all() as Array<{ topic: string; summary: string; payload_json: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.topic).toBe('space/task.created');
      expect(rows[0]!.summary).toContain('#7');
      const payload = JSON.parse(rows[0]!.payload_json);
      expect(payload).toMatchObject({
        eventType: 'task',
        action: 'created',
        taskId: 't-create',
        taskNumber: 7,
        title: 'New thing',
        status: 'open',
      });
      // Labels are present so subscribers can self-filter on label predicates.
      expect(payload.labels).toEqual([]);
    });

    test('emitTaskStatusChanged publishes space/task.<status> with from→to', async () => {
      const task = makeTask({ id: 't-block', status: 'blocked', updatedAt: 2_000 });
      const result = await emitter.emitTaskStatusChanged(task, 'in_progress');

      expect(result).not.toBeNull();
      expect(result!.outcome).toBe('published');
      const row = db
        .prepare(`SELECT topic, payload_json FROM space_external_events WHERE source = 'space'`)
        .get() as { topic: string; payload_json: string };
      expect(row.topic).toBe('space/task.blocked');
      expect(JSON.parse(row.payload_json)).toMatchObject({ from: 'in_progress', to: 'blocked' });
    });

    test('emitTaskStatusChanged returns null for non-surfaced statuses', async () => {
      const open = emitter.emitTaskStatusChanged(makeTask({ status: 'open' }), 'blocked');
      const approved = emitter.emitTaskStatusChanged(makeTask({ status: 'approved' }), 'review');
      const archived = emitter.emitTaskStatusChanged(makeTask({ status: 'archived' }), 'done');
      expect(open).toBeNull();
      expect(approved).toBeNull();
      expect(archived).toBeNull();
      expect(db.prepare(`SELECT COUNT(*) AS c FROM space_external_events`).get()).toEqual({ c: 0 });
    });

    test('emitTaskStatusChanged returns null when from === to', async () => {
      const result = emitter.emitTaskStatusChanged(makeTask({ status: 'done' }), 'done');
      expect(result).toBeNull();
    });
  });

  describe('goal lifecycle topics + payloads', () => {
    test('emitGoalTaskTriggered publishes space/goal.task_triggered', async () => {
      const result = await emitter.emitGoalTaskTriggered(makeGoal(), 'spawned-task-1');
      expect(result.outcome).toBe('published');
      const row = db
        .prepare(`SELECT topic, payload_json FROM space_external_events WHERE source = 'space'`)
        .get() as { topic: string; payload_json: string };
      expect(row.topic).toBe('space/goal.task_triggered');
      expect(JSON.parse(row.payload_json)).toMatchObject({
        goalId: 'goal-1',
        taskId: 'spawned-task-1',
      });
    });

    test('emitGoalStatusChanged publishes space/goal.status', async () => {
      const result = await emitter.emitGoalStatusChanged(
        makeGoal({ status: 'paused', updatedAt: 2_000 }),
        'active'
      );
      expect(result!.outcome).toBe('published');
      const row = db
        .prepare(`SELECT topic FROM space_external_events WHERE source = 'space'`)
        .get() as { topic: string };
      expect(row.topic).toBe('space/goal.status');
    });

    test('emitGoalStatusChanged returns null when status unchanged', () => {
      expect(emitter.emitGoalStatusChanged(makeGoal({ status: 'active' }), 'active')).toBeNull();
    });

    test('emitGoalProgress publishes space/goal.progress with the delta', async () => {
      const result = await emitter.emitGoalProgress(
        makeGoal({ progress: 50, updatedAt: 3_000 }),
        10
      );
      expect(result!.outcome).toBe('published');
      const row = db
        .prepare(`SELECT topic, payload_json FROM space_external_events WHERE source = 'space'`)
        .get() as { topic: string; payload_json: string };
      expect(row.topic).toBe('space/goal.progress');
      expect(JSON.parse(row.payload_json)).toMatchObject({ from: 10, to: 50 });
    });

    test('emitGoalProgress returns null when progress unchanged', () => {
      expect(emitter.emitGoalProgress(makeGoal({ progress: 42 }), 42)).toBeNull();
    });

    test('emitGoalCheckIn publishes space/goal.check_in', async () => {
      const result = await emitter.emitGoalCheckIn(makeGoal(), 'check-in-task-1');
      expect(result.outcome).toBe('published');
      const row = db
        .prepare(`SELECT topic FROM space_external_events WHERE source = 'space'`)
        .get() as { topic: string };
      expect(row.topic).toBe('space/goal.check_in');
    });
  });

  describe('delivered essence', () => {
    test('projects task lifecycle identifiers into the injected essence', () => {
      const task = makeTask({
        id: 't-essence',
        taskNumber: 9,
        title: 'Essence task',
        status: 'blocked',
        labels: ['research', 'quality'],
        blockReason: 'human_input_requested',
        workflowRunId: 'run-1',
      });
      const published: ExternalEvent[] = [];
      const localEmitter = new SpaceLifecycleEventEmitter({
        publish: async (event) => {
          published.push(event);
          return { outcome: 'published', eventId: event.id };
        },
      });
      void localEmitter.emitTaskStatusChanged({ ...task }, 'in_progress');
      const event = published[0]!;
      const essence = JSON.parse(
        formatExternalEventEssence({
          namespaceId: event.spaceId,
          spaceId: event.spaceId,
          eventId: event.id,
          source: event.source,
          topic: event.topic,
          dedupeKey: event.dedupeKey,
          summary: event.summary,
          externalUrl: event.externalUrl,
          payload: event.payload,
          occurredAt: event.occurredAt,
          ingestedAt: event.ingestedAt,
        } satisfies ExternalEventPublishedPayload) as unknown as string
      ) as Record<string, unknown>;

      expect(essence).toMatchObject({
        topic: 'space/task.blocked',
        taskId: 't-essence',
        taskNumber: 9,
        status: 'blocked',
        from: 'in_progress',
        to: 'blocked',
        blockReason: 'human_input_requested',
      });
      expect(essence.labels).toEqual(['research', 'quality']);
      // Summary is intentionally excluded by the essence contract.
      expect(essence.summary).toBeUndefined();
    });

    test('truncates a large task result so it cannot overflow a subscriber context', () => {
      const task = makeTask({
        id: 't-big',
        status: 'done',
        result: 'x'.repeat(2000),
      });
      const published: ExternalEvent[] = [];
      const localEmitter = new SpaceLifecycleEventEmitter({
        publish: async (event) => {
          published.push(event);
          return { outcome: 'published', eventId: event.id };
        },
      });
      void localEmitter.emitTaskStatusChanged({ ...task }, 'in_progress');
      const event = published[0]!;
      const essence = JSON.parse(
        formatExternalEventEssence({
          namespaceId: event.spaceId,
          spaceId: event.spaceId,
          eventId: event.id,
          source: event.source,
          topic: event.topic,
          dedupeKey: event.dedupeKey,
          summary: event.summary,
          externalUrl: event.externalUrl,
          payload: event.payload,
          occurredAt: event.occurredAt,
          ingestedAt: event.ingestedAt,
        } satisfies ExternalEventPublishedPayload) as unknown as string
      ) as Record<string, unknown>;

      const result = essence.result as string;
      expect(result.length).toBeLessThan(2000);
      expect(result.endsWith('…')).toBe(true);
    });
  });

  describe('dedupe + feedback-loop safety', () => {
    test('re-emitting the same transition dedupes (same dedupeKey)', async () => {
      const task = makeTask({ id: 't-dedupe', status: 'done', updatedAt: 5_000 });
      const first = await emitter.emitTaskStatusChanged(task, 'in_progress');
      const second = await emitter.emitTaskStatusChanged(task, 'in_progress');

      expect(first!.outcome).toBe('published');
      // Same transition (identical updatedAt anchor) → duplicate, not a new event.
      expect(second!.outcome).toBe('retryable_duplicate');
      expect(second!.eventId).toBe(first!.eventId);
      expect(
        (db.prepare(`SELECT COUNT(*) AS c FROM space_external_events`).get() as { c: number }).c
      ).toBe(1);
    });

    test('distinct transitions publish distinct events (no false dedupe)', async () => {
      // blocked at T=5000
      await emitter.emitTaskStatusChanged(
        makeTask({ id: 't-osc', status: 'blocked', updatedAt: 5_000 }),
        'in_progress'
      );
      // reactivated → in_progress at T=6000 (new anchor)
      await emitter.emitTaskStatusChanged(
        makeTask({ id: 't-osc', status: 'in_progress', updatedAt: 6_000 }),
        'blocked'
      );
      // blocked again at T=7000 (new anchor) — genuinely new transition
      await emitter.emitTaskStatusChanged(
        makeTask({ id: 't-osc', status: 'blocked', updatedAt: 7_000 }),
        'in_progress'
      );

      const topics = (
        db
          .prepare(`SELECT topic FROM space_external_events WHERE source = 'space' ORDER BY rowid`)
          .all() as Array<{ topic: string }>
      ).map((r) => r.topic);
      expect(topics).toEqual([
        'space/task.blocked',
        'space/task.in_progress',
        'space/task.blocked',
      ]);
    });

    test('a terminal prior event short-circuits a re-emit (no infinite loop)', async () => {
      const task = makeTask({ id: 't-loop', status: 'done', updatedAt: 9_000 });
      const first = await emitter.emitTaskStatusChanged(task, 'in_progress');
      // Simulate successful delivery terminalizing the event.
      store.markEventDelivered(first!.eventId);

      const second = await emitter.emitTaskStatusChanged(task, 'in_progress');
      expect(second!.outcome).toBe('duplicate_terminal');
      // No new bus event, no new row.
      expect(
        (db.prepare(`SELECT COUNT(*) AS c FROM space_external_events`).get() as { c: number }).c
      ).toBe(1);
    });
  });
});

describe('SpaceLifecycleEventEmitter end-to-end delivery', () => {
  let db: Database;
  let store: ExternalEventStore;
  let service: ExternalEventService;
  let bus: ReturnType<typeof createDaemonInternalEventBus>;
  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let workflowManager: SpaceWorkflowManager;
  let runtime: SpaceRuntime;
  let longHorizonMessages: Array<{ agentId: string; message: string }>;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(SPACE_ID, SPACE_ID, '/tmp/lifecycle', 'Lifecycle', now, now);

    store = new ExternalEventStore(db);
    bus = createDaemonInternalEventBus();
    service = new ExternalEventService(store, bus);

    taskRepo = new SpaceTaskRepository(db);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db), {
      getAgentById: () => null,
    });

    longHorizonMessages = [];
  });

  function setupCoordinatorSubscription(topic: string): { agentId: string } {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-coordinator',
      spaceId: SPACE_ID,
      handle: 'coordinator',
      displayName: 'Coordinator',
    });
    repo.createSubscription({ spaceId: SPACE_ID, agentId: agent.id, source: 'space', topic });
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      longHorizonAgentRepo: repo,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      externalEventStore: store,
      artifactRepo: new WorkflowRunArtifactRepository(db),
      deliverLongHorizonExternalEvent: async ({ agentId, message }) => {
        longHorizonMessages.push({ agentId, message });
        return { delivered: true };
      },
    });
    return { agentId: agent.id };
  }

  test('coordinator subscribed to space/task.* wakes on blocked + done transitions', async () => {
    const { agentId } = setupCoordinatorSubscription('task.*');
    await runtime.rehydrateExecutors();

    const emitter = new SpaceLifecycleEventEmitter(service);
    const manager = new SpaceTaskManager(db, SPACE_ID, undefined, undefined, emitter);

    const task = await manager.createTask({ title: 'E2E task', description: '' });
    await manager.startTask(task.id); // open → in_progress
    await manager.setTaskStatus(task.id, 'blocked'); // in_progress → blocked
    await manager.setTaskStatus(task.id, 'in_progress'); // blocked → in_progress (re-transition)
    await manager.completeTask(task.id, 'shipped'); // in_progress → done

    const topics = longHorizonMessages.map((m) => JSON.parse(m.message).topic as string);
    // created, in_progress, blocked, in_progress (re-transition still emits), done.
    expect(topics).toEqual([
      'space/task.created',
      'space/task.in_progress',
      'space/task.blocked',
      'space/task.in_progress',
      'space/task.done',
    ]);
    expect(longHorizonMessages.every((m) => m.agentId === agentId)).toBe(true);
    // Source event terminalized after delivery.
    expect(
      (
        db
          .prepare(`SELECT state FROM space_external_events WHERE topic = 'space/task.done'`)
          .get() as { state: string }
      ).state
    ).toBe('delivered');
  });

  test('space/goal.* subscription receives goal task_triggered and status events', async () => {
    const { agentId } = setupCoordinatorSubscription('goal.*');
    await runtime.rehydrateExecutors();

    const emitter = new SpaceLifecycleEventEmitter(service);
    await emitter.emitGoalTaskTriggered(makeGoal({ id: 'g1', spaceId: SPACE_ID }), 'goal-task-1');
    await emitter.emitGoalStatusChanged(
      makeGoal({ id: 'g1', spaceId: SPACE_ID, status: 'completed', updatedAt: 4_000 }),
      'active'
    );

    const topics = longHorizonMessages.map((m) => JSON.parse(m.message).topic as string);
    // Completion emits both space/goal.status and space/goal.done (the latter
    // matches the marketing template's goal.done subscription).
    expect(topics).toEqual(['space/goal.task_triggered', 'space/goal.done', 'space/goal.status']);
    expect(longHorizonMessages.every((m) => m.agentId === agentId)).toBe(true);
  });

  test('event with no matching subscription is ignored without error', async () => {
    // No LH agent subscribed to anything.
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      externalEventStore: store,
      artifactRepo: new WorkflowRunArtifactRepository(db),
      deliverLongHorizonExternalEvent: async () => ({ delivered: true }),
    });
    await runtime.rehydrateExecutors();

    const emitter = new SpaceLifecycleEventEmitter(service);
    // Publishes without throwing — the topic validates (source 'space' is known,
    // 2-segment literal shape is accepted) and an unknown sub-topic is fine.
    await emitter.emitTaskStatusChanged(
      makeTask({ id: 't-none', spaceId: SPACE_ID, status: 'done', updatedAt: 8_000 }),
      'in_progress'
    );

    // No subscription matched → nothing delivered to any agent.
    expect(longHorizonMessages).toHaveLength(0);
    // The event was stored (proving the publish path accepted the space-source topic).
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM space_external_events WHERE source = 'space'`)
          .get() as { c: number }
      ).c
    ).toBe(1);
  });

  test('runtime mutation paths (updateTaskAndEmit) publish space/task.<status>', async () => {
    const published: ExternalEvent[] = [];
    const emitter = new SpaceLifecycleEventEmitter({
      publish: async (event) => {
        published.push(event);
        return { outcome: 'published', eventId: event.id };
      },
    });
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      externalEventStore: store,
      artifactRepo: new WorkflowRunArtifactRepository(db),
      lifecycleEventEmitter: emitter,
      deliverLongHorizonExternalEvent: async () => ({ delivered: true }),
    });
    await runtime.rehydrateExecutors();

    // Create an in_progress task directly via the repo (bypassing the manager) so
    // the only emit path is the runtime's updateTaskAndEmit.
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Runtime task',
      description: '',
      status: 'in_progress',
    });

    // blockWorkflowBackedTask is a thin public wrapper over updateTaskAndEmit,
    // which writes taskRepo directly (not via SpaceTaskManager.setTaskStatus).
    await runtime.blockWorkflowBackedTask(SPACE_ID, task.id, { status: 'blocked' });

    const blocked = published.find((e) => e.topic === 'space/task.blocked');
    expect(blocked).toBeDefined();
    expect(blocked!.payload).toMatchObject({ from: 'in_progress', to: 'blocked', taskId: task.id });
  });
});
