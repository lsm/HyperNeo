import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import type {
  NodeExecutionStatus,
  SpaceTask,
  SpaceTaskStatus,
  SpaceWorkflow,
} from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import { renderEventBlock } from '../../../../src/lib/external-events/deferred-event-digest';
import { essenceEntryFromExternalEvent } from '../../../../src/lib/external-events/event-essence-entry';
import { ExternalEventQueueMetrics } from '../../../../src/lib/external-events/queue-health-metrics';
import type {
  ExternalEvent,
  ExternalEventDeliveryRecord,
} from '../../../../src/lib/external-events/types';
import { createInternalCommandBus } from '../../../../src/lib/internal-command-bus';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import {
  parsePositiveIntegerEnv,
  SpaceRuntime,
} from '../../../../src/lib/space/runtime/space-runtime';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import { CodingArtifactProfile } from '../../../../src/lib/space/workflows/coding-artifact-profile';
import type { WorkflowArtifactProfile } from '../../../../src/lib/space/runtime/artifact-profile';
import { createSpaceTables } from '../../helpers/space-test-db';

setDefaultTimeout(10_000);

const SPACE_ID = 'space-runtime-events';
const AGENT_ID = 'agent-runtime-events';
const DEFAULT_TOPIC = 'github/*/*/pull_request/*.review_*';

describe('parsePositiveIntegerEnv', () => {
  test('rejects fractional and non-positive values', () => {
    const previous = process.env.TEST_POSITIVE_INTEGER_ENV;
    try {
      process.env.TEST_POSITIVE_INTEGER_ENV = '0.5';
      expect(parsePositiveIntegerEnv('TEST_POSITIVE_INTEGER_ENV', 10)).toBe(10);

      process.env.TEST_POSITIVE_INTEGER_ENV = '0';
      expect(parsePositiveIntegerEnv('TEST_POSITIVE_INTEGER_ENV', 10)).toBe(10);

      process.env.TEST_POSITIVE_INTEGER_ENV = '11';
      expect(parsePositiveIntegerEnv('TEST_POSITIVE_INTEGER_ENV', 10)).toBe(11);
    } finally {
      if (previous === undefined) {
        delete process.env.TEST_POSITIVE_INTEGER_ENV;
      } else {
        process.env.TEST_POSITIVE_INTEGER_ENV = previous;
      }
    }
  });
});

function makeDb(): Database {
  const db = new Database(':memory:');
  createSpaceTables(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(SPACE_ID, SPACE_ID, '/tmp/runtime-events', 'Runtime Events', now, now);
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, tools, system_prompt, created_at, updated_at)
		 VALUES (?, ?, ?, '', '[]', '', ?, ?)`
  ).run(AGENT_ID, SPACE_ID, 'Coder', now, now);
  return db;
}

function makeEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    spaceId: SPACE_ID,
    source: 'github',
    topic: 'github/lsm/neokai/pull_request/42.review_submitted',
    occurredAt: 1_700_000_000_000,
    ingestedAt: 1_700_000_001_000,
    dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
    summary: 'PR review submitted',
    payload: { action: 'review_submitted', prNumber: 42 },
    ...overrides,
  };
}

class MockTaskAgentManager {
  alive = new Set<string>();
  processingStates = new Map<string, string>();
  interrupting = new Set<string>();
  spawned: string[] = [];
  activationCalls: Array<{
    taskId: string;
    workflowRunId: string;
    agentName: string;
    options?: { workflowNodeId?: string };
  }> = [];
  activationResult: Array<{ agentName: string; sessionId: string }> = [];
  activationError: Error | null = null;
  onActivate: (() => void) | null = null;
  onSpawn: ((executionId: string, sessionId: string) => void) | null = null;

  isSessionAlive(sessionId: string): boolean {
    return this.alive.has(sessionId);
  }

  isSessionInMemory(sessionId: string): boolean {
    return this.isSessionAlive(sessionId);
  }

  getAgentSessionById(sessionId: string): {
    getProcessingState: () => { status: string };
    isInterruptInProgress: () => boolean;
    normalizeStaleInterruptedState: () => Promise<void>;
  } | null {
    const status = this.processingStates.get(sessionId);
    if (status === undefined) return null;
    return {
      getProcessingState: () => ({ status }),
      isInterruptInProgress: () => this.interrupting.has(sessionId),
      normalizeStaleInterruptedState: async () => {
        if (status === 'interrupted' && !this.interrupting.has(sessionId)) {
          this.processingStates.set(sessionId, 'idle');
        }
      },
    };
  }

  async rehydrate(): Promise<void> {}

  isExecutionSpawning(_executionId: string): boolean {
    return false;
  }

  async tryResumeNodeAgentSession(): Promise<void> {}

  cancelBySessionId(sessionId: string): void {
    this.alive.delete(sessionId);
  }

  async prepareSubSessionForWorkflowResume(): Promise<boolean> {
    return true;
  }

  async flushPendingMessagesForTarget(): Promise<void> {}

  async activateTargetSessionsForMessage(
    taskId: string,
    workflowRunId: string,
    agentName: string,
    options?: { workflowNodeId?: string }
  ): Promise<Array<{ agentName: string; sessionId: string }>> {
    this.activationCalls.push({
      taskId,
      workflowRunId,
      agentName,
      options: options?.workflowNodeId ? { workflowNodeId: options.workflowNodeId } : undefined,
    });
    if (this.activationError) throw this.activationError;
    this.onActivate?.();
    for (const result of this.activationResult) {
      this.alive.add(result.sessionId);
    }
    return this.activationResult;
  }

  async spawnWorkflowNodeAgentForExecution(
    _task: unknown,
    _space: unknown,
    _workflow: unknown,
    _run: unknown,
    execution: { id: string },
    _options?: unknown
  ): Promise<string> {
    const sessionId = `session-${execution.id}`;
    this.spawned.push(sessionId);
    this.alive.add(sessionId);
    this.onSpawn?.(execution.id, sessionId);
    return sessionId;
  }
}

describe('SpaceRuntime external event subscriptions', () => {
  let db: Database;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let artifactRepo: WorkflowRunArtifactRepository;
  let artifactProfile: WorkflowArtifactProfile;
  let workflowManager: SpaceWorkflowManager;
  let runtime: SpaceRuntime;
  let eventStore: ExternalEventStore;
  let eventService: ExternalEventService;
  let injected: Array<{ sessionId: string; message: string; deliveryMode?: string }>;
  let injectShouldFail: boolean;
  let longHorizonMessages: Array<{ agentId: string; message: string; idempotencyKey?: string }>;
  let tam: MockTaskAgentManager;
  let bus: ReturnType<typeof createDaemonInternalEventBus>;
  let spaceManager: SpaceManager;

  function createWorkflow(
    nodeId = 'code',
    options: { eventInterests?: Array<{ topic: string }>; spaceId?: string } = {}
  ): SpaceWorkflow {
    return workflowManager.createWorkflow({
      spaceId: options.spaceId ?? SPACE_ID,
      name: `Workflow ${Math.random()}`,
      description: '',
      nodes: [
        {
          id: nodeId,
          name: 'Code',
          agents: [
            {
              agentId: AGENT_ID,
              name: 'coder',
              ...(options.eventInterests ? { eventInterests: options.eventInterests } : {}),
            },
          ],
        },
      ],
      transitions: [],
      startNodeId: nodeId,
      rules: [],
      tags: [],
    });
  }

  async function startRunWithSubscription(
    topic = DEFAULT_TOPIC,
    nodeId = 'code',
    options: { staticInterest?: boolean } = {}
  ): Promise<{
    workflow: SpaceWorkflow;
    run: Awaited<ReturnType<typeof runtime.startWorkflowRun>>['run'];
    task: SpaceTask;
  }> {
    const workflow = createWorkflow(
      nodeId,
      options.staticInterest ? { eventInterests: [{ topic }] } : {}
    );
    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const task = tasks[0]!;
    if (!options.staticInterest) {
      runtime.registerSubscription(run.id, task.id, nodeId, 'coder', topic);
    }
    return { workflow, run, task };
  }

  function stampRunPr(runId: string, url: string): void {
    artifactRepo.upsert({
      id: `art-pr-${runId}`,
      runId,
      nodeId: 'code',
      artifactType: 'link',
      artifactKey: 'pr',
      data: { kind: 'pr', url },
    });
  }

  beforeEach(() => {
    db = makeDb();
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    bus = createDaemonInternalEventBus();
    const commandBus = createInternalCommandBus();
    eventStore = new ExternalEventStore(db);
    eventService = new ExternalEventService(eventStore, bus);
    injected = [];
    injectShouldFail = false;
    longHorizonMessages = [];
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      if (injectShouldFail) {
        return { ok: false, error: 'recoverable injection failure' };
      }
      return { ok: true };
    });
    tam = new MockTaskAgentManager();
    artifactRepo = new WorkflowRunArtifactRepository(db);
    artifactProfile = new CodingArtifactProfile({ db, artifactRepo });
    spaceManager = new SpaceManager(db);
    runtime = new SpaceRuntime({
      db,
      spaceManager,
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      artifactRepo,
      artifactProfile,
      internalEventBus: bus,
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: true };
      },
    });
  });

  test('rehydrates long-horizon agent subscriptions and delivers matching events', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-events',
      spaceId: SPACE_ID,
      handle: 'watcher',
      displayName: 'Watcher',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: true };
      },
    });

    await runtime.rehydrateExecutors();
    const event = makeEvent();
    await eventService.publish(event);

    expect(longHorizonMessages).toHaveLength(1);
    expect(longHorizonMessages[0]!.agentId).toBe(agent.id);
    expect(longHorizonMessages[0]!.message).toBe(eventStore.getById(event.id)?.event.render);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    const deliveries = eventStore.listDeliveries(event.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.state).toBe('delivered');
    expect(longHorizonMessages[0]!.idempotencyKey).toBe(deliveries[0]!.deliveryKey);

    const snapshot = runtime.getQueueHealthSnapshot();
    expect(snapshot.counters.enqueue).toBe(1);
    expect(snapshot.counters.enqueueBySource['github']).toBe(1);
    expect(snapshot.counters.enqueueByTargetState).toEqual({ 'long_horizon=active': 1 });
  });

  test('requeue of a pending pre-migration event without a stored render derives the message from the record', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-legacy-render',
      spaceId: SPACE_ID,
      handle: 'legacy-watcher',
      displayName: 'Legacy Watcher',
    });
    const subscription = repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });

    const event = makeEvent();
    eventStore.store(event);
    expect(eventStore.getById(event.id)?.event.render).toBeUndefined();

    const deliveryKey = JSON.stringify([
      'long_horizon_agent',
      event.source,
      event.dedupeKey,
      SPACE_ID,
      agent.id,
      subscription.id,
    ]);
    eventStore.registerExpectedDelivery(event.id, deliveryKey, {
      workflowRunId: `long_horizon:${SPACE_ID}`,
      taskId: subscription.id,
      nodeId: agent.id,
      agentName: agent.id,
    });

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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: true };
      },
    });

    await runtime.rehydrateExecutors();

    expect(longHorizonMessages).toHaveLength(1);
    const entry = essenceEntryFromExternalEvent(eventStore.getById(event.id)!.event);
    expect(entry).not.toBeNull();
    expect(longHorizonMessages[0]!.message).toBe(renderEventBlock(entry!));
    expect(longHorizonMessages[0]!.message.length).toBeGreaterThan(0);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('rehydrates relative long-horizon agent subscriptions and matches full event topics', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-relative-events',
      spaceId: SPACE_ID,
      handle: 'relative-watcher',
      displayName: 'Relative Watcher',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: 'pull_request/*.review_*',
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: true };
      },
    });

    await runtime.rehydrateExecutors();
    const event = makeEvent();
    await eventService.publish(event);

    expect(longHorizonMessages).toHaveLength(1);
    expect(longHorizonMessages[0]!.agentId).toBe(agent.id);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('skips inactive long-horizon agent subscriptions during rehydration', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-paused',
      spaceId: SPACE_ID,
      handle: 'paused-watcher',
      displayName: 'Paused Watcher',
      status: 'disabled',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: true };
      },
    });

    await runtime.rehydrateExecutors();
    const event = makeEvent();
    await eventService.publish(event);

    expect(longHorizonMessages).toHaveLength(0);
    expect(eventStore.getById(event.id)?.state).toBe('published');
  });

  test('skips invalid persisted long-horizon subscriptions during rehydration', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-invalid-pattern',
      spaceId: SPACE_ID,
      handle: 'invalid-pattern-watcher',
      displayName: 'Invalid Pattern Watcher',
    });
    const subscription = repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: 'space/task.done',
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: true };
      },
    });

    await expect(runtime.rehydrateExecutors()).resolves.toBeUndefined();
    expect(runtime.refreshLongHorizonSubscription(SPACE_ID, subscription.id)).toEqual({
      success: false,
      error: 'Topic source "space" does not match source "github"',
    });
  });

  test('skips invalid existing long-horizon subscriptions during agent refresh', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-invalid-refresh',
      spaceId: SPACE_ID,
      handle: 'invalid-refresh-watcher',
      displayName: 'Invalid Refresh Watcher',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: 'space/task.done',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: true };
      },
    });

    expect(runtime.refreshLongHorizonAgentSubscriptions(SPACE_ID, agent.id)).toEqual({
      success: true,
    });
    await eventService.publish(makeEvent({ id: 'evt-after-invalid-refresh' }));
    expect(longHorizonMessages).toHaveLength(1);
  });

  test('refreshes trie entries after long-horizon agent status changes', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-status-refresh',
      spaceId: SPACE_ID,
      handle: 'status-refresh-watcher',
      displayName: 'Status Refresh Watcher',
      status: 'disabled',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: true };
      },
    });

    await runtime.rehydrateExecutors();
    await eventService.publish(makeEvent({ id: 'evt-before-reactivate' }));
    expect(longHorizonMessages).toHaveLength(0);

    repo.update(agent.id, { status: 'active' });
    expect(runtime.refreshLongHorizonAgentSubscriptions(SPACE_ID, agent.id)).toEqual({
      success: true,
    });
    await eventService.publish(makeEvent({ id: 'evt-after-reactivate' }));
    expect(longHorizonMessages).toHaveLength(1);

    repo.update(agent.id, { status: 'paused' });
    expect(runtime.refreshLongHorizonAgentSubscriptions(SPACE_ID, agent.id)).toEqual({
      success: true,
    });
    await eventService.publish(makeEvent({ id: 'evt-after-pause' }));
    expect(longHorizonMessages).toHaveLength(1);
  });

  test('clears pending long-horizon retries after agent pause', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-paused-retry',
      spaceId: SPACE_ID,
      handle: 'paused-retry-watcher',
      displayName: 'Paused Retry Watcher',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: false, error: 'temporary failure' };
      },
    });

    await runtime.rehydrateExecutors();
    await eventService.publish(makeEvent({ id: 'evt-paused-retry' }));
    expect(longHorizonMessages).toHaveLength(1);
    expect(runtime.hasPendingRetriesForAgent(SPACE_ID, agent.id)).toBe(true);

    repo.update(agent.id, { status: 'paused' });
    expect(runtime.refreshLongHorizonAgentSubscriptions(SPACE_ID, agent.id)).toEqual({
      success: true,
    });

    expect(runtime.hasPendingRetriesForAgent(SPACE_ID, agent.id)).toBe(false);
    const delivery = eventStore.listDeliveries('evt-paused-retry')[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('subscription_no_longer_active');
    expect(eventStore.getById('evt-paused-retry')?.state).toBe('failed');
    expect(longHorizonMessages).toHaveLength(1);
    await runtime.stop();
  });

  test('cancels long-horizon retry after subscription route changes', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-route-change',
      spaceId: SPACE_ID,
      handle: 'route-change-watcher',
      displayName: 'Route Change Watcher',
    });
    const subscription = repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: false };
      },
    });

    await runtime.rehydrateExecutors();
    await eventService.publish(makeEvent({ id: 'evt-route-change' }));
    expect(longHorizonMessages).toHaveLength(1);
    expect(runtime.hasPendingRetriesForAgent(SPACE_ID, agent.id)).toBe(true);

    repo.updateSubscription(subscription.id, { topic: 'github/*/*/pull_request/*.closed' });
    expect(runtime.refreshLongHorizonSubscription(SPACE_ID, subscription.id)).toEqual({
      success: true,
    });

    const delivery = eventStore.listDeliveries('evt-route-change')[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('subscription_no_longer_active');
    expect(runtime.hasPendingRetriesForAgent(SPACE_ID, agent.id)).toBe(false);
    await runtime.stop();
  });

  test('cancels in-flight long-horizon delivery after agent pause', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-inflight-pause',
      spaceId: SPACE_ID,
      handle: 'inflight-pause-watcher',
      displayName: 'Inflight Pause Watcher',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
    let resolveDelivery!: (value: { delivered: boolean }) => void;
    let resolveStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        resolveStarted();
        return new Promise<{ delivered: boolean }>((resolve) => {
          resolveDelivery = resolve;
        });
      },
    });

    await runtime.rehydrateExecutors();
    const publishPromise = eventService.publish(makeEvent({ id: 'evt-inflight-pause' }));
    await deliveryStarted;

    repo.update(agent.id, { status: 'paused' });
    expect(runtime.refreshLongHorizonAgentSubscriptions(SPACE_ID, agent.id)).toEqual({
      success: true,
    });

    const delivery = eventStore.listDeliveries('evt-inflight-pause')[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('subscription_no_longer_active');
    expect(runtime.hasPendingRetriesForAgent(SPACE_ID, agent.id)).toBe(false);

    resolveDelivery({ delivered: false });
    await publishPromise;

    expect(runtime.hasPendingRetriesForAgent(SPACE_ID, agent.id)).toBe(false);
    expect(longHorizonMessages).toHaveLength(1);
    expect(eventStore.getById('evt-inflight-pause')?.state).toBe('failed');
    await runtime.stop();
  });

  test('removes trie entries after long-horizon agent deletion', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-delete-refresh',
      spaceId: SPACE_ID,
      handle: 'delete-refresh-watcher',
      displayName: 'Delete Refresh Watcher',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: true };
      },
    });

    await runtime.rehydrateExecutors();
    runtime.removeLongHorizonAgentSubscriptions(SPACE_ID, agent.id);
    repo.delete(agent.id);
    await eventService.publish(makeEvent({ id: 'evt-after-delete' }));

    expect(longHorizonMessages).toHaveLength(0);
    expect(eventStore.getById('evt-after-delete')?.state).toBe('published');
  });

  test('keeps long-horizon events pending until every matched delivery succeeds', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const first = repo.create({
      id: 'lh-agent-first',
      spaceId: SPACE_ID,
      handle: 'first-watcher',
      displayName: 'First Watcher',
    });
    const second = repo.create({
      id: 'lh-agent-second',
      spaceId: SPACE_ID,
      handle: 'second-watcher',
      displayName: 'Second Watcher',
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: first.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
    repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: second.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
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
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
        longHorizonMessages.push({ agentId, message, idempotencyKey });
        return { delivered: agentId === first.id };
      },
    });

    await runtime.rehydrateExecutors();
    const event = makeEvent();
    await eventService.publish(event);

    expect(longHorizonMessages).toHaveLength(2);
    expect(eventStore.getById(event.id)?.state).toBe('published');
    const deliveries = eventStore.listDeliveries(event.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.state).sort()).toEqual(['delivered', 'pending']);
    await runtime.stop();
  });

  test('rehydrates subscriptions for done runs with review or approved tasks', async () => {
    for (const status of ['review', 'approved'] as const) {
      const { run, task } = await startRunWithSubscription(DEFAULT_TOPIC, `code-${status}`, {
        staticInterest: true,
      });
      taskRepo.updateTask(task.id, { status });
      workflowRunRepo.updateRun(run.id, { status: 'done' });
    }

    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      artifactRepo,
      artifactProfile,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });

    await runtime.rehydrateExecutors();
    const matches = (
      runtime as unknown as {
        lookupSubscriptionTargets(topic: string): Array<{ workflowRunId?: string }>;
      }
    ).lookupSubscriptionTargets(makeEvent().topic);

    expect(matches.map((match) => match.workflowRunId).filter(Boolean)).toHaveLength(2);
  });

  test('does not rehydrate workflow static interests for a completed task', async () => {
    const { run, task } = await startRunWithSubscription(DEFAULT_TOPIC, 'code-done-static', {
      staticInterest: true,
    });
    taskRepo.updateTask(task.id, { status: 'done', completedAt: Date.now() });
    workflowRunRepo.updateRun(run.id, { status: 'done', completedAt: Date.now() });

    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      artifactRepo,
      artifactProfile,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });

    await runtime.rehydrateExecutors();
    const matches = (
      runtime as unknown as {
        lookupSubscriptionTargets(topic: string): Array<{ workflowRunId?: string }>;
      }
    ).lookupSubscriptionTargets(DEFAULT_TOPIC);

    expect(matches.some((match) => match.workflowRunId === run.id)).toBe(false);
  });

  describe('immediate tier routing', () => {
    beforeEach(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS job_queue (
				id TEXT PRIMARY KEY,
				queue TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
				payload TEXT NOT NULL DEFAULT '{}',
				result TEXT,
				error TEXT,
				priority INTEGER NOT NULL DEFAULT 0,
				max_retries INTEGER NOT NULL DEFAULT 3,
				retry_count INTEGER NOT NULL DEFAULT 0,
				run_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				started_at TEXT,
				heartbeat_at INTEGER,
				completed_at TEXT
			)`);
    });

    function immediateEvent(): ExternalEvent {
      return makeEvent({
        payload: { action: 'review_submitted', prNumber: 42, state: 'CHANGES_REQUESTED' },
      });
    }

    async function attachLiveSession(sessionId: string, status: string): Promise<void> {
      const { run } = await startRunWithSubscription();
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: sessionId,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(sessionId, sessionId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      tam.alive.add(sessionId);
      tam.processingStates.set(sessionId, status);
    }

    test('immediate event delivers one steer message with the render text', async () => {
      await attachLiveSession('session-immediate-steer', 'processing');
      const event = immediateEvent();
      await eventService.publish(event);

      expect(injected).toHaveLength(0);
      const record = eventStore.getById(event.id)!;
      expect(record.event.urgency).toBe('immediate');
      expect(record.state).toBe('delivered');
      const deliveries = eventStore.listDeliveries(event.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.state).toBe('delivered');

      const rows = db
        .prepare(
          `SELECT sdk_message FROM sdk_messages WHERE session_id = 'session-immediate-steer'
           AND send_status = 'enqueued'`
        )
        .all() as Array<{ sdk_message: string }>;
      expect(rows).toHaveLength(1);
      const saved = JSON.parse(rows[0]!.sdk_message) as {
        message: { content: Array<{ type: string; text: string }> };
      };
      expect(saved.message.content).toHaveLength(1);
      expect(saved.message.content[0]!.text).toBe(record.event.render);
      expect(() => JSON.parse(record.event.render!)).toThrow();

      const jobs = db
        .prepare(
          `SELECT payload FROM job_queue WHERE queue = 'message_delivery'
           AND json_extract(payload, '$.sessionId') = 'session-immediate-steer'`
        )
        .all() as Array<{ payload: string }>;
      expect(jobs).toHaveLength(1);
      expect(JSON.parse(jobs[0]!.payload)).toMatchObject({
        sessionId: 'session-immediate-steer',
        role: 'steer',
        origin: 'space_inject',
      });
    });

    test('rate-budget overflow leaves the ledger pending for the digest tier', async () => {
      await attachLiveSession('session-immediate-budget', 'processing');
      const events = Array.from({ length: 11 }, () => immediateEvent());
      for (const event of events) {
        await eventService.publish(event);
      }

      const states = events.map((event) => eventStore.listDeliveries(event.id)[0]!.state);
      expect(states.filter((state) => state === 'delivered')).toHaveLength(10);
      expect(states.filter((state) => state === 'pending')).toHaveLength(1);
      expect(injected).toHaveLength(0);
    });

    test('a deferred immediate dispatch schedules a follow-up digest pull', async () => {
      await attachLiveSession('session-immediate-deferred', 'processing');
      const events = Array.from({ length: 11 }, () => immediateEvent());
      for (const event of events) {
        await eventService.publish(event);
      }
      const pendingEvents = events.filter(
        (event) => eventStore.listDeliveries(event.id)[0]!.state === 'pending'
      );
      expect(pendingEvents).toHaveLength(1);

      const deadline = Date.now() + 5000;
      let pendingState = 'pending';
      let digestRows: Array<{ id: string; sdk_uuid: string; send_status: string }> = [];
      while (Date.now() < deadline) {
        pendingState = eventStore.listDeliveries(pendingEvents[0]!.id)[0]!.state;
        digestRows = db
          .prepare(
            `SELECT id, sdk_uuid, send_status FROM sdk_messages
             WHERE session_id = 'session-immediate-deferred' AND sdk_uuid LIKE 'digest-%'`
          )
          .all() as Array<{ id: string; sdk_uuid: string; send_status: string }>;
        if (pendingState === 'delivered' && digestRows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(pendingState).toBe('delivered');
      expect(digestRows).toHaveLength(1);
      expect(digestRows[0]!.send_status).toBe('enqueued');

      const jobs = db
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .all() as Array<{ payload: string }>;
      const payloads = jobs.map((job) => JSON.parse(job.payload) as Record<string, unknown>);
      expect(
        payloads.some(
          (payload) =>
            payload.sessionId === 'session-immediate-deferred' &&
            payload.messageUuid === digestRows[0]!.sdk_uuid &&
            payload.role === 'turn' &&
            payload.origin === 'space_inject'
        )
      ).toBe(true);
    }, 10_000);

    test('a stale-session deferral leaves the ledger pending for reactivation', async () => {
      await attachLiveSession('session-immediate-stale', 'idle');
      tam.alive.delete('session-immediate-stale');
      const event = immediateEvent();
      await eventService.publish(event);

      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

      await new Promise((resolve) => setTimeout(resolve, 2500));

      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
      const digestRows = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = 'session-immediate-stale'
           AND sdk_uuid LIKE 'digest-%'`
        )
        .get() as { n: number };
      expect(digestRows.n).toBe(0);
    }, 10_000);

    test('a delivered immediate event still records an enqueue counter', async () => {
      await attachLiveSession('session-immediate-enqueue', 'processing');
      const event = immediateEvent();
      await eventService.publish(event);

      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
      const snapshot = runtime.getQueueHealthSnapshot();
      expect(snapshot.counters.enqueue).toBe(1);
      expect(snapshot.counters.enqueueBySource['github']).toBe(1);
      expect(snapshot.counters.enqueueByTargetState).toEqual({
        'run=in_progress;node=in_progress': 1,
      });
      expect(snapshot.gauges.queueDepth).toBe(0);
      expect(snapshot.gauges.queueKeys).toBe(0);
      expect(snapshot.gauges.queueAgeMs).toBeNull();
    });
  });

  describe('queue health snapshot', () => {
    test('digest tier: enqueue counters increment per registered delivery and gauges track the persisted summary', async () => {
      const { run } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const events = [
        makeEvent({
          id: 'evt-queue-health-a',
          topic: 'github/lsm/neokai/pull_request/42.comment_polled',
        }),
        makeEvent({
          id: 'evt-queue-health-b',
          topic: 'github/lsm/neokai/pull_request/42.comment_polled',
        }),
      ];
      for (const event of events) {
        await eventService.publish(event);
        expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
      }

      const frozenNow = Date.now();
      const originalNow = Date.now;
      Date.now = () => frozenNow;
      let snapshot: ReturnType<typeof runtime.getQueueHealthSnapshot>;
      let persisted: ReturnType<typeof eventStore.summarizePendingDeliveries>;
      try {
        snapshot = runtime.getQueueHealthSnapshot();
        persisted = eventStore.summarizePendingDeliveries(frozenNow);
      } finally {
        Date.now = originalNow;
      }

      expect(snapshot.counters.enqueue).toBe(2);
      expect(snapshot.counters.enqueueBySource['github']).toBe(2);
      expect(snapshot.counters.enqueueByTargetState).toEqual({ 'run=in_progress;node=idle': 2 });

      expect(snapshot.gauges.queueDepth).toBe(2);
      expect(snapshot.gauges.queueDepth).toBe(persisted!.count);
      expect(snapshot.gauges.queueKeys).toBe(persisted!.distinctTargets);
      expect(snapshot.gauges.queueKeys).toBe(1);
      expect(snapshot.gauges.persistedPending).toBe(2);
      expect(snapshot.gauges.queueAgeMs).toEqual(persisted);
      expect(snapshot.gauges.persistedAgeMs).toEqual(persisted);
      expect(snapshot.gauges.queueAgeMs!.count).toBe(2);
    });
  });

  describe('turn-end digest pull', () => {
    beforeEach(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS job_queue (
				id TEXT PRIMARY KEY,
				queue TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
				payload TEXT NOT NULL DEFAULT '{}',
				result TEXT,
				error TEXT,
				priority INTEGER NOT NULL DEFAULT 0,
				max_retries INTEGER NOT NULL DEFAULT 3,
				retry_count INTEGER NOT NULL DEFAULT 0,
				run_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				started_at TEXT,
				heartbeat_at INTEGER,
				completed_at TEXT
			)`);
    });

    test('renders the pending queued set as one digest row and marks the ledger delivered', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const events = [
        makeEvent({
          id: 'evt-digest-a',
          topic: 'github/lsm/neokai/pull_request/42.comment_polled',
        }),
        makeEvent({
          id: 'evt-digest-b',
          topic: 'github/lsm/neokai/pull_request/42.comment_polled',
        }),
      ];
      for (const event of events) {
        await eventService.publish(event);
        expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
      }

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-digest-pull',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-digest-pull',
        'session-digest-pull',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );

      const outcome = await runtime.renderPendingDigestForSession('session-digest-pull', task.id);
      expect(outcome).toMatchObject({ action: 'delivered' });

      const rows = db
        .prepare(
          `SELECT sdk_message FROM sdk_messages WHERE session_id = 'session-digest-pull'
           AND send_status = 'deferred'`
        )
        .all() as Array<{ sdk_message: string }>;
      expect(rows).toHaveLength(1);
      const saved = JSON.parse(rows[0]!.sdk_message) as {
        uuid: string;
        message: { content: Array<{ type: string; text: string }> };
      };
      expect(String(saved.uuid).startsWith('digest-')).toBe(true);
      expect(saved.message.content[0]!.text).toContain('External events while you were working');
      expect(saved.message.content[0]!.text).toContain('PR comment');

      for (const event of events) {
        expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
        expect(eventStore.getById(event.id)?.state).toBe('delivered');
      }

      expect(await runtime.renderPendingDigestForSession('session-digest-pull', task.id)).toEqual({
        action: 'skip',
        reason: 'no_pending_events',
      });
    });

    test('a session with no node execution is not a digest target', async () => {
      expect(await runtime.renderPendingDigestForSession('session-unknown')).toEqual({
        action: 'skip',
        reason: 'no_execution',
      });
    });

    test('an obsolete crash-replay digest is superseded when a fresh digest delivers', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const survivor = makeEvent({ id: 'evt-supersede-a', topic });
      const dead = makeEvent({ id: 'evt-supersede-b', topic });
      await eventService.publish(survivor);
      await eventService.publish(dead);

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-supersede',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-supersede',
        'session-supersede',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );

      const messages = new SDKMessageRepository(db);
      const orphan = {
        type: 'user',
        uuid: 'digest-orphan-superseded',
        session_id: 'session-supersede',
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'stale digest text' }] },
        externalEventIds: [survivor.id, dead.id],
      } as unknown as SDKUserMessage;
      messages.saveUserMessage('session-supersede', orphan, 'deferred', 'system');

      const deadDelivery = eventStore.listDeliveries(dead.id)[0]!;
      eventStore.markDeliveryFailed(dead.id, deadDelivery.deliveryKey, {
        terminal: true,
        reason: 'subscription_no_longer_active',
      });
      eventStore.markEventFailedIfAllDeliveriesTerminal(dead.id);

      const outcome = await runtime.renderPendingDigestForSession('session-supersede', task.id);
      expect(outcome).toMatchObject({ action: 'delivered' });

      const rows = db
        .prepare(
          `SELECT sdk_uuid FROM sdk_messages WHERE session_id = 'session-supersede'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .all() as Array<{ sdk_uuid: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sdk_uuid).not.toBe('digest-orphan-superseded');
    });

    test('a crash-replay digest subset is superseded by a broader delivered digest', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const first = makeEvent({ id: 'evt-subset-a', topic });
      const second = makeEvent({ id: 'evt-subset-b', topic });
      await eventService.publish(first);
      await eventService.publish(second);

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-subset',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-subset',
        'session-subset',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );

      const messages = new SDKMessageRepository(db);
      const orphan = {
        type: 'user',
        uuid: 'digest-orphan-subset',
        session_id: 'session-subset',
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'stale subset digest' }] },
        externalEventIds: [first.id],
      } as unknown as SDKUserMessage;
      messages.saveUserMessage('session-subset', orphan, 'deferred', 'system');

      const outcome = await runtime.renderPendingDigestForSession('session-subset', task.id);
      expect(outcome).toMatchObject({ action: 'delivered', eventIds: [first.id, second.id] });

      const rows = db
        .prepare(
          `SELECT sdk_uuid FROM sdk_messages WHERE session_id = 'session-subset'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .all() as Array<{ sdk_uuid: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sdk_uuid).not.toBe('digest-orphan-subset');
    });

    test('a digest mixing delivered and pending members is superseded', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const elsewhere = makeEvent({ id: 'evt-overlap-a', topic });
      const pending = makeEvent({ id: 'evt-overlap-b', topic });
      await eventService.publish(elsewhere);
      await eventService.publish(pending);
      const elsewhereDelivery = eventStore.listDeliveries(elsewhere.id)[0]!;
      eventStore.markDeliveryDelivered(elsewhere.id, elsewhereDelivery.deliveryKey);
      eventStore.markEventDeliveredIfAllDeliveriesDelivered(elsewhere.id);
      expect(eventStore.getById(elsewhere.id)?.state).toBe('delivered');

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-overlap',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-overlap',
        'session-overlap',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );

      const messages = new SDKMessageRepository(db);
      const orphan = {
        type: 'user',
        uuid: 'digest-orphan-overlap',
        session_id: 'session-overlap',
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'stale overlap digest' }] },
        externalEventIds: [elsewhere.id, pending.id],
      } as unknown as SDKUserMessage;
      messages.saveUserMessage('session-overlap', orphan, 'deferred', 'system');

      const outcome = await runtime.renderPendingDigestForSession('session-overlap', task.id);
      expect(outcome).toMatchObject({ action: 'delivered', eventIds: [pending.id] });

      const rows = db
        .prepare(
          `SELECT sdk_uuid FROM sdk_messages WHERE session_id = 'session-overlap'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .all() as Array<{ sdk_uuid: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sdk_uuid).not.toBe('digest-orphan-overlap');
    });

    test('supersede uses this target delivery state for fan-out events', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const fanout = makeEvent({ id: 'evt-fanout-a', topic });
      const pending = makeEvent({ id: 'evt-fanout-b', topic });
      await eventService.publish(fanout);
      await eventService.publish(pending);
      eventStore.registerExpectedDelivery(fanout.id, 'delivery-fanout-other', {
        workflowRunId: run.id,
        taskId: task.id,
        nodeId: 'review',
        agentName: 'reviewer',
      });
      const codeDelivery = eventStore
        .listDeliveries(fanout.id)
        .find((delivery) => delivery.nodeId === 'code')!;
      eventStore.markDeliveryDelivered(fanout.id, codeDelivery.deliveryKey);
      expect(eventStore.getById(fanout.id)?.state).toBe('published');

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-fanout',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-fanout',
        'session-fanout',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );

      const messages = new SDKMessageRepository(db);
      const orphan = {
        type: 'user',
        uuid: 'digest-orphan-fanout',
        session_id: 'session-fanout',
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'stale fanout digest' }] },
        externalEventIds: [fanout.id, pending.id],
      } as unknown as SDKUserMessage;
      messages.saveUserMessage('session-fanout', orphan, 'deferred', 'system');

      const outcome = await runtime.renderPendingDigestForSession('session-fanout', task.id);
      expect(outcome).toMatchObject({ action: 'delivered', eventIds: [pending.id] });

      const rows = db
        .prepare(
          `SELECT sdk_uuid FROM sdk_messages WHERE session_id = 'session-fanout'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .all() as Array<{ sdk_uuid: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sdk_uuid).not.toBe('digest-orphan-fanout');
    });

    test('a delivered-but-unflushed digest survives a no-pending pull', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const event = makeEvent({ id: 'evt-skip-supersede', topic });
      await eventService.publish(event);
      const delivery = eventStore.listDeliveries(event.id)[0]!;
      eventStore.markDeliveryDelivered(event.id, delivery.deliveryKey);
      eventStore.markEventDeliveredIfAllDeliveriesDelivered(event.id);
      expect(eventStore.getById(event.id)?.state).toBe('delivered');

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-skip-supersede',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-skip-supersede',
        'session-skip-supersede',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );

      const messages = new SDKMessageRepository(db);
      const orphan = {
        type: 'user',
        uuid: 'digest-orphan-skip',
        session_id: 'session-skip-supersede',
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'delivered unflushed digest' }] },
        externalEventIds: [event.id],
      } as unknown as SDKUserMessage;
      messages.saveUserMessage('session-skip-supersede', orphan, 'deferred', 'system');

      const outcome = await runtime.renderPendingDigestForSession(
        'session-skip-supersede',
        task.id
      );
      expect(outcome).toEqual({ action: 'skip', reason: 'no_pending_events' });

      const rows = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = 'session-skip-supersede'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .get() as { n: number };
      expect(rows.n).toBe(1);
    });

    test('another task inadmissible pull keeps a delivered digest owned by a sibling task', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const event = makeEvent({ id: 'evt-cross-task-drop', topic });
      await eventService.publish(event);
      const delivery = eventStore.listDeliveries(event.id)[0]!;
      eventStore.markDeliveryDelivered(event.id, delivery.deliveryKey);

      const secondTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Second task',
        status: 'stopped',
        workflowRunId: run.id,
      });

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-cross-task-drop',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-cross-task-drop',
        'session-cross-task-drop',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );

      const messages = new SDKMessageRepository(db);
      const owed = {
        type: 'user',
        uuid: 'digest-owed-cross-task',
        session_id: 'session-cross-task-drop',
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'handoff pending digest' }] },
        externalEventIds: [event.id],
      } as unknown as SDKUserMessage;
      messages.saveUserMessage('session-cross-task-drop', owed, 'deferred', 'system');

      const outcome = await runtime.renderPendingDigestForSession(
        'session-cross-task-drop',
        secondTask.id
      );
      expect(outcome).toEqual({ action: 'skip', reason: 'no_pending_events' });
      expect(eventStore.listDeliveries(event.id)[0]!.taskId).toBe(task.id);

      const rows = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = 'session-cross-task-drop'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .get() as { n: number };
      expect(rows.n).toBe(1);
    });

    test('supersede obsoletes a deferred digest whose members are terminal under a sibling task', async () => {
      const topicA = 'github/lsm/neokai/pull_request/42.comment_polled';
      const topicB = 'github/lsm/neokai/pull_request/42.review_submitted';
      const { run, task } = await startRunWithSubscription(topicA);
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const secondTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Second task',
        status: 'open',
        workflowRunId: run.id,
      });
      expect(
        runtime.registerSubscription(run.id, secondTask.id, 'code', 'coder', topicB).success
      ).toBe(true);

      const siblingEvent = makeEvent({ id: 'evt-supersede-sibling', topic: topicA });
      const freshEvent = makeEvent({ id: 'evt-supersede-fresh', topic: topicB });
      await eventService.publish(siblingEvent);
      await eventService.publish(freshEvent);
      const siblingDelivery = eventStore.listDeliveries(siblingEvent.id)[0]!;
      eventStore.markDeliveryDelivered(siblingEvent.id, siblingDelivery.deliveryKey);

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-cross-task-supersede',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-cross-task-supersede',
        'session-cross-task-supersede',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );

      const messages = new SDKMessageRepository(db);
      const stale = {
        type: 'user',
        uuid: 'digest-stale-sibling',
        session_id: 'session-cross-task-supersede',
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'stale sibling digest' }] },
        externalEventIds: [siblingEvent.id],
      } as unknown as SDKUserMessage;
      messages.saveUserMessage('session-cross-task-supersede', stale, 'deferred', 'system');

      const outcome = await runtime.renderPendingDigestForSession(
        'session-cross-task-supersede',
        secondTask.id
      );
      expect(outcome).toMatchObject({ action: 'delivered', eventIds: [freshEvent.id] });

      const rows = db
        .prepare(
          `SELECT sdk_uuid FROM sdk_messages WHERE session_id = 'session-cross-task-supersede'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .all() as Array<{ sdk_uuid: string }>;
      expect(rows.some((row) => row.sdk_uuid === 'digest-stale-sibling')).toBe(false);
    });

    test('an admission-rejected pull drops the deferred digest rows', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });
      await eventService.publish(
        makeEvent({
          id: 'evt-admission-pending',
          topic: 'github/lsm/neokai/pull_request/42.comment_polled',
        })
      );
      expect(eventStore.listDeliveries('evt-admission-pending')[0]!.state).toBe('pending');

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-admission',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-admission',
        'session-admission',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
      taskRepo.updateTask(task.id, { status: 'stopped' });

      const messages = new SDKMessageRepository(db);
      const orphan = {
        type: 'user',
        uuid: 'digest-orphan-admission',
        session_id: 'session-admission',
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'stale admission digest' }] },
        externalEventIds: ['evt-never-published'],
      } as unknown as SDKUserMessage;
      messages.saveUserMessage('session-admission', orphan, 'deferred', 'system');

      const outcome = await runtime.renderPendingDigestForSession('session-admission', task.id);
      expect(outcome).toEqual({ action: 'skip', reason: 'task_not_admissible' });

      const rows = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = 'session-admission'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .get() as { n: number };
      expect(rows.n).toBe(0);
    });

    test('a digest with a mixed delivered/pending membership is dropped on a rejected pull', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const deliveredMember = makeEvent({ id: 'evt-mixed-delivered', topic });
      const pendingMember = makeEvent({ id: 'evt-mixed-pending', topic });
      await eventService.publish(deliveredMember);
      await eventService.publish(pendingMember);
      const deliveredDelivery = eventStore.listDeliveries(deliveredMember.id)[0]!;
      eventStore.markDeliveryDelivered(deliveredMember.id, deliveredDelivery.deliveryKey);
      eventStore.markEventDeliveredIfAllDeliveriesDelivered(deliveredMember.id);
      expect(eventStore.listDeliveries(pendingMember.id)[0]!.state).toBe('pending');

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-mixed',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-mixed',
        'session-mixed',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
      taskRepo.updateTask(task.id, { status: 'stopped' });

      const messages = new SDKMessageRepository(db);
      const orphan = {
        type: 'user',
        uuid: 'digest-orphan-mixed',
        session_id: 'session-mixed',
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'mixed membership digest' }] },
        externalEventIds: [deliveredMember.id, pendingMember.id],
      } as unknown as SDKUserMessage;
      messages.saveUserMessage('session-mixed', orphan, 'deferred', 'system');

      const outcome = await runtime.renderPendingDigestForSession('session-mixed', task.id);
      expect(outcome).toEqual({ action: 'skip', reason: 'task_not_admissible' });

      const rows = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = 'session-mixed'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .get() as { n: number };
      expect(rows.n).toBe(0);
    });

    test('handoff does not regress a digest row a concurrent flush already submitted', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      await eventService.publish(
        makeEvent({
          id: 'evt-handoff-race',
          topic: 'github/lsm/neokai/pull_request/42.comment_polled',
        })
      );

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-handoff-race',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-handoff-race',
        'session-handoff-race',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );

      const outcome = await runtime.renderPendingDigestForSession('session-handoff-race', task.id);
      expect(outcome).toMatchObject({ action: 'delivered' });
      const delivered = outcome as { action: 'delivered'; uuid: string; dbId: string };

      db.prepare(`UPDATE sdk_messages SET send_status = 'submitted' WHERE id = ?`).run(
        delivered.dbId
      );

      (
        runtime as unknown as {
          handoffDigestDelivery: (sessionId: string, messageUuid: string, dbId: string) => void;
        }
      ).handoffDigestDelivery('session-handoff-race', delivered.uuid, delivered.dbId);

      const status = (
        db
          .prepare(`SELECT send_status AS s FROM sdk_messages WHERE id = ?`)
          .get(delivered.dbId) as { s: string }
      ).s;
      expect(status).toBe('submitted');

      const jobs = db
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .all() as Array<{ payload: string }>;
      const payloads = jobs.map((job) => JSON.parse(job.payload) as Record<string, unknown>);
      expect(payloads.some((payload) => payload.messageUuid === delivered.uuid)).toBe(false);
    });

    test('flag on: an exhausted handoff retry protects the deferred digest from supersede', {
      timeout: 15_000,
    }, async () => {
      const previousIdleMs = process.env.HYPERNEO_EXTERNAL_EVENT_DIGEST_IDLE_DEBOUNCE_MS;
      process.env.HYPERNEO_EXTERNAL_EVENT_DIGEST_IDLE_DEBOUNCE_MS = '50';
      try {
        const topicA = 'github/lsm/neokai/pull_request/42.comment_polled';
        const topicB = 'github/lsm/neokai/pull_request/42.review_submitted';
        const { run, task } = await startRunWithSubscription(topicA);
        const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
        nodeExecutionRepo.update(execution.id, {
          status: 'in_progress',
          agentSessionId: 'session-handoff-exhaust',
          completedAt: null,
          startedAt: Date.now(),
        });
        db.prepare(
          `INSERT INTO sessions
             (id, title, created_at, last_active_at, status, config, metadata, type)
           VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
        ).run(
          'session-handoff-exhaust',
          'session-handoff-exhaust',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        );
        tam.alive.add('session-handoff-exhaust');

        db.exec('DROP TABLE job_queue');

        await eventService.publish(makeEvent({ id: 'evt-handoff-exhaust-a', topic: topicA }));
        await new Promise((resolve) => setTimeout(resolve, 5500));

        const secondTask = taskRepo.createTask({
          spaceId: SPACE_ID,
          title: 'Second task',
          status: 'open',
          workflowRunId: run.id,
        });
        expect(
          runtime.registerSubscription(run.id, secondTask.id, 'code', 'coder', topicB).success
        ).toBe(true);

        await eventService.publish(makeEvent({ id: 'evt-handoff-exhaust-b', topic: topicB }));
        await new Promise((resolve) => setTimeout(resolve, 150));

        const allRows = db
          .prepare(
            `SELECT sdk_uuid, send_status FROM sdk_messages
             WHERE session_id = 'session-handoff-exhaust' AND sdk_uuid LIKE 'digest-%'`
          )
          .all() as Array<{ sdk_uuid: string; send_status: string }>;
        const aDeliveries = eventStore.listDeliveries('evt-handoff-exhaust-a');
        const bDeliveries = eventStore.listDeliveries('evt-handoff-exhaust-b');
        const aDelivered = aDeliveries[0];
        const bDelivered = bDeliveries[0];
        expect(aDelivered?.state).toBe('delivered');
        expect(bDelivered?.state).toBe('delivered');
        const deferredRows = db
          .prepare(
            `SELECT sdk_uuid FROM sdk_messages WHERE session_id = 'session-handoff-exhaust'
             AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
          )
          .all() as Array<{ sdk_uuid: string }>;
        expect(deferredRows).toHaveLength(2);
      } finally {
        if (previousIdleMs === undefined) {
          delete process.env.HYPERNEO_EXTERNAL_EVENT_DIGEST_IDLE_DEBOUNCE_MS;
        } else {
          process.env.HYPERNEO_EXTERNAL_EVENT_DIGEST_IDLE_DEBOUNCE_MS = previousIdleMs;
        }
      }
    });
  });

  describe('idle/cap/safety digest pull', () => {
    const previousEnv: Record<string, string | undefined> = {};

    function setEnv(name: string, value: string): void {
      previousEnv[name] = process.env[name];
      process.env[name] = value;
    }

    function restoreEnv(): void {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }

    beforeEach(() => {
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_IDLE_DEBOUNCE_MS', '50');
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_COUNT_CAP', '100');
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_SAFETY_MS', '10000');
      injectShouldFail = true;
      db.exec(`
        CREATE TABLE IF NOT EXISTS job_queue (
          id TEXT PRIMARY KEY,
          queue TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
          payload TEXT NOT NULL DEFAULT '{}',
          result TEXT,
          error TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          retry_count INTEGER NOT NULL DEFAULT 0,
          run_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          heartbeat_at INTEGER,
          completed_at INTEGER
        )
      `);
    });

    afterEach(() => {
      restoreEnv();
    });

    async function startLiveSession(
      sessionId: string,
      topic = 'github/lsm/neokai/pull_request/42.comment_polled'
    ): Promise<{
      run: Awaited<ReturnType<typeof runtime.startWorkflowRun>>['run'];
      task: SpaceTask;
    }> {
      const { run, task } = await startRunWithSubscription(topic);
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: sessionId,
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(sessionId, sessionId, Date.now(), Date.now());
      tam.alive.add(sessionId);
      return { run, task };
    }

    function wait(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function digestRows(sessionId: string): Array<{ sdk_message: string; sdk_uuid: string }> {
      return db
        .prepare(
          `SELECT sdk_message, sdk_uuid FROM sdk_messages
           WHERE session_id = ? AND sdk_uuid LIKE 'digest-%' AND send_status = 'enqueued'`
        )
        .all(sessionId) as Array<{ sdk_message: string; sdk_uuid: string }>;
    }

    test('idle debounce flushes once', async () => {
      const { task } = await startLiveSession('session-idle');
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      await eventService.publish(makeEvent({ id: 'evt-idle-1', topic }));
      await eventService.publish(makeEvent({ id: 'evt-idle-2', topic }));
      await wait(150);

      const rows = digestRows('session-idle');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sdk_message).toContain(
        'External events while you were working (2 events, PR #42):'
      );
      expect(eventStore.listDeliveries('evt-idle-1')[0]?.state).toBe('delivered');
      expect(eventStore.listDeliveries('evt-idle-2')[0]?.state).toBe('delivered');
    });

    test('count cap fires despite an undelivered prior digest', async () => {
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_COUNT_CAP', '2');
      const { task } = await startLiveSession('session-cap');
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      await eventService.publish(makeEvent({ id: 'evt-cap-1', topic }));
      await wait(150);

      const first = digestRows('session-cap');
      expect(first).toHaveLength(1);
      expect(first[0]?.sdk_message).toContain('(1 event, PR #42):');

      await eventService.publish(makeEvent({ id: 'evt-cap-2', topic }));
      await eventService.publish(makeEvent({ id: 'evt-cap-3', topic }));
      await wait(50);

      const rows = digestRows('session-cap');
      expect(rows).toHaveLength(2);
      for (const eventId of ['evt-cap-1', 'evt-cap-2', 'evt-cap-3']) {
        expect(eventStore.listDeliveries(eventId)[0]?.state).toBe('delivered');
      }
    });

    test('safety timer unblocks a stuck session', async () => {
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_IDLE_DEBOUNCE_MS', '10000');
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_COUNT_CAP', '100');
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_SAFETY_MS', '50');
      const { task } = await startLiveSession('session-safety');
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      await eventService.publish(makeEvent({ id: 'evt-safety-1', topic }));
      await wait(150);

      const rows = digestRows('session-safety');
      expect(rows).toHaveLength(1);
      expect(eventStore.listDeliveries('evt-safety-1')[0]?.state).toBe('delivered');
    });

    test('two tasks sharing a session each get their pending rows rendered', async () => {
      const topicA = 'github/lsm/neokai/pull_request/42.comment_polled';
      const topicB = 'github/lsm/neokai/pull_request/42.review_submitted';
      const { run, task } = await startLiveSession('session-multi-task', topicA);
      const secondTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Second task',
        status: 'open',
        workflowRunId: run.id,
      });
      const registered = runtime.registerSubscription(
        run.id,
        secondTask.id,
        'code',
        'coder',
        topicB
      );
      expect(registered.success).toBe(true);

      await eventService.publish(makeEvent({ id: 'evt-multi-a', topic: topicA }));
      await eventService.publish(makeEvent({ id: 'evt-multi-b', topic: topicB }));
      await wait(150);

      const deliveryA = eventStore.listDeliveries('evt-multi-a')[0];
      const deliveryB = eventStore.listDeliveries('evt-multi-b')[0];
      expect(deliveryA?.taskId).toBe(task.id);
      expect(deliveryB?.taskId).toBe(secondTask.id);
      expect(deliveryA?.state).toBe('delivered');
      expect(deliveryB?.state).toBe('delivered');
      expect(digestRows('session-multi-task')).toHaveLength(2);
    });

    test('stop drains in-flight and queued digest renders before restart accepts new work', async () => {
      const { task } = await startLiveSession('session-stop-restart');
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      await eventService.publish(makeEvent({ id: 'evt-stop-restart-1', topic }));

      const repo = (
        runtime as unknown as { getSdkMessageRepo(): SDKMessageRepository }
      ).getSdkMessageRepo();
      const originalSave = (repo as unknown as { saveUserMessage: (...args: unknown[]) => unknown })
        .saveUserMessage as (...args: unknown[]) => string;
      let saveStarted = false;
      let unblockSave: ((value: string) => void) | null = null;
      const saveBlocker = new Promise<string>((resolve) => {
        unblockSave = resolve;
      });
      (repo as unknown as { saveUserMessage: (...args: unknown[]) => unknown }).saveUserMessage = (
        ...args: unknown[]
      ) => {
        saveStarted = true;
        return saveBlocker.then(() => originalSave.apply(repo, args)) as unknown as string;
      };

      const activeRender = runtime.renderPendingDigestForSession('session-stop-restart', task.id);
      const queuedRender = runtime.renderPendingDigestForSession('session-stop-restart', task.id);

      const start = Date.now();
      while (!saveStarted && Date.now() - start < 1000) {
        await wait(1);
      }
      expect(saveStarted).toBe(true);

      const stopPromise = runtime.stop();

      await wait(10);
      unblockSave!('db-blocked');
      await stopPromise;

      const activeOutcome = await activeRender;
      const queuedOutcome = await queuedRender;
      expect(activeOutcome?.action).toBe('delivered');
      expect(queuedOutcome).toBeNull();

      (repo as unknown as { saveUserMessage: (...args: unknown[]) => unknown }).saveUserMessage =
        originalSave;

      runtime.start();

      await eventService.publish(makeEvent({ id: 'evt-stop-restart-2', topic }));
      const postRestart = await runtime.renderPendingDigestForSession(
        'session-stop-restart',
        task.id
      );
      expect(postRestart?.action).toBe('delivered');

      expect(eventStore.listDeliveries('evt-stop-restart-1')[0]?.state).toBe('delivered');
      expect(eventStore.listDeliveries('evt-stop-restart-2')[0]?.state).toBe('delivered');
    });

    test('digest pull during an active interrupt holds, then delivers after it clears', async () => {
      await startLiveSession('session-interrupted');
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      tam.processingStates.set('session-interrupted', 'interrupted');
      tam.interrupting.add('session-interrupted');

      await eventService.publish(makeEvent({ id: 'evt-interrupt-1', topic }));
      await wait(150);

      expect(digestRows('session-interrupted')).toHaveLength(0);
      expect(eventStore.listDeliveries('evt-interrupt-1')[0]?.state).toBe('pending');

      tam.interrupting.delete('session-interrupted');
      tam.processingStates.set('session-interrupted', 'idle');
      await wait(1200);

      const rows = digestRows('session-interrupted');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sdk_message).toContain('(1 event, PR #42):');
      expect(eventStore.listDeliveries('evt-interrupt-1')[0]?.state).toBe('delivered');
    });

    test('digest pull stays held through an interrupt longer than the retry budget', async () => {
      await startLiveSession('session-long-interrupt');
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      tam.processingStates.set('session-long-interrupt', 'interrupted');
      tam.interrupting.add('session-long-interrupt');

      await eventService.publish(makeEvent({ id: 'evt-long-interrupt-1', topic }));
      await wait(6500);

      expect(digestRows('session-long-interrupt')).toHaveLength(0);
      expect(eventStore.listDeliveries('evt-long-interrupt-1')[0]?.state).toBe('pending');

      tam.interrupting.delete('session-long-interrupt');
      tam.processingStates.set('session-long-interrupt', 'idle');
      await wait(400);

      const rows = digestRows('session-long-interrupt');
      expect(rows).toHaveLength(1);
      expect(eventStore.listDeliveries('evt-long-interrupt-1')[0]?.state).toBe('delivered');
    });

    test('an event fanned out to two tasks on one session delivers both rows via one digest once consumed', async () => {
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const { run, task } = await startLiveSession('session-shared-event', topic);
      const secondTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Second task',
        status: 'open',
        workflowRunId: run.id,
      });
      expect(
        runtime.registerSubscription(run.id, secondTask.id, 'code', 'coder', topic).success
      ).toBe(true);

      await eventService.publish(makeEvent({ id: 'evt-shared-1', topic }));

      const deadline = Date.now() + 5000;
      let deliveredCount = 0;
      while (Date.now() < deadline) {
        deliveredCount = eventStore
          .listDeliveries('evt-shared-1')
          .filter((delivery) => delivery.state === 'delivered').length;
        if (deliveredCount === 1 && digestRows('session-shared-event').length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(deliveredCount).toBe(1);

      const deliveries = eventStore.listDeliveries('evt-shared-1');
      expect(deliveries).toHaveLength(2);
      expect(deliveries.filter((delivery) => delivery.state === 'delivered')).toHaveLength(1);
      expect(deliveries.filter((delivery) => delivery.state === 'pending')).toHaveLength(1);
      const deliveredRow = deliveries.find((delivery) => delivery.state === 'delivered')!;
      const heldRow = deliveries.find((delivery) => delivery.state === 'pending')!;
      expect([deliveredRow.taskId, heldRow.taskId].sort()).toEqual([task.id, secondTask.id].sort());
      expect(digestRows('session-shared-event')).toHaveLength(1);

      const digestUuid = digestRows('session-shared-event')[0]!.sdk_uuid;
      const messages = new SDKMessageRepository(db);
      const digestRow = messages
        .listUserMessagesByUuidPrefix('session-shared-event', 'digest-')
        .find((row) => row.uuid === digestUuid)!;
      messages.updateMessageStatus([digestRow.dbId], 'consumed');

      const settledDeadline = Date.now() + 5000;
      let allDelivered = false;
      while (Date.now() < settledDeadline) {
        allDelivered = eventStore
          .listDeliveries('evt-shared-1')
          .every((delivery) => delivery.state === 'delivered');
        if (allDelivered) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(allDelivered).toBe(true);

      const finalDigest = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = 'session-shared-event'
           AND sdk_uuid = ?`
        )
        .get(digestUuid) as { n: number };
      expect(finalDigest.n).toBe(1);
    }, 15_000);

    test('digest pull holds while an interrupt is requested but the interrupted state has not landed', async () => {
      await startLiveSession('session-early-interrupt');
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      tam.processingStates.set('session-early-interrupt', 'processing');
      tam.interrupting.add('session-early-interrupt');

      await eventService.publish(makeEvent({ id: 'evt-early-interrupt-1', topic }));
      await wait(150);

      expect(digestRows('session-early-interrupt')).toHaveLength(0);
      expect(eventStore.listDeliveries('evt-early-interrupt-1')[0]?.state).toBe('pending');

      tam.interrupting.delete('session-early-interrupt');
      tam.processingStates.set('session-early-interrupt', 'idle');
      await wait(1200);

      expect(digestRows('session-early-interrupt')).toHaveLength(1);
      expect(eventStore.listDeliveries('evt-early-interrupt-1')[0]?.state).toBe('delivered');
    });

    test('interrupt probing stays on the idle debounce and bypasses the count cap', async () => {
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_COUNT_CAP', '1');
      await startLiveSession('session-probe-cap');
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      tam.processingStates.set('session-probe-cap', 'interrupted');
      tam.interrupting.add('session-probe-cap');

      const runtimeSpy = runtime as unknown as {
        triggerDigestPullForSession: (sessionId: string, trigger: string) => void;
      };
      const originalTrigger = runtimeSpy.triggerDigestPullForSession.bind(runtime);
      let pulls = 0;
      runtimeSpy.triggerDigestPullForSession = (sessionId: string, trigger: string) => {
        pulls += 1;
        return originalTrigger(sessionId, trigger);
      };

      await eventService.publish(makeEvent({ id: 'evt-probe-cap-1', topic }));
      await wait(400);
      const pullsDuringInterrupt = pulls;

      tam.interrupting.delete('session-probe-cap');
      tam.processingStates.set('session-probe-cap', 'idle');
      await wait(300);

      expect(pullsDuringInterrupt).toBeLessThanOrEqual(12);
      expect(digestRows('session-probe-cap')).toHaveLength(1);
      expect(eventStore.listDeliveries('evt-probe-cap-1')[0]?.state).toBe('delivered');
    });

    test('supersede preserves a sibling task digest awaiting its handoff retry', async () => {
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_COUNT_CAP', '1');
      db.exec('DROP TABLE job_queue');
      const topicA = 'github/lsm/neokai/pull_request/42.comment_polled';
      const topicB = 'github/lsm/neokai/pull_request/42.review_submitted';
      const { run, task } = await startLiveSession('session-preserve-handoff', topicA);
      const secondTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Second task',
        status: 'open',
        workflowRunId: run.id,
      });
      expect(
        runtime.registerSubscription(run.id, secondTask.id, 'code', 'coder', topicB).success
      ).toBe(true);

      await eventService.publish(makeEvent({ id: 'evt-preserve-a', topic: topicA }));
      await wait(150);
      const firstDigestRows = db
        .prepare(
          `SELECT sdk_uuid FROM sdk_messages WHERE session_id = 'session-preserve-handoff'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .all() as Array<{ sdk_uuid: string }>;
      expect(firstDigestRows).toHaveLength(1);
      expect(eventStore.listDeliveries('evt-preserve-a')[0]?.state).toBe('delivered');

      await eventService.publish(makeEvent({ id: 'evt-preserve-b', topic: topicB }));
      await wait(150);

      const deferredRows = db
        .prepare(
          `SELECT sdk_uuid FROM sdk_messages WHERE session_id = 'session-preserve-handoff'
           AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
        )
        .all() as Array<{ sdk_uuid: string }>;
      expect(deferredRows).toHaveLength(2);
      expect(deferredRows.some((row) => row.sdk_uuid === firstDigestRows[0]!.sdk_uuid)).toBe(true);
    });

    test('flag on: a dead session clears the digest pull probe state', async () => {
      const { task } = await startLiveSession('session-dead-probe');
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      tam.alive.delete('session-dead-probe');

      await eventService.publish(makeEvent({ id: 'evt-dead-probe', topic }));
      await wait(150);

      const triggers = (runtime as unknown as { digestPullTriggers: Map<string, unknown> })
        .digestPullTriggers;
      expect(triggers.has('session-dead-probe')).toBe(false);
      expect(digestRows('session-dead-probe')).toHaveLength(0);
      expect(eventStore.listDeliveries('evt-dead-probe')[0]?.state).toBe('pending');
    });

    test('flag on: concurrent digest pulls for different task scopes do not coalesce', async () => {
      const topicA = 'github/lsm/neokai/pull_request/42.comment_polled';
      const topicB = 'github/lsm/neokai/pull_request/42.review_submitted';
      const { run, task } = await startLiveSession('session-coalesce', topicA);
      const secondTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Second task',
        status: 'open',
        workflowRunId: run.id,
      });
      expect(
        runtime.registerSubscription(run.id, secondTask.id, 'code', 'coder', topicB).success
      ).toBe(true);

      await eventService.publish(makeEvent({ id: 'evt-coalesce-a', topic: topicA }));
      await eventService.publish(makeEvent({ id: 'evt-coalesce-b', topic: topicB }));

      const [outcomeA, outcomeB] = await Promise.all([
        runtime.renderPendingDigestForSession('session-coalesce', task.id),
        runtime.renderPendingDigestForSession('session-coalesce', secondTask.id),
      ]);

      expect(outcomeA?.action).toBe('delivered');
      expect(outcomeB?.action).toBe('delivered');
      if (outcomeA?.action !== 'delivered' || outcomeB?.action !== 'delivered') return;
      expect(outcomeA.eventIds).toEqual(['evt-coalesce-a']);
      expect(outcomeB.eventIds).toEqual(['evt-coalesce-b']);

      const allDigestRows = db
        .prepare(
          `SELECT sdk_uuid FROM sdk_messages
           WHERE session_id = 'session-coalesce' AND sdk_uuid LIKE 'digest-%'
           AND send_status IN ('deferred', 'enqueued')`
        )
        .all() as Array<{ sdk_uuid: string }>;
      expect(allDigestRows).toHaveLength(2);
      expect(
        allDigestRows.some((row) => row.sdk_uuid === outcomeA.uuid) &&
          allDigestRows.some((row) => row.sdk_uuid === outcomeB.uuid)
      ).toBe(true);
      expect(eventStore.listDeliveries('evt-coalesce-a')[0]?.state).toBe('delivered');
      expect(eventStore.listDeliveries('evt-coalesce-b')[0]?.state).toBe('delivered');
    });

    function saveDeferredDigestWithTask(
      sessionId: string,
      uuid: string,
      eventIds: string[],
      taskId: string
    ): void {
      const messages = new SDKMessageRepository(db);
      const row = {
        type: 'user',
        uuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        isSynthetic: true,
        inputKind: 'system',
        message: { role: 'user', content: [{ type: 'text', text: 'owed digest text' }] },
        externalEventIds: eventIds,
        externalEventTaskId: taskId,
      } as unknown as SDKUserMessage;
      messages.saveUserMessage(sessionId, row, 'deferred', 'system');
    }

    function deferredDigestUuids(sessionId: string): string[] {
      return (
        db
          .prepare(
            `SELECT sdk_uuid FROM sdk_messages WHERE session_id = ?
             AND sdk_uuid LIKE 'digest-%' AND send_status = 'deferred'`
          )
          .all(sessionId) as Array<{ sdk_uuid: string }>
      ).map((row) => row.sdk_uuid);
    }

    test('flag on: a render during cold-start rehydration waits for handoff-debt restoration', async () => {
      const sessionId = 'session-cold-gate';
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const { task } = await startLiveSession(sessionId, topic);

      await eventService.publish(makeEvent({ id: 'evt-cold-owed', topic }));
      const owedDelivery = eventStore.listDeliveries('evt-cold-owed')[0]!;
      eventStore.markDeliveriesDeliveredAtomic([
        { eventId: 'evt-cold-owed', deliveryKey: owedDelivery.deliveryKey },
      ]);
      saveDeferredDigestWithTask(sessionId, 'digest-cold-owed', ['evt-cold-owed'], task.id);
      await eventService.publish(makeEvent({ id: 'evt-cold-new', topic }));

      await runtime.stop();
      const runtimeInternals = runtime as unknown as {
        digestHandoffDebt: Map<string, Set<string>>;
      };
      runtimeInternals.digestHandoffDebt.clear();

      const originalListSpaces = spaceManager.listSpaces.bind(spaceManager);
      let releaseListSpaces: (() => void) | null = null;
      const listSpacesBlocked = new Promise<void>((resolve) => {
        releaseListSpaces = resolve;
      });
      spaceManager.listSpaces = async (
        ...args: Parameters<typeof originalListSpaces>
      ): ReturnType<typeof originalListSpaces> => {
        await listSpacesBlocked;
        return originalListSpaces(...args);
      };

      runtime.start();
      const renderPromise = runtime.renderPendingDigestForSession(sessionId, task.id);
      await wait(50);

      expect(deferredDigestUuids(sessionId)).toContain('digest-cold-owed');
      expect(eventStore.listDeliveries('evt-cold-new')[0]?.state).toBe('pending');

      releaseListSpaces!();
      const outcome = await renderPromise;
      spaceManager.listSpaces = originalListSpaces;

      expect(outcome?.action).toBe('delivered');
      expect(deferredDigestUuids(sessionId)).toContain('digest-cold-owed');
      expect(eventStore.listDeliveries('evt-cold-new')[0]?.state).toBe('delivered');
      await runtime.stop();
    });

    test('flag on: a failed rehydration settles waiting renders instead of hanging them', async () => {
      const originalRehydrate = tam.rehydrate.bind(tam);
      tam.rehydrate = async () => {
        throw new Error('rehydrate exploded');
      };
      runtime.start();

      const gate = (runtime as unknown as { currentReconciliation: { failed: boolean } | null })
        .currentReconciliation;
      const deadline = Date.now() + 2000;
      while (!gate?.failed && Date.now() < deadline) {
        await wait(5);
      }
      expect(gate?.failed).toBe(true);

      expect(await runtime.renderPendingDigestForSession('session-rehydrate-failed')).toBeNull();

      tam.rehydrate = originalRehydrate;
      await runtime.executeTick();
      expect(await runtime.renderPendingDigestForSession('session-rehydrate-recovered')).toEqual({
        action: 'skip',
        reason: 'no_execution',
      });
      await runtime.stop();
    });

    test('flag on: handoff debt for colon-delimited session ids survives pruning', async () => {
      const sessionId = `space:${SPACE_ID}:task:task-colon:exec:exec-colon`;
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(sessionId, sessionId, Date.now(), Date.now());
      const { run, task } = await startRunWithSubscription(topic);
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: sessionId,
        completedAt: null,
        startedAt: Date.now(),
      });
      await eventService.publish(makeEvent({ id: 'evt-colon-owed', topic }));
      const delivery = eventStore.listDeliveries('evt-colon-owed')[0]!;
      eventStore.markDeliveriesDeliveredAtomic([
        { eventId: 'evt-colon-owed', deliveryKey: delivery.deliveryKey },
      ]);
      saveDeferredDigestWithTask(sessionId, 'digest-colon-owed', ['evt-colon-owed'], task.id);

      const runtimeInternals = runtime as unknown as {
        rehydrateDigestHandoffDebt: () => void;
        pruneDigestHandoffDebt: () => void;
        digestHandoffDebt: Map<string, Set<string>>;
      };
      runtimeInternals.rehydrateDigestHandoffDebt();
      expect(runtimeInternals.digestHandoffDebt.get(sessionId)?.has('digest-colon-owed')).toBe(
        true
      );

      runtimeInternals.pruneDigestHandoffDebt();
      expect(runtimeInternals.digestHandoffDebt.get(sessionId)?.has('digest-colon-owed')).toBe(
        true
      );
      expect(deferredDigestUuids(sessionId)).toContain('digest-colon-owed');
    });

    test('flag on: a waiting render cannot cross a restart into an unreconciled gate', async () => {
      const sessionId = 'session-restart-cross';
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const { task } = await startLiveSession(sessionId, topic);

      await eventService.publish(makeEvent({ id: 'evt-restart-owed', topic }));
      const owedDelivery = eventStore.listDeliveries('evt-restart-owed')[0]!;
      eventStore.markDeliveriesDeliveredAtomic([
        { eventId: 'evt-restart-owed', deliveryKey: owedDelivery.deliveryKey },
      ]);
      saveDeferredDigestWithTask(sessionId, 'digest-restart-owed', ['evt-restart-owed'], task.id);
      await eventService.publish(makeEvent({ id: 'evt-restart-new', topic }));

      await runtime.stop();
      (
        runtime as unknown as { digestHandoffDebt: Map<string, Set<string>> }
      ).digestHandoffDebt.clear();

      const originalListSpaces = spaceManager.listSpaces.bind(spaceManager);
      let releaseListSpaces: (() => void) | null = null;
      const listSpacesBlocked = new Promise<void>((resolve) => {
        releaseListSpaces = resolve;
      });
      spaceManager.listSpaces = async (
        ...args: Parameters<typeof originalListSpaces>
      ): ReturnType<typeof originalListSpaces> => {
        await listSpacesBlocked;
        return originalListSpaces(...args);
      };

      runtime.start();
      const renderPromise = runtime.renderPendingDigestForSession(sessionId, task.id);
      await wait(30);

      const stopPromise = runtime.stop();
      runtime.start();
      await wait(30);

      expect(deferredDigestUuids(sessionId)).toContain('digest-restart-owed');
      expect(eventStore.listDeliveries('evt-restart-new')[0]?.state).toBe('pending');

      releaseListSpaces!();
      const outcome = await renderPromise;
      await stopPromise;
      spaceManager.listSpaces = originalListSpaces;

      expect(outcome?.action).toBe('delivered');
      expect(deferredDigestUuids(sessionId)).toContain('digest-restart-owed');
      expect(eventStore.listDeliveries('evt-restart-new')[0]?.state).toBe('delivered');
      await runtime.stop();
    });

    test('flag on: a failed warm reconciliation is retried by a later tick', async () => {
      await runtime.executeTick();
      await runtime.stop();

      const originalListPendingDeliveries = eventStore.listPendingDeliveries.bind(eventStore);
      let failRequeue = true;
      eventStore.listPendingDeliveries = (
        ...args: Parameters<typeof originalListPendingDeliveries>
      ): ReturnType<typeof originalListPendingDeliveries> => {
        if (failRequeue) throw new Error('requeue exploded');
        return originalListPendingDeliveries(...args);
      };

      runtime.start();
      const gate = (runtime as unknown as { currentReconciliation: { failed: boolean } | null })
        .currentReconciliation;
      const deadline = Date.now() + 2000;
      while (!gate?.failed && Date.now() < deadline) {
        await wait(5);
      }
      expect(gate?.failed).toBe(true);
      expect(await runtime.renderPendingDigestForSession('session-warm-failed')).toBeNull();

      failRequeue = false;
      await runtime.executeTick();
      expect(await runtime.renderPendingDigestForSession('session-warm-recovered')).toEqual({
        action: 'skip',
        reason: 'no_execution',
      });
      eventStore.listPendingDeliveries = originalListPendingDeliveries;
      await runtime.stop();
    });

    test('flag on: abandoning a handoff retry for a dead session records handoff debt', async () => {
      const sessionId = 'session-abandon-debt';
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(sessionId, sessionId, Date.now(), Date.now());
      const { task } = await startRunWithSubscription(topic);
      await eventService.publish(makeEvent({ id: 'evt-abandon-owed', topic }));
      const delivery = eventStore.listDeliveries('evt-abandon-owed')[0]!;
      eventStore.markDeliveriesDeliveredAtomic([
        { eventId: 'evt-abandon-owed', deliveryKey: delivery.deliveryKey },
      ]);
      saveDeferredDigestWithTask(sessionId, 'digest-abandon-owed', ['evt-abandon-owed'], task.id);
      const row = db
        .prepare(
          `SELECT id FROM sdk_messages WHERE session_id = ? AND sdk_uuid = 'digest-abandon-owed'`
        )
        .get(sessionId) as { id: string };
      tam.alive.delete(sessionId);

      (
        runtime as unknown as {
          scheduleDigestHandoffRetry: (sessionId: string, uuid: string, dbId: string) => void;
        }
      ).scheduleDigestHandoffRetry(sessionId, 'digest-abandon-owed', String(row.id));
      await wait(1200);

      const runtimeInternals = runtime as unknown as {
        digestHandoffDebt: Map<string, Set<string>>;
      };
      expect(runtimeInternals.digestHandoffDebt.get(sessionId)?.has('digest-abandon-owed')).toBe(
        true
      );
      expect(deferredDigestUuids(sessionId)).toContain('digest-abandon-owed');
    });

    test('flag on: a tick failure after rehydration does not poison the reconciliation gate', async () => {
      const sessionId = 'session-tickfail-gate';
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const { task } = await startLiveSession(sessionId, topic);

      await eventService.publish(makeEvent({ id: 'evt-tickfail-owed', topic }));
      const owedDelivery = eventStore.listDeliveries('evt-tickfail-owed')[0]!;
      eventStore.markDeliveriesDeliveredAtomic([
        { eventId: 'evt-tickfail-owed', deliveryKey: owedDelivery.deliveryKey },
      ]);
      saveDeferredDigestWithTask(sessionId, 'digest-tickfail-owed', ['evt-tickfail-owed'], task.id);
      await eventService.publish(makeEvent({ id: 'evt-tickfail-new', topic }));

      const runtimeInternals = runtime as unknown as {
        attachStandaloneTasksToWorkflows: () => Promise<void>;
      };
      const originalAttach = runtimeInternals.attachStandaloneTasksToWorkflows.bind(runtime);
      runtimeInternals.attachStandaloneTasksToWorkflows = async () => {
        throw new Error('attach exploded');
      };

      runtime.start();
      const outcome = await runtime.renderPendingDigestForSession(sessionId, task.id);
      runtimeInternals.attachStandaloneTasksToWorkflows = originalAttach;

      expect(outcome?.action).toBe('delivered');
      expect(deferredDigestUuids(sessionId)).toContain('digest-tickfail-owed');
      expect(eventStore.listDeliveries('evt-tickfail-new')[0]?.state).toBe('delivered');
      await runtime.stop();
    });

    test('flag on: a start racing an unfinished stop keeps the restarted runtime active', async () => {
      const sessionId = 'session-race-restart';
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const { task } = await startLiveSession(sessionId, topic);
      await eventService.publish(makeEvent({ id: 'evt-race-1', topic }));

      const repo = (
        runtime as unknown as { getSdkMessageRepo(): SDKMessageRepository }
      ).getSdkMessageRepo();
      const originalSave = (repo as unknown as { saveUserMessage: (...args: unknown[]) => unknown })
        .saveUserMessage as (...args: unknown[]) => string;
      let saveStarted = false;
      let unblockSave: ((value: string) => void) | null = null;
      const saveBlocker = new Promise<string>((resolve) => {
        unblockSave = resolve;
      });
      (repo as unknown as { saveUserMessage: (...args: unknown[]) => unknown }).saveUserMessage = (
        ...args: unknown[]
      ) => {
        saveStarted = true;
        return saveBlocker.then(() => originalSave.apply(repo, args)) as unknown as string;
      };

      runtime.start();
      const blockedRender = runtime.renderPendingDigestForSession(sessionId, task.id);
      const deadline = Date.now() + 2000;
      while (!saveStarted && Date.now() < deadline) {
        await wait(5);
      }
      expect(saveStarted).toBe(true);

      (
        runtime as unknown as { scheduleDigestProbeForSession: (sessionId: string) => void }
      ).scheduleDigestProbeForSession(sessionId);
      const staleProbe = (
        runtime as unknown as { digestPullTriggers: Map<string, unknown> }
      ).digestPullTriggers.get(sessionId);
      expect(staleProbe).toBeDefined();

      const stopPromise = runtime.stop();
      runtime.start();
      unblockSave!('db-race');
      const outcome = await blockedRender;
      await stopPromise;
      (repo as unknown as { saveUserMessage: (...args: unknown[]) => unknown }).saveUserMessage =
        originalSave;

      expect(outcome?.action).toBe('delivered');
      const internals = runtime as unknown as {
        acceptingExternalEvents: boolean;
        tickTimer: unknown;
        digestPullTriggers: Map<string, unknown>;
      };
      expect(internals.acceptingExternalEvents).toBe(true);
      expect(internals.tickTimer).not.toBeNull();
      expect(internals.digestPullTriggers.get(sessionId)).not.toBe(staleProbe);

      await eventService.publish(makeEvent({ id: 'evt-race-2', topic }));
      const postRace = await runtime.renderPendingDigestForSession(sessionId, task.id);
      expect(postRace?.action).toBe('delivered');
      expect(eventStore.listDeliveries('evt-race-1')[0]?.state).toBe('delivered');
      expect(eventStore.listDeliveries('evt-race-2')[0]?.state).toBe('delivered');
      await runtime.stop();
    });

    test('flag on: sibling agent deliveries under one task do not create false handoff debt', async () => {
      const sessionId = 'session-sibling-debt';
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(sessionId, sessionId, Date.now(), Date.now());
      const { run, task } = await startRunWithSubscription(topic);
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: sessionId,
        completedAt: null,
        startedAt: Date.now(),
      });
      await eventService.publish(makeEvent({ id: 'evt-sibling-owed', topic }));
      eventStore.registerExpectedDelivery('evt-sibling-owed', 'delivery-sibling', {
        workflowRunId: run.id,
        taskId: task.id,
        nodeId: 'review',
        agentName: 'reviewer',
      });
      const sibling = eventStore
        .listDeliveries('evt-sibling-owed')
        .find((delivery) => delivery.deliveryKey === 'delivery-sibling')!;
      eventStore.markDeliveryDelivered('evt-sibling-owed', sibling.deliveryKey);
      saveDeferredDigestWithTask(sessionId, 'digest-sibling-owed', ['evt-sibling-owed'], task.id);

      const runtimeInternals = runtime as unknown as {
        rehydrateDigestHandoffDebt: () => void;
        digestHandoffDebt: Map<string, Set<string>>;
      };
      runtimeInternals.rehydrateDigestHandoffDebt();
      expect(runtimeInternals.digestHandoffDebt.get(sessionId)?.has('digest-sibling-owed')).toBe(
        undefined
      );
      expect(deferredDigestUuids(sessionId)).toContain('digest-sibling-owed');
    });

    test('flag on: a digest pull stranded by failed reconciliation re-arms after recovery', async () => {
      const sessionId = 'session-stranded-pull';
      const topic = 'github/lsm/neokai/pull_request/42.comment_polled';
      const { task } = await startLiveSession(sessionId, topic);
      const originalRehydrate = tam.rehydrate.bind(tam);
      tam.rehydrate = async () => {
        throw new Error('rehydrate exploded');
      };
      runtime.start();
      const gate = (runtime as unknown as { currentReconciliation: { failed: boolean } | null })
        .currentReconciliation;
      const failedDeadline = Date.now() + 2000;
      while (!gate?.failed && Date.now() < failedDeadline) {
        await wait(5);
      }
      expect(gate?.failed).toBe(true);

      await eventService.publish(makeEvent({ id: 'evt-stranded-1', topic }));
      await wait(150);
      expect(eventStore.listDeliveries('evt-stranded-1')[0]?.state).toBe('pending');
      expect(
        (runtime as unknown as { digestPullTriggers: Map<string, unknown> }).digestPullTriggers.has(
          sessionId
        )
      ).toBe(true);

      tam.rehydrate = originalRehydrate;
      const rt = runtime as unknown as { rehydrated: boolean };
      const recoverDeadline = Date.now() + 5000;
      while (!rt.rehydrated && Date.now() < recoverDeadline) {
        await runtime.executeTick().catch(() => {});
        await wait(20);
      }
      expect(rt.rehydrated).toBe(true);

      await wait(200);
      expect(digestRows(sessionId)).toHaveLength(1);
      expect(eventStore.listDeliveries('evt-stranded-1')[0]?.state).toBe('delivered');
      await runtime.stop();
    });
  });

  describe('surviving delivery invariants after the V1 deletion', () => {
    function resumeHookCount(): number {
      return (spaceManager as unknown as { onSpaceResumedCallbacks: unknown[] })
        .onSpaceResumedCallbacks.length;
    }

    function makeSecondRuntime(): SpaceRuntime {
      return new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        artifactRepo,
        artifactProfile,
        internalEventBus: bus,
        commandBus: (runtime as unknown as { config: { commandBus: unknown } }).config
          .commandBus as never,
        externalEventStore: eventStore,
        taskAgentManager: tam as never,
      });
    }

    test('rejects invalid static event interest topics at workflow creation', async () => {
      expect(() =>
        createWorkflow('code', {
          eventInterests: [{ topic: 'github/**/pull_request/*.opened' }],
        })
      ).toThrow('Multi-segment "**" wildcard is not supported');
    });

    test('allows the first 10 event interests for an agent slot', async () => {
      const workflow = createWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const task = tasks[0]!;

      for (let index = 0; index < 10; index += 1) {
        expect(() =>
          runtime.registerSubscription(
            run.id,
            task.id,
            'code',
            'coder',
            `github/owner/repo/pull_request_${index}.opened`
          )
        ).not.toThrow();
      }
    });

    test('rejects the 11th event interest for an agent slot', async () => {
      const workflow = createWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const task = tasks[0]!;

      for (let index = 0; index < 10; index += 1) {
        runtime.registerSubscription(
          run.id,
          task.id,
          'code',
          'coder',
          `github/owner/repo/pull_request_${index}.opened`
        );
      }

      expect(() =>
        runtime.registerSubscription(
          run.id,
          task.id,
          'code',
          'coder',
          'github/owner/repo/pull_request_10.opened'
        )
      ).toThrow('cannot register more than 10 event interests');
    });

    test('allows new event interests after an agent slot unsubscribes', async () => {
      const workflow = createWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const task = tasks[0]!;

      for (let index = 0; index < 10; index += 1) {
        runtime.registerSubscription(
          run.id,
          task.id,
          'code',
          'coder',
          `github/owner/repo/pull_request_${index}.opened`
        );
      }

      runtime.unregisterExecution(run.id, task.id, 'code', 'coder');

      expect(() =>
        runtime.registerSubscription(
          run.id,
          task.id,
          'code',
          'coder',
          'github/owner/repo/pull_request_10.opened'
        )
      ).not.toThrow();
    });

    test('retains unmatched events until the TTL', async () => {
      const event = makeEvent({ topic: 'github/lsm/neokai/issues/7.comment_created' });
      await eventService.publish(event);
      await runtime.executeTick();

      expect(injected).toHaveLength(0);
      expect(eventStore.getById(event.id)?.state).toBe('published');
    });

    test('fails unmatched events that stay unclaimed past the TTL', async () => {
      const event = makeEvent({
        id: 'evt-unmatched-expired',
        topic: 'github/lsm/neokai/issues/7.comment_created',
      });
      await eventService.publish(event);

      const originalNow = Date.now;
      Date.now = () => originalNow() + 300_001;
      try {
        await runtime.executeTick();
      } finally {
        Date.now = originalNow;
      }

      expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
      expect(eventStore.getById(event.id)?.state).toBe('failed');
    });

    test('TTL sweep fails only stale published events without deliveries, idempotently', async () => {
      await runtime.executeTick();

      const stale = makeEvent({
        id: 'evt-ttl-sweep-stale',
        topic: 'github/lsm/neokai/issues/99.comment_created',
      });
      const fresh = makeEvent({
        id: 'evt-ttl-sweep-fresh',
        topic: 'github/lsm/neokai/issues/100.comment_created',
      });
      const withDelivery = makeEvent({
        id: 'evt-ttl-sweep-delivery',
        topic: 'github/lsm/neokai/issues/101.comment_created',
      });

      eventStore.store(stale);
      eventStore.store(fresh);
      eventStore.store(withDelivery);
      eventStore.registerExpectedDelivery(withDelivery.id, 'dk-ttl-sweep-1', {
        workflowRunId: 'run-ttl-sweep',
        taskId: 'task-ttl-sweep',
        nodeId: 'code',
        agentName: 'coder',
      });

      const now = Date.now();
      db.prepare('UPDATE space_external_events SET created_at = ? WHERE id = ?').run(
        now - 400_000,
        stale.id
      );
      db.prepare('UPDATE space_external_events SET created_at = ? WHERE id = ?').run(
        now - 400_000,
        withDelivery.id
      );

      const originalNow = Date.now;
      Date.now = () => now + 1000;
      try {
        await runtime.executeTick();
      } finally {
        Date.now = originalNow;
      }

      expect(eventStore.getById(stale.id)?.state).toBe('failed');
      expect(eventStore.listDeliveries(stale.id)).toHaveLength(0);
      expect(eventStore.getById(fresh.id)?.state).toBe('published');
      expect(eventStore.getById(withDelivery.id)?.state).toBe('failed');
      expect(eventStore.getDelivery(withDelivery.id, 'dk-ttl-sweep-1')).toMatchObject({
        state: 'failed',
        failureReason: 'ttl_expired',
      });

      Date.now = () => now + 2000;
      try {
        await runtime.executeTick();
      } finally {
        Date.now = originalNow;
      }

      expect(eventStore.getById(stale.id)?.state).toBe('failed');
      expect(eventStore.getById(fresh.id)?.state).toBe('published');
      expect(eventStore.getById(withDelivery.id)?.state).toBe('failed');
    });

    test('TTL sweep skips deliveries whose key is in flight', async () => {
      await runtime.executeTick();

      const stale = makeEvent({
        id: 'evt-ttl-sweep-in-flight',
        topic: 'github/lsm/neokai/issues/102.comment_created',
      });
      eventStore.store(stale);
      eventStore.registerExpectedDelivery(stale.id, 'dk-ttl-in-flight', {
        workflowRunId: 'run-ttl-sweep',
        taskId: 'task-ttl-sweep',
        nodeId: 'code',
        agentName: 'coder',
      });
      eventStore.registerExpectedDelivery(stale.id, 'dk-ttl-orphan', {
        workflowRunId: 'run-ttl-sweep',
        taskId: 'task-ttl-sweep',
        nodeId: 'review',
        agentName: 'reviewer',
      });

      const now = Date.now();
      db.prepare('UPDATE space_external_events SET created_at = ? WHERE id = ?').run(
        now - 400_000,
        stale.id
      );

      const inFlight = (runtime as unknown as { externalEventDeliveriesInFlight: Set<string> })
        .externalEventDeliveriesInFlight;
      inFlight.add('dk-ttl-in-flight');
      try {
        await runtime.executeTick();
      } finally {
        inFlight.delete('dk-ttl-in-flight');
      }

      expect(eventStore.getDelivery(stale.id, 'dk-ttl-in-flight')?.state).toBe('pending');
      expect(eventStore.getDelivery(stale.id, 'dk-ttl-orphan')).toMatchObject({
        state: 'failed',
        failureReason: 'ttl_expired',
      });
      expect(eventStore.getById(stale.id)?.state).toBe('published');

      await runtime.executeTick();

      expect(eventStore.getDelivery(stale.id, 'dk-ttl-in-flight')).toMatchObject({
        state: 'failed',
        failureReason: 'ttl_expired',
      });
      expect(eventStore.getById(stale.id)?.state).toBe('failed');
    });

    test('digest admission terminalizes pending deliveries for a done task without reactivating it', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      const event = makeEvent({
        topic: 'github/lsm/neokai/pull_request/42.comment_polled',
      });
      await eventService.publish(event);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-done-task-digest',
        completedAt: null,
        startedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(
        'session-done-task-digest',
        'session-done-task-digest',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
      tam.alive.add('session-done-task-digest');
      tam.processingStates.set('session-done-task-digest', 'processing');

      taskRepo.updateTask(task.id, { status: 'done', completedAt: Date.now() });

      const outcome = await runtime.renderPendingDigestForSession(
        'session-done-task-digest',
        task.id
      );
      expect(outcome).toEqual({ action: 'skip', reason: 'task_not_admissible' });

      expect(taskRepo.getTask(task.id)?.status).toBe('done');
      const delivery = eventStore.listDeliveries(event.id)[0]!;
      expect(delivery.state).toBe('failed');
      expect(delivery.failureReason).toBe('task_terminal');
      expect(eventStore.getById(event.id)?.state).toBe('failed');

      const rows = db
        .prepare(
          `SELECT sdk_message FROM sdk_messages WHERE session_id = 'session-done-task-digest'
           AND send_status = 'deferred'`
        )
        .all() as Array<{ sdk_message: string }>;
      expect(rows).toHaveLength(0);
    });

    test('unregisters the space-resume hook on stop', async () => {
      const before = resumeHookCount();
      const runtime2 = makeSecondRuntime();
      runtime2.start();
      expect(resumeHookCount()).toBe(before + 1);

      await runtime2.stop();
      expect(resumeHookCount()).toBe(before);
    });

    test('re-registers the space-resume hook on start after stop', async () => {
      const before = resumeHookCount();
      const runtime2 = makeSecondRuntime();
      runtime2.start();
      expect(resumeHookCount()).toBe(before + 1);

      await runtime2.stop();
      expect(resumeHookCount()).toBe(before);

      runtime2.start();
      expect(resumeHookCount()).toBe(before + 1);

      await runtime2.stop();
      expect(resumeHookCount()).toBe(before);
    });
  });

  describe('recovery-point digest requeue', () => {
    const previousEnv: Record<string, string | undefined> = {};

    function setEnv(name: string, value: string): void {
      previousEnv[name] = process.env[name];
      process.env[name] = value;
    }

    function restoreEnv(): void {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }

    function wait(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function digestRowCount(sessionId: string): number {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = ? AND sdk_uuid LIKE 'digest-%'`
          )
          .get(sessionId) as { n: number }
      ).n;
    }

    function seedSessionRow(sessionId: string): void {
      db.prepare(
        `INSERT INTO sessions
           (id, title, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
      ).run(sessionId, sessionId, Date.now(), Date.now());
    }

    function bindLiveSession(
      executionId: string,
      sessionId: string,
      options: { status?: NodeExecutionStatus } = {}
    ): void {
      nodeExecutionRepo.update(executionId, {
        status: options.status ?? 'in_progress',
        agentSessionId: sessionId,
        completedAt: null,
        startedAt: Date.now(),
      });
      seedSessionRow(sessionId);
      tam.alive.add(sessionId);
      tam.processingStates.set(sessionId, 'idle');
    }

    async function runWithPendingDelivery(options: { taskStatus?: SpaceTaskStatus } = {}): Promise<{
      run: Awaited<ReturnType<typeof runtime.startWorkflowRun>>['run'];
      task: SpaceTask;
      executionId: string;
      event: ExternalEvent;
    }> {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });
      if (options.taskStatus) {
        taskRepo.updateTask(task.id, { status: options.taskStatus });
      }
      const event = makeEvent({
        topic: 'github/lsm/neokai/pull_request/42.comment_polled',
      });
      await eventService.publish(event);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
      return { run, task, executionId: execution.id, event };
    }

    beforeEach(() => {
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_IDLE_DEBOUNCE_MS', '50');
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_COUNT_CAP', '100');
      setEnv('HYPERNEO_EXTERNAL_EVENT_DIGEST_SAFETY_MS', '10000');
      db.exec(`CREATE TABLE IF NOT EXISTS job_queue (
				id TEXT PRIMARY KEY,
				queue TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
				payload TEXT NOT NULL DEFAULT '{}',
				result TEXT,
				error TEXT,
				priority INTEGER NOT NULL DEFAULT 0,
				max_retries INTEGER NOT NULL DEFAULT 3,
				retry_count INTEGER NOT NULL DEFAULT 0,
				run_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				heartbeat_at INTEGER,
				completed_at INTEGER
			)`);
    });

    afterEach(() => {
      restoreEnv();
    });

    test('startup rehydrate re-arms a persisted pending delivery as a digest pull', async () => {
      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-rehydrate-recovery');
      tam.alive.delete('session-rehydrate-recovery');
      tam.rehydrate = async () => {
        tam.alive.add('session-rehydrate-recovery');
      };

      const runtime2 = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        internalEventBus: bus,
        commandBus: (runtime as unknown as { config: { commandBus: unknown } }).config
          .commandBus as never,
        externalEventStore: eventStore,
        taskAgentManager: tam as never,
      });
      await runtime2.rehydrateExecutors();
      await wait(300);

      expect(digestRowCount('session-rehydrate-recovery')).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
      expect(eventStore.getById(event.id)?.state).toBe('delivered');
    });

    test('onSpaceResumed re-arms a persisted pending delivery as a digest pull', async () => {
      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-resume-recovery');

      runtime.onSpaceResumed(SPACE_ID);
      await wait(300);

      expect(digestRowCount('session-resume-recovery')).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    });

    test('recoverWorkflowBackedTask re-arms persisted pending deliveries on resume', async () => {
      const { task, event, executionId } = await runWithPendingDelivery({
        taskStatus: 'stopped',
      });
      bindLiveSession(executionId, 'session-recover-recovery');

      const recovered = await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');
      expect(recovered.task.status).toBe('in_progress');
      await wait(300);

      expect(digestRowCount('session-recover-recovery')).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    });

    test('reopening a stopped task re-arms its persisted pending deliveries', async () => {
      const { task, event, executionId } = await runWithPendingDelivery({
        taskStatus: 'stopped',
      });
      bindLiveSession(executionId, 'session-reopen-recovery', { status: 'idle' });

      const reopened = await runtime.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'open',
      });
      expect(reopened?.status).toBe('open');
      await wait(300);

      expect(digestRowCount('session-reopen-recovery')).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    });

    test('a reopen restores parked idle sessions before re-arming their deliveries', async () => {
      const { task, event, executionId } = await runWithPendingDelivery({
        taskStatus: 'stopped',
      });
      bindLiveSession(executionId, 'session-reopen-parked', { status: 'idle' });
      tam.alive.delete('session-reopen-parked');
      tam.tryResumeNodeAgentSession = async () => {
        tam.alive.add('session-reopen-parked');
      };

      const reopened = await runtime.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'open',
      });
      expect(reopened?.status).toBe('open');
      await wait(300);

      expect(digestRowCount('session-reopen-parked')).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    });

    test('a space resume restores parked idle sessions before re-arming their deliveries', async () => {
      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-resume-parked', { status: 'idle' });
      tam.alive.delete('session-resume-parked');
      tam.tryResumeNodeAgentSession = async () => {
        tam.alive.add('session-resume-parked');
      };

      await runtime.onSpaceResumed(SPACE_ID);
      await wait(300);

      expect(digestRowCount('session-resume-parked')).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    });

    test('startup rehydrate restores idle sessions owning pending deliveries', async () => {
      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-startup-parked', { status: 'idle' });
      tam.alive.delete('session-startup-parked');
      tam.rehydrate = async () => {};
      tam.tryResumeNodeAgentSession = async () => {
        tam.alive.add('session-startup-parked');
      };

      const runtime2 = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        internalEventBus: bus,
        commandBus: (runtime as unknown as { config: { commandBus: unknown } }).config
          .commandBus as never,
        externalEventStore: eventStore,
        taskAgentManager: tam as never,
      });
      await runtime2.rehydrateExecutors();
      await wait(300);

      expect(digestRowCount('session-startup-parked')).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    });

    test('a reopen does not resurrect a cancelled execution that kept its session id', async () => {
      const { task, event, executionId } = await runWithPendingDelivery({
        taskStatus: 'stopped',
      });
      bindLiveSession(executionId, 'session-reopen-live', { status: 'cancelled' });
      tam.alive.delete('session-reopen-live');
      let resumeCalls = 0;
      tam.tryResumeNodeAgentSession = async () => {
        resumeCalls += 1;
        tam.alive.add('session-reopen-live');
      };

      const reopened = await runtime.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'open',
      });
      expect(reopened?.status).toBe('open');
      await wait(200);

      expect(resumeCalls).toBe(0);
      expect(digestRowCount('session-reopen-live')).toBe(0);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
    });

    test('an expired long-horizon delivery is failed on resume instead of re-dispatched', async () => {
      const repo = new SpaceLongHorizonAgentRepository(db);
      const agent = repo.create({
        id: 'lh-agent-resume-ttl',
        spaceId: SPACE_ID,
        handle: 'resume-ttl',
        displayName: 'Resume TTL',
      });
      const subscription = repo.createSubscription({
        spaceId: SPACE_ID,
        agentId: agent.id,
        source: 'github',
        topic: DEFAULT_TOPIC,
      });
      const event = makeEvent({ id: 'evt-lh-resume-ttl' });
      eventStore.store(event);
      const deliveryKey = `lh:${subscription.id}:${event.id}`;
      eventStore.registerExpectedDelivery(event.id, deliveryKey, {
        workflowRunId: `long_horizon:${SPACE_ID}`,
        taskId: subscription.id,
        nodeId: agent.id,
        agentName: agent.id,
      });
      eventStore.markDeliveryFailed(event.id, deliveryKey, {
        terminal: false,
        reason: 'long-horizon agent unavailable',
      });

      const originalNow = Date.now;
      Date.now = () => originalNow() + 300_001;
      try {
        await runtime.onSpaceResumed(SPACE_ID);
      } finally {
        Date.now = originalNow;
      }
      await wait(100);

      expect(longHorizonMessages).toHaveLength(0);
      const delivery = eventStore.listDeliveries(event.id)[0]!;
      expect(delivery.state).toBe('failed');
      expect(delivery.failureReason).toBe('ttl_expired');
      expect(eventStore.getById(event.id)?.state).toBe('failed');
    });

    test('a paused space does not restore its parked idle sessions at a recovery point', async () => {
      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-paused-restore', { status: 'idle' });
      tam.alive.delete('session-paused-restore');
      let resumeCalls = 0;
      tam.tryResumeNodeAgentSession = async () => {
        resumeCalls += 1;
        tam.alive.add('session-paused-restore');
      };

      await (
        runtime as unknown as {
          recoverPendingDeliveries: (paused: Set<string>, workflowRunId?: string) => Promise<void>;
        }
      ).recoverPendingDeliveries(new Set([SPACE_ID]));
      await wait(200);

      expect(resumeCalls).toBe(0);
      expect(digestRowCount('session-paused-restore')).toBe(0);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
    });

    test('an in-flight long-horizon delivery crossing the TTL is not terminally failed by recovery', async () => {
      const repo = new SpaceLongHorizonAgentRepository(db);
      const agent = repo.create({
        id: 'lh-agent-inflight-ttl',
        spaceId: SPACE_ID,
        handle: 'inflight-ttl',
        displayName: 'Inflight TTL',
      });
      const subscription = repo.createSubscription({
        spaceId: SPACE_ID,
        agentId: agent.id,
        source: 'github',
        topic: DEFAULT_TOPIC,
      });
      const event = makeEvent({ id: 'evt-lh-inflight-ttl' });
      eventStore.store(event);
      const deliveryKey = `lh:${subscription.id}:${event.id}`;
      eventStore.registerExpectedDelivery(event.id, deliveryKey, {
        workflowRunId: `long_horizon:${SPACE_ID}`,
        taskId: subscription.id,
        nodeId: agent.id,
        agentName: agent.id,
      });
      eventStore.markDeliveryFailed(event.id, deliveryKey, {
        terminal: false,
        reason: 'long-horizon agent unavailable',
      });
      (
        runtime as unknown as { externalEventDeliveriesInFlight: Set<string> }
      ).externalEventDeliveriesInFlight.add(deliveryKey);

      const originalNow = Date.now;
      Date.now = () => originalNow() + 300_001;
      try {
        await runtime.onSpaceResumed(SPACE_ID);
      } finally {
        Date.now = originalNow;
      }
      await wait(100);

      const delivery = eventStore.listDeliveries(event.id)[0]!;
      expect(delivery.state).toBe('pending');
      expect(delivery.failureReason).not.toBe('ttl_expired');
    });

    test('cancelling a stopped task leaves its persisted pending deliveries inert', async () => {
      const { run, task, event } = await runWithPendingDelivery({ taskStatus: 'stopped' });
      bindLiveSession(
        nodeExecutionRepo.listByNode(run.id, 'code')[0]!.id,
        'session-cancel-recovery'
      );

      const cancelled = await runtime.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'cancelled',
      });
      expect(cancelled?.status).toBe('cancelled');
      await wait(200);

      expect(digestRowCount('session-cancel-recovery')).toBe(0);
      expect(eventStore.listPendingDeliveries(run.id)).toHaveLength(1);
      expect(eventStore.listPendingDeliveries(run.id)[0]!.eventId).toBe(event.id);
    });

    test('an expired pending delivery is failed on requeue instead of re-armed', async () => {
      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-ttl-recovery');

      const originalNow = Date.now;
      Date.now = () => originalNow() + 300_001;
      try {
        await runtime.onSpaceResumed(SPACE_ID);
      } finally {
        Date.now = originalNow;
      }
      await wait(200);

      const delivery = eventStore.listDeliveries(event.id)[0]!;
      expect(delivery.state).toBe('failed');
      expect(delivery.failureReason).toBe('ttl_expired');
      expect(eventStore.getById(event.id)?.state).toBe('failed');
      expect(digestRowCount('session-ttl-recovery')).toBe(0);
    });

    test('a delivery already in flight is not re-armed a second time', async () => {
      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-inflight-recovery');
      const deliveryKey = eventStore.listDeliveries(event.id)[0]!.deliveryKey;
      const inFlight = (runtime as unknown as { externalEventDeliveriesInFlight: Set<string> })
        .externalEventDeliveriesInFlight;
      inFlight.add(deliveryKey);

      runtime.onSpaceResumed(SPACE_ID);
      await wait(200);

      expect(digestRowCount('session-inflight-recovery')).toBe(0);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
    });

    test('a delivery under a live immediate-tier dispatch is not expired by a recovery pass', async () => {
      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-immediate-recovery');
      const deliveryKey = eventStore.listDeliveries(event.id)[0]!.deliveryKey;
      const immediateInFlight = (runtime as unknown as { immediateDispatchesInFlight: Set<string> })
        .immediateDispatchesInFlight;
      immediateInFlight.add(deliveryKey);

      const originalNow = Date.now;
      Date.now = () => originalNow() + 300_001;
      try {
        await runtime.onSpaceResumed(SPACE_ID);
      } finally {
        Date.now = originalNow;
      }
      await wait(200);

      expect(digestRowCount('session-immediate-recovery')).toBe(0);
      const delivery = eventStore.listDeliveries(event.id)[0]!;
      expect(delivery.state).toBe('pending');
      expect(delivery.failureReason).toBeNull();
    });

    test('a space resume only re-arms deliveries for runs of the resumed space', async () => {
      const OTHER_SPACE_ID = `${SPACE_ID}-other`;
      const now = Date.now();
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(OTHER_SPACE_ID, OTHER_SPACE_ID, '/tmp/runtime-events-other', 'Other', now, now);
      const otherWorkflow = createWorkflow('code-other', { spaceId: OTHER_SPACE_ID });
      const { run: otherRun, tasks: otherTasks } = await runtime.startWorkflowRun(
        OTHER_SPACE_ID,
        otherWorkflow.id,
        'Other Run'
      );
      const otherTask = otherTasks[0]!;
      runtime.registerSubscription(
        otherRun.id,
        otherTask.id,
        'code-other',
        'coder',
        'github/*/*/pull_request/*.review_*'
      );
      const otherExecution = nodeExecutionRepo.listByNode(otherRun.id, 'code-other')[0]!;
      nodeExecutionRepo.update(otherExecution.id, {
        status: 'idle',
        agentSessionId: null,
        completedAt: Date.now(),
      });
      const otherEvent = makeEvent({ spaceId: OTHER_SPACE_ID });
      await eventService.publish(otherEvent);
      expect(eventStore.listDeliveries(otherEvent.id)[0]!.state).toBe('pending');
      bindLiveSession(otherExecution.id, 'session-other-space', { status: 'idle' });

      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-resumed-space');

      runtime.onSpaceResumed(SPACE_ID);
      await wait(300);

      expect(digestRowCount('session-resumed-space')).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
      expect(digestRowCount('session-other-space')).toBe(0);
      expect(eventStore.listDeliveries(otherEvent.id)[0]!.state).toBe('pending');
    });

    test('an interrupted target session defers to a probe that delivers once the interrupt clears', async () => {
      const { event, executionId } = await runWithPendingDelivery();
      bindLiveSession(executionId, 'session-interrupt-recovery');
      tam.interrupting.add('session-interrupt-recovery');
      tam.processingStates.set('session-interrupt-recovery', 'interrupted');

      runtime.onSpaceResumed(SPACE_ID);
      await wait(200);
      expect(digestRowCount('session-interrupt-recovery')).toBe(0);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

      tam.interrupting.delete('session-interrupt-recovery');
      tam.processingStates.set('session-interrupt-recovery', 'idle');
      await wait(1500);
      expect(digestRowCount('session-interrupt-recovery')).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    });

    test('a throwing event store during a spawn-path requeue does not undo the spawn', async () => {
      const { run } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        agentSessionId: null,
        startedAt: null,
        completedAt: null,
      });
      tam.onSpawn = (executionId, sessionId) => {
        nodeExecutionRepo.update(executionId, {
          status: 'in_progress',
          agentSessionId: sessionId,
          startedAt: Date.now(),
          completedAt: null,
        });
      };
      const store = eventStore as unknown as {
        listPendingDeliveries: (workflowRunId?: string) => ExternalEventDeliveryRecord[];
      };
      const originalList = store.listPendingDeliveries.bind(eventStore);
      store.listPendingDeliveries = () => {
        throw new Error('event store exploded');
      };

      try {
        await expect(runtime.executeTick()).resolves.toBeUndefined();
      } finally {
        store.listPendingDeliveries = originalList;
      }

      const spawnedSessionId = `session-${execution.id}`;
      expect(tam.spawned).toContain(spawnedSessionId);
      const fresh = nodeExecutionRepo.getById(execution.id)!;
      expect(fresh.status).toBe('in_progress');
      expect(fresh.agentSessionId).toBe(spawnedSessionId);
    });

    test('a freshly spawned node agent pulls the deliveries accrued while it was down', async () => {
      const { run, task } = await startRunWithSubscription(
        'github/lsm/neokai/pull_request/42.comment_polled'
      );
      const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        agentSessionId: null,
        startedAt: null,
        completedAt: null,
      });
      const event = makeEvent({
        topic: 'github/lsm/neokai/pull_request/42.comment_polled',
      });
      await eventService.publish(event);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

      const spawnedSessionId = `session-${execution.id}`;
      seedSessionRow(spawnedSessionId);
      tam.alive.add(spawnedSessionId);
      tam.processingStates.set(spawnedSessionId, 'idle');
      tam.onSpawn = (executionId, sessionId) => {
        nodeExecutionRepo.update(executionId, {
          status: 'in_progress',
          agentSessionId: sessionId,
          startedAt: Date.now(),
          completedAt: null,
        });
      };

      await runtime.executeTick();
      expect(tam.spawned).toContain(spawnedSessionId);
      await wait(300);

      expect(digestRowCount(spawnedSessionId)).toBe(1);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
      expect(taskRepo.getTask(task.id)?.status).not.toBe('cancelled');
    });

    test('a space resume retries that space pending long-horizon deliveries and no other space', async () => {
      const OTHER_SPACE_ID = `${SPACE_ID}-lh-other`;
      const seededAt = Date.now();
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        OTHER_SPACE_ID,
        OTHER_SPACE_ID,
        '/tmp/runtime-events-lh-other',
        'Other',
        seededAt,
        seededAt
      );
      const repo = new SpaceLongHorizonAgentRepository(db);
      const agent = repo.create({
        id: 'lh-agent-resume-retry',
        spaceId: SPACE_ID,
        handle: 'resume-retry',
        displayName: 'Resume Retry',
      });
      const subscription = repo.createSubscription({
        spaceId: SPACE_ID,
        agentId: agent.id,
        source: 'github',
        topic: DEFAULT_TOPIC,
      });
      const otherAgent = repo.create({
        id: 'lh-agent-resume-other',
        spaceId: OTHER_SPACE_ID,
        handle: 'resume-other',
        displayName: 'Resume Other',
      });
      const otherSubscription = repo.createSubscription({
        spaceId: OTHER_SPACE_ID,
        agentId: otherAgent.id,
        source: 'github',
        topic: DEFAULT_TOPIC,
      });
      const event = makeEvent({ id: 'evt-lh-resume-retry' });
      const otherEvent = makeEvent({ id: 'evt-lh-resume-other' });
      eventStore.store(event);
      eventStore.store(otherEvent);
      const deliveryKey = `lh:${subscription.id}:${event.id}`;
      eventStore.registerExpectedDelivery(event.id, deliveryKey, {
        workflowRunId: `long_horizon:${SPACE_ID}`,
        taskId: subscription.id,
        nodeId: agent.id,
        agentName: agent.id,
      });
      const otherDeliveryKey = `lh:${otherSubscription.id}:${otherEvent.id}`;
      eventStore.registerExpectedDelivery(otherEvent.id, otherDeliveryKey, {
        workflowRunId: `long_horizon:${OTHER_SPACE_ID}`,
        taskId: otherSubscription.id,
        nodeId: otherAgent.id,
        agentName: otherAgent.id,
      });
      eventStore.markDeliveryFailed(event.id, deliveryKey, {
        terminal: false,
        reason: 'long-horizon agent unavailable',
      });
      eventStore.markDeliveryFailed(otherEvent.id, otherDeliveryKey, {
        terminal: false,
        reason: 'long-horizon agent unavailable',
      });

      const runtime2 = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        internalEventBus: bus,
        commandBus: (runtime as unknown as { config: { commandBus: unknown } }).config
          .commandBus as never,
        externalEventStore: eventStore,
        longHorizonAgentRepo: repo,
        taskAgentManager: tam as never,
        deliverLongHorizonExternalEvent: async ({ agentId, message, idempotencyKey }) => {
          longHorizonMessages.push({ agentId, message, idempotencyKey });
          return { delivered: true };
        },
      });

      runtime2.onSpaceResumed(SPACE_ID);
      await wait(100);

      expect(longHorizonMessages).toHaveLength(1);
      expect(longHorizonMessages[0]!.agentId).toBe(agent.id);
      expect(longHorizonMessages[0]!.idempotencyKey).toBe(deliveryKey);
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
      expect(eventStore.listDeliveries(otherEvent.id)[0]!.state).toBe('pending');
    });
  });
});
