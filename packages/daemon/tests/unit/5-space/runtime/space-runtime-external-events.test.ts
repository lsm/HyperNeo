import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import { ExternalEventQueueMetrics } from '../../../../src/lib/external-events/queue-health-metrics';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
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
const LEGACY_TOPIC = 'github/*/*/pull_request.review_*';

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
  /** sessionId → processing-state status (unset = not interrupted). */
  processingStates = new Map<string, string>();
  /** sessionIds with an interrupt actually in flight (vs stale persisted state). */
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

  isSessionAlive(sessionId: string): boolean {
    return this.alive.has(sessionId);
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
      // Mirror AgentSession.normalizeStaleInterruptedState: flip a stale
      // persisted 'interrupted' state to idle.
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
  /**
   * When true, the registered `agent.message.inject` handler returns a
   * recoverable (`ok: false`) failure so tests can exercise the delivery
   * cool-down / retry paths. Reset to false in beforeEach.
   */
  let injectShouldFail: boolean;
  let longHorizonMessages: Array<{ agentId: string; message: string; idempotencyKey?: string }>;
  let tam: MockTaskAgentManager;
  let bus: ReturnType<typeof createDaemonInternalEventBus>;
  let spaceManager: SpaceManager;

  function createWorkflow(
    nodeId = 'code',
    options: { eventInterests?: Array<{ topic: string }> } = {}
  ): SpaceWorkflow {
    return workflowManager.createWorkflow({
      spaceId: SPACE_ID,
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

  /**
   * Create a workflow, start a run, and register a subscription topic.
   * Returns the workflow, run, and canonical task.
   */
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

  /**
   * Stamp a run's reviewed PR URL the way the production `pr_ready` hook does
   * — as a `link kind:'pr'` artifact, which `CodingArtifactProfile.resolvePrimaryLinkUrl`
   * reads for external-event PR-to-run coupling. (Replaces the former gate-data
   * `'pr'` row written by the removed approval gate.)
   */
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
    expect(JSON.parse(longHorizonMessages[0]!.message).eventId).toBe(event.id);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    const deliveries = eventStore.listDeliveries(event.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.state).toBe('delivered');
    expect(longHorizonMessages[0]!.idempotencyKey).toBe(deliveries[0]!.deliveryKey);
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

  test('injects a lean external event essence with full body and handles', async () => {
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-essence',
      startedAt: Date.now(),
    });
    tam.alive.add('session-essence');
    const body = [
      'First paragraph with the actionable review request.',
      '',
      'Second paragraph contains enough detail that a summary would be insufficient.',
      '',
      'Third paragraph must remain verbatim; no ellipsis should appear here.',
    ].join('\n');

    const event = makeEvent({
      summary: 'PR #42 inline review comment by codex: First paragraph...',
      payload: {
        eventType: 'pull_request_review_comment',
        action: 'created',
        actor: 'codex',
        repoOwner: 'lsm',
        repoName: 'neokai',
        prNumber: 42,
        prUrl: 'https://github.com/lsm/neokai/pull/42',
        body,
        title: 'PR #42 inline review comment',
        replyHandle: { kind: 'pull_request_review_comment', commentId: 123 },
        resolveHandle: { kind: 'pull_request_review_thread', threadId: 'PRRT_kwDOExample' },
        resolveThreadId: 'PRRT_kwDOExample',
        commentId: 123,
        commentNodeId: 'PRRC_kwDOExample',
        path: 'packages/daemon/src/file.ts',
        line: 17,
        side: 'RIGHT',
        inReplyToId: 99,
        rawPayload: { giant: 'webhook payload' },
      },
    });
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    const message = JSON.parse(injected[0]!.message);
    expect(message).toMatchObject({
      type: 'external_event',
      eventId: event.id,
      topic: event.topic,
      eventType: 'pull_request_review_comment',
      action: 'created',
      actor: 'codex',
      repo: 'lsm/neokai',
      prNumber: 42,
      prUrl: 'https://github.com/lsm/neokai/pull/42',
      occurredAt: event.occurredAt,
      body,
      title: 'PR #42 inline review comment',
      replyHandle: { kind: 'pull_request_review_comment', commentId: 123 },
      resolveHandle: { kind: 'pull_request_review_thread', threadId: 'PRRT_kwDOExample' },
      resolveThreadId: 'PRRT_kwDOExample',
      commentId: 123,
      path: 'packages/daemon/src/file.ts',
      line: 17,
      side: 'RIGHT',
      inReplyToId: 99,
    });
    expect(message.body).toBe(body);
    expect(JSON.stringify(message)).not.toContain('...');
    expect(message.summary).toBeUndefined();
    expect(message.payload).toBeUndefined();
    expect(message.rawPayload).toBeUndefined();
  });

  test('injects per-type external event essence fields', async () => {
    const { run } = await startRunWithSubscription('github/lsm/neokai/pull_request/42.*');
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-per-type-essence',
      startedAt: Date.now(),
    });
    tam.alive.add('session-per-type-essence');
    const cases = [
      {
        eventType: 'issue_comment',
        action: 'comment_created',
        topic: 'github/lsm/neokai/pull_request/42.comment_created',
        payload: {
          commentId: 201,
          commentNodeId: 'IC_kwDOExample',
          replyHandle: { kind: 'issue_comment', commentId: 201 },
        },
        expected: { commentId: 201, replyHandle: { kind: 'issue_comment', commentId: 201 } },
      },
      {
        eventType: 'pull_request_review',
        action: 'review_submitted',
        topic: 'github/lsm/neokai/pull_request/42.review_submitted',
        payload: {
          reviewId: 301,
          reviewNodeId: 'PRR_kwDOExample',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-06-26T00:00:00Z',
        },
        expected: {
          reviewId: 301,
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-06-26T00:00:00Z',
        },
      },
      {
        eventType: 'pull_request',
        action: 'synchronize',
        topic: 'github/lsm/neokai/pull_request/42.synchronize',
        payload: { title: 'Update daemon', state: 'open', headSha: 'abc123', draft: false },
        expected: { title: 'Update daemon', state: 'open', headSha: 'abc123', draft: false },
      },
      {
        eventType: 'check_run',
        action: 'check_failed',
        topic: 'github/lsm/neokai/pull_request/42.check_failed',
        payload: {
          checkName: 'daemon unit tests',
          conclusion: 'failure',
          runUrl: 'https://github.com/lsm/neokai/actions/runs/1',
          status: 'completed',
        },
        expected: {
          checkName: 'daemon unit tests',
          conclusion: 'failure',
          runUrl: 'https://github.com/lsm/neokai/actions/runs/1',
          status: 'completed',
        },
      },
    ];

    for (const [index, item] of cases.entries()) {
      await eventService.publish(
        makeEvent({
          id: `evt-essence-type-${index}`,
          dedupeKey: `dedupe-essence-type-${index}`,
          topic: item.topic,
          payload: {
            eventType: item.eventType,
            action: item.action,
            actor: 'octocat',
            repoOwner: 'lsm',
            repoName: 'neokai',
            prNumber: 42,
            prUrl: 'https://github.com/lsm/neokai/pull/42',
            body: `${item.eventType} body`,
            ...item.payload,
            rawPayload: { drop: true },
          },
        })
      );
    }

    expect(injected).toHaveLength(cases.length);
    for (const [index, item] of cases.entries()) {
      const message = JSON.parse(injected[index]!.message);
      expect(message).toMatchObject({
        type: 'external_event',
        topic: item.topic,
        eventType: item.eventType,
        repo: 'lsm/neokai',
        body: `${item.eventType} body`,
        ...item.expected,
      });
      expect(message.rawPayload).toBeUndefined();
      expect(message.payload).toBeUndefined();
      expect(message.summary).toBeUndefined();
    }
  });

  test('delivers matching events to a live node-agent session and marks delivery complete', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-live',
      startedAt: Date.now(),
    });
    tam.alive.add('session-live');

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-live');
    // External events always defer to the next idle boundary — never injected
    // mid-work, even when the live session is actively processing.
    expect(injected[0]!.deliveryMode).toBe('defer');
    expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    const deliveries = eventStore.listDeliveries(event.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.state).toBe('delivered');
    expect(deliveries[0]!.taskId).toBe(task.id);
  });

  test('defers external events to the next idle boundary for both busy and idle live sessions (never mid-work)', async () => {
    // Design intent (2026-08-13): an external event to a LIVE session must
    // ALWAYS be handed to the inject layer in 'defer' mode — insert when idle,
    // queue and replay at the next idle point when busy. The runtime never
    // requests 'immediate' (which would inject mid-work and derail an
    // actively-processing agent). The inject layer (injectMessageIntoSession)
    // owns the idle→deliver-now vs busy→replay-at-idle decision; here we assert
    // the runtime always asks for 'defer', for both a busy and an idle session.
    // This test fails before the change (live-session deliveries defaulted to
    // 'immediate') and passes after.
    const BUSY_TOPIC = 'github/lsm/neokai/pull_request/42.review_*';
    const IDLE_TOPIC = 'github/lsm/neokai/pull_request/43.review_*';

    // Busy live session — actively processing.
    const { run: busyRun, task: busyTask } = await startRunWithSubscription(
      BUSY_TOPIC,
      'code-busy'
    );
    const busyExec = nodeExecutionRepo.listByNode(busyRun.id, 'code-busy')[0]!;
    nodeExecutionRepo.update(busyExec.id, {
      status: 'in_progress',
      agentSessionId: 'session-busy-defer',
      startedAt: Date.now(),
    });
    tam.alive.add('session-busy-defer');

    // Idle live session — waiting, not processing.
    const { run: idleRun, task: idleTask } = await startRunWithSubscription(
      IDLE_TOPIC,
      'code-idle'
    );
    const idleExec = nodeExecutionRepo.listByNode(idleRun.id, 'code-idle')[0]!;
    nodeExecutionRepo.update(idleExec.id, {
      status: 'idle',
      agentSessionId: 'session-idle-defer',
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    tam.alive.add('session-idle-defer');

    const busyEvent = makeEvent({
      topic: 'github/lsm/neokai/pull_request/42.review_submitted',
    });
    const idleEvent = makeEvent({
      topic: 'github/lsm/neokai/pull_request/43.review_submitted',
    });
    await eventService.publish(busyEvent);
    await eventService.publish(idleEvent);

    const busyInject = injected.find((i) => i.sessionId === 'session-busy-defer')!;
    const idleInject = injected.find((i) => i.sessionId === 'session-idle-defer')!;

    // Both reach the inject layer in 'defer' mode — never 'immediate'. This is
    // the assertion that flips from 'immediate' to 'defer' under this change.
    expect(busyInject.deliveryMode).toBe('defer');
    expect(idleInject.deliveryMode).toBe('defer');

    // Both are accepted by the inject layer ('delivered' = handed off). For the
    // busy session the inject layer persists a deferred row for replay at the
    // next idle point; for the idle session it delivers now.
    expect(eventStore.getById(busyEvent.id)?.state).toBe('delivered');
    expect(eventStore.getById(idleEvent.id)?.state).toBe('delivered');
    expect(eventStore.listDeliveries(busyEvent.id)[0]!.taskId).toBe(busyTask.id);
    expect(eventStore.listDeliveries(idleEvent.id)[0]!.taskId).toBe(idleTask.id);
  });

  test('keeps an external event pending while the live session is mid-interrupt, delivering after the interrupt resolves', async () => {
    // P2 regression guard: InterruptHandler completes via setIdle WITHOUT
    // publishing query.trigger, so a deferred row handed to a mid-interrupt
    // session is never replayed — the delivery would be marked delivered while
    // the row sits unconsumed indefinitely. The runtime must park the delivery
    // (queue + retry) instead of handing it off in 'defer' mode, then deliver
    // at the true idle once the interrupt resolves.
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-interrupted',
      startedAt: Date.now(),
    });
    tam.alive.add('session-interrupted');
    tam.processingStates.set('session-interrupted', 'interrupted');
    tam.interrupting.add('session-interrupted');

    const event = makeEvent();
    await eventService.publish(event);

    // Not handed off while mid-interrupt: no injection, delivery still pending.
    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    // Parked with a defer-encoded reason (non-terminal): after a daemon
    // restart, requeuePersistedPendingDeliveries reconstructs 'defer' from it
    // — a null reason would recover as 'immediate'.
    expect(delivery.failureReason).toBe('deliveryMode:defer; target_session_interrupted');

    // The interrupt resolves — the session reaches a true idle.
    tam.processingStates.set('session-interrupted', 'idle');

    // The parked retry fires and delivers at the true idle boundary.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-interrupted');
    expect(injected[0]!.deliveryMode).toBe('defer');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    await runtime.stop();
  });

  test('does not park on a stale persisted interrupted state (no interrupt in flight)', async () => {
    // A daemon crash between setInterrupted and setIdle leaves the persisted
    // processing state 'interrupted' with no interrupt operation remaining to
    // resolve it — parking on that state would hold the delivery until TTL.
    // Only an interrupt actually in flight is a parking signal; a stale
    // interrupted session takes the normal defer handoff.
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-stale-interrupted',
      startedAt: Date.now(),
    });
    tam.alive.add('session-stale-interrupted');
    tam.processingStates.set('session-stale-interrupted', 'interrupted');
    // No tam.interrupting entry — the interrupt is not in flight.

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-stale-interrupted');
    expect(injected[0]!.deliveryMode).toBe('defer');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('a shared-PR synchronize (commit push) does NOT stamp any co-subscriber lastActivityAt', async () => {
    // Regression guard for the commit-push attribution bug (review P1):
    // pull_request.synchronize is a PR-LEVEL event that fans out to EVERY
    // subscriber (e.g. a coder run AND a reviewer run watching the same PR).
    // lastActivityAt must not advance for any of them — a node's OWN push is
    // already captured by its tool calls (the sdk.toolUse source, which is
    // node-scoped), and a PR-level event cannot be attributed to one node.
    // Stamping here would mark an idle co-subscriber active and suppress its
    // stall nag for a full threshold window.
    const PR_TOPIC = 'github/lsm/neokai/pull_request/42.*';

    const { run: coderRun } = await startRunWithSubscription(PR_TOPIC, 'code');
    const coderExec = nodeExecutionRepo.listByNode(coderRun.id, 'code')[0]!;
    nodeExecutionRepo.update(coderExec.id, {
      status: 'in_progress',
      agentSessionId: 'session-shared-coder',
      startedAt: Date.now(),
    });
    tam.alive.add('session-shared-coder');

    const { run: reviewerRun } = await startRunWithSubscription(PR_TOPIC, 'review');
    const reviewerExec = nodeExecutionRepo.listByNode(reviewerRun.id, 'review')[0]!;
    nodeExecutionRepo.update(reviewerExec.id, {
      status: 'in_progress',
      agentSessionId: 'session-shared-reviewer',
      startedAt: Date.now(),
    });
    tam.alive.add('session-shared-reviewer');

    await eventService.publish(
      makeEvent({
        topic: 'github/lsm/neokai/pull_request/42.synchronize',
        payload: { action: 'synchronize', prNumber: 42, headSha: 'abc123' },
      })
    );

    // Sanity: the fan-out reached at least the coder target, so the delivery
    // path that USED to stamp ran (under the old code coderExec.lastActivityAt
    // would now be non-null).
    expect(injected.some((i) => i.sessionId === 'session-shared-coder')).toBe(true);
    // Neither the pushing node's run NOR the co-subscribed reviewer run is
    // stamped as active by the PR-level event.
    expect(nodeExecutionRepo.getById(coderExec.id)!.lastActivityAt).toBeNull();
    expect(nodeExecutionRepo.getById(reviewerExec.id)!.lastActivityAt).toBeNull();
  });

  test('delivers matching events to an idle node-agent session', async () => {
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: 'session-idle',
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    tam.alive.add('session-idle');

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-idle');
    // Still delivered promptly when idle — defer mode delivers now when idle.
    expect(injected[0]!.deliveryMode).toBe('defer');
    expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('delivers matching events to an idle subscriber while the task is in review', async () => {
    const { run, task } = await startRunWithSubscription();
    taskRepo.updateTask(task.id, { status: 'review' });
    await (
      runtime as unknown as {
        transitionRunStatusAndEmit(runId: string, nextStatus: 'done'): Promise<unknown>;
      }
    ).transitionRunStatusAndEmit(run.id, 'done');
    await runtime.executeTick();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: 'session-review-task-idle',
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    tam.alive.add('session-review-task-idle');

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-review-task-idle');
    expect(injected[0]!.deliveryMode).toBe('defer');
    expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('flushes pending external deliveries after a review task node activates', async () => {
    const { run, task } = await startRunWithSubscription();
    taskRepo.updateTask(task.id, { status: 'review' });
    await (
      runtime as unknown as {
        transitionRunStatusAndEmit(runId: string, nextStatus: 'done'): Promise<unknown>;
      }
    ).transitionRunStatusAndEmit(run.id, 'done');
    await runtime.executeTick();

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    const pendingDelivery = eventStore.listDeliveries(event.id)[0]!;
    expect(pendingDelivery.state).toBe('pending');
    expect(pendingDelivery.failureReason).not.toBe('run_not_externally_deliverable');

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-review-task-flush',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-review-task-flush');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
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

    // Done tasks are terminal and cannot deliver events. Rebuilding their
    // interests would fan every later matching event out across historical runs
    // only to fail each delivery with target_task_terminal.
    expect(matches.some((match) => match.workflowRunId === run.id)).toBe(false);
  });

  test('keeps subscriptions while completion routes the task to approved', async () => {
    const { run, task } = await startRunWithSubscription();
    await (
      runtime as unknown as {
        transitionRunStatusAndEmit(runId: string, nextStatus: 'done'): Promise<unknown>;
      }
    ).transitionRunStatusAndEmit(run.id, 'done');
    taskRepo.updateTask(task.id, { status: 'approved' });
    await runtime.executeTick();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: 'session-approved-task-idle',
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    tam.alive.add('session-approved-task-idle');

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-approved-task-idle');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('does not deliver matching events to a cancelled node execution', async () => {
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'cancelled',
      agentSessionId: 'session-cancelled',
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    tam.alive.add('session-cancelled');

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    expect(delivery.failureReason).toBe('deliveryMode:defer; node_execution_not_active');
  });

  test('queues matching events for pending nodes and flushes after session creation', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();

    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    expect(eventStore.getById(event.id)?.state).toBe('published');
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-flush',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-flush');
    // Pre-activation queued events flush in 'defer' mode too: the stored mode
    // is forwarded unchanged, and 'immediate' would steer an already-processing
    // session mid-turn. Defer + idle at flush delivers now (no difference for
    // a fresh session).
    expect(injected[0]!.deliveryMode).toBe('defer');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('retains unmatched events until a dynamic subscription registers', async () => {
    const { run, task } = await startRunWithSubscription(DEFAULT_TOPIC);
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-late-subscription',
      startedAt: Date.now(),
    });
    tam.alive.add('session-late-subscription');
    await runtime.executeTick();

    const event = makeEvent({ topic: 'github/lsm/neokai/pull_request/42.comment_created' });
    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    expect(eventStore.getById(event.id)?.state).toBe('published');

    runtime.registerSubscription(
      run.id,
      task.id,
      'code',
      'coder',
      'github/*/*/pull_request/*.comment_created'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-late-subscription');
  });

  test('persists the defer mode when a live session is skipped while its space is paused', async () => {
    // The paused-live early return must not leave a null failureReason:
    // onSpaceResumed reconstructs the mode from it, so the defer intent is
    // recorded explicitly rather than relying on the recovery default.
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-paused-live',
      startedAt: Date.now(),
    });
    tam.alive.add('session-paused-live');
    db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
    // The paused check reads the synchronous delivery-hold cache (kept in
    // sync by the space pause/stop registers), not the raw column.
    runtime.holdSpaceDeliveries(SPACE_ID);

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    expect(delivery.failureReason).toBe('deliveryMode:defer; space_paused');

    db.prepare(`UPDATE spaces SET paused = 0 WHERE id = ?`).run(SPACE_ID);
    await runtime.stop();
  });

  test('a STOPPED space holds external-event delivery; start requeues it', async () => {
    // The stop chain: stop commits (row stopped + the onSpaceStopped callback
    // adds the space to the sync delivery-hold cache) → a published event pends
    // rather than injecting → start clears the hold and requeues it. This is
    // the PR's headline "holds delivery while stopped" — only the paused
    // variant was pinned.
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-stopped-live',
      startedAt: Date.now(),
    });
    tam.alive.add('session-stopped-live');
    db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);
    runtime.holdSpaceDeliveries(SPACE_ID);

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    // The defer-mode stamp the resume requeue reconstructs its delivery mode
    // from (mirroring the paused sibling's convention).
    expect(delivery.failureReason).toContain('deliveryMode:defer');

    // Start clears the hold (onSpaceResumed) and requeues the deferred
    // delivery; the flush delivers it into the live session.
    db.prepare(`UPDATE spaces SET stopped = 0 WHERE id = ?`).run(SPACE_ID);
    await runtime.onSpaceResumed(SPACE_ID);
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-stopped-live',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-stopped-live');
    await runtime.stop();
  });

  test('delivers a linked-PR event after a matching subscription registers', async () => {
    const { workflow, run, task } = await startRunWithSubscription(DEFAULT_TOPIC);
    await runtime.executeTick();
    stampRunPr(run.id, 'https://github.com/lsm/neokai/pull/42');

    await runtime.stop();
    eventStore.store(
      makeEvent({
        id: 'evt-linked-pr-redeliver',
        topic: 'github/lsm/neokai/pull_request/42.comment_created',
      })
    );

    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-linked-pr-redeliver',
      startedAt: Date.now(),
    });
    tam.alive.add('session-linked-pr-redeliver');
    runtime.registerSubscription(
      run.id,
      task.id,
      'code',
      'coder',
      'github/*/*/pull_request/*.comment_created'
    );

    await runtime.executeTick();

    expect(eventStore.listDeliveries('evt-linked-pr-redeliver')).toHaveLength(1);
    const delivery = eventStore.listDeliveries('evt-linked-pr-redeliver')[0]!;
    expect(delivery.state).toBe('delivered');
    expect(delivery.taskId).toBe(task.id);
    expect(eventStore.getById('evt-linked-pr-redeliver')?.state).toBe('delivered');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-linked-pr-redeliver');
  });

  test('retains unmatched events without PR-to-run coupling until the TTL', async () => {
    const { run } = await startRunWithSubscription(DEFAULT_TOPIC);
    await runtime.executeTick();
    stampRunPr(run.id, 'https://github.com/lsm/neokai/pull/99');

    const event = makeEvent({ topic: 'github/lsm/neokai/pull_request/42.comment_created' });
    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    expect(eventStore.getById(event.id)?.state).toBe('published');
  });

  test('fails unmatched events that stay unclaimed past the TTL', async () => {
    const { run } = await startRunWithSubscription(DEFAULT_TOPIC);
    await runtime.executeTick();
    stampRunPr(run.id, 'https://github.com/lsm/neokai/pull/42');

    await runtime.stop();
    eventStore.store(
      makeEvent({
        id: 'evt-linked-pr-expired',
        topic: 'github/lsm/neokai/pull_request/42.comment_created',
      })
    );

    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });

    const originalNow = Date.now;
    Date.now = () => originalNow() + 300_001;
    try {
      await runtime.executeTick();
    } finally {
      Date.now = originalNow;
    }

    expect(eventStore.listDeliveries('evt-linked-pr-expired')).toHaveLength(0);
    expect(eventStore.getById('evt-linked-pr-expired')?.state).toBe('failed');
  });

  test('fails queued deliveries when an execution is unregistered', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);

    runtime.unregisterExecution(run.id, task.id, 'code', 'coder');

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('node_execution_cancelled');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('throws for invalid static event interest topics during registration', async () => {
    const workflow = createWorkflow();
    workflow.nodes[0]!.agents![0]!.eventInterests = [{ topic: 'github/**/pull_request/*.opened' }];
    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

    expect(() => runtime.registerRunInterests(run.id, tasks[0]!.id, workflow.nodes)).toThrow(
      'Invalid static external event interest'
    );
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

  test('drops stale queued deliveries when run interests are rebuilt', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);

    runtime.registerRunInterests(run.id, task.id, workflow.nodes, {
      clearQueuedDeliveries: true,
    });
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-stale',
    });

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('run_interests_rebuilt');
  });

  test('does not ignore unmatched events before runtime rehydrate completes', async () => {
    const event = makeEvent();
    await eventService.publish(event);

    expect(eventStore.getById(event.id)?.state).toBe('published');
    expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
  });

  test('re-subscribes external event listener after runtime restart', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-restart',
      startedAt: Date.now(),
    });
    tam.alive.add('session-restart');

    await runtime.stop();
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );
    runtime.start();
    await runtime.executeTick();

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-restart');
  });

  test('delivers five-segment events to legacy four-segment GitHub subscriptions', async () => {
    const { run } = await startRunWithSubscription(LEGACY_TOPIC);
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-legacy-topic',
      startedAt: Date.now(),
    });
    tam.alive.add('session-legacy-topic');

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-legacy-topic');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('deduplicates dispatch attempts for overlapping interests', async () => {
    const { run, task } = await startRunWithSubscription('github/*/*/pull_request/*.*');
    // Register a second overlapping topic
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-dedupe',
      startedAt: Date.now(),
    });
    tam.alive.add('session-dedupe');

    const event = makeEvent();
    await eventService.publish(event);

    expect(eventStore.listDeliveries(event.id)).toHaveLength(1);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-dedupe');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('preserves subscriptions across dependency-added block and recovery', async () => {
    const { run, task } = await startRunWithSubscription(DEFAULT_TOPIC);
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-before-block',
      startedAt: Date.now(),
    });
    tam.alive.add('session-before-block');

    await runtime.blockWorkflowBackedTask(SPACE_ID, task.id, {
      status: 'blocked',
      blockReason: 'dependency_added',
      result: 'Dependency added while task was in progress',
      completedAt: null,
    });
    const blockedEvent = makeEvent({
      id: 'evt-blocked-preserved-subscription',
      dedupeKey: 'dedupe-blocked-preserved-subscription',
    });
    await eventService.publish(blockedEvent);
    expect(eventStore.getById(blockedEvent.id)?.state).toBe('published');
    // The blocked task is still active, so the event is accepted as a pending
    // delivery (queued for the recovered slot) rather than ignored.
    expect(eventStore.listDeliveries(blockedEvent.id)).toHaveLength(1);
    expect(eventStore.listDeliveries(blockedEvent.id)[0]!.state).toBe('pending');

    await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');
    const recoveredExecution = [...nodeExecutionRepo.listByNode(run.id, 'code')]
      .filter((execution) => execution.completedAt === null && execution.status !== 'cancelled')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
    const sessionId = recoveredExecution.agentSessionId ?? 'session-after-recover';
    nodeExecutionRepo.update(recoveredExecution.id, {
      status: 'in_progress',
      agentSessionId: sessionId,
      startedAt: Date.now(),
      completedAt: null,
    });
    tam.alive.add(sessionId);

    const event = makeEvent();
    await eventService.publish(event);

    // Both the retained blocked event and the new event deliver to the recovered
    // slot — the subscription survived the block, and the queued event is no
    // longer dropped when the run is blocked.
    expect(injected).toHaveLength(2);
    expect(injected.every((item) => item.sessionId === sessionId)).toBe(true);
    expect(eventStore.getById(blockedEvent.id)?.state).toBe('delivered');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('resetBlockedExecutionsForRun resets blocked node executions to pending', async () => {
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, { status: 'blocked', completedAt: null });

    runtime.resetBlockedExecutionsForRun(run.id);

    const updated = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    expect(updated.status).toBe('pending');
  });

  test('fails queued deliveries when task-owned run interests are cleared', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    // Task cancellation/archive triggers clearRunInterests at the service layer;
    // run status no longer clears subscriptions on its own.
    runtime.clearRunInterests(run.id);

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('run_terminal_cleanup');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('delivers matching events to idle sessions using defer mode', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-idle',
      startedAt: Date.now(),
    });

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-idle');
    expect(injected[0]!.deliveryMode).toBe('defer');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('coalesces events over rate limit into a digest', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-rate-limit',
      startedAt: Date.now(),
    });
    tam.alive.add('session-rate-limit');
    const rateLimitState = runtime as unknown as {
      externalEventRateLimits: Map<string, unknown>;
    };

    const events = Array.from({ length: 15 }, (_, index) =>
      makeEvent({
        id: `evt-rate-limit-${index}`,
        dedupeKey: `dedupe-rate-limit-${index}`,
        topic:
          index % 2 === 0
            ? 'github/lsm/neokai/pull_request/42.review_submitted'
            : 'github/lsm/neokai/pull_request/42.review_comment',
        occurredAt: 1_700_000_000_000 + index,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected).toHaveLength(11);
    expect(injected.slice(0, 10).map((item) => JSON.parse(item.message).eventId)).toEqual(
      events.slice(0, 10).map((event) => event.id)
    );
    expect(injected[10]!.message).toContain(
      '5 events received for topics: github/lsm/neokai/pull_request/42.review_comment, github/lsm/neokai/pull_request/42.review_submitted'
    );
    expect(injected[10]!.message).toContain(
      '(oldest: 2023-11-14T22:13:20.010Z, newest: 2023-11-14T22:13:20.014Z)'
    );
    expect(injected[10]!.message).toContain('Use get_external_event(eventId) for full details.');
    // The digest must carry the coalesced event ids so the agent can fetch the
    // full record via get_external_event(eventId) — otherwise the pointer is
    // unusable. The 5 coalesced events are evt-rate-limit-10..14.
    for (const id of ['evt-rate-limit-10', 'evt-rate-limit-14']) {
      expect(injected[10]!.message).toContain(`Event IDs: `);
      expect(injected[10]!.message).toContain(id);
    }
    for (const event of events) {
      expect(eventStore.getById(event.id)?.state).toBe('delivered');
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    }
    expect(rateLimitState.externalEventRateLimits.size).toBe(1);
  });

  test('releases idle rate-limit buckets after window expiry', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-rate-cleanup',
      startedAt: Date.now(),
    });
    tam.alive.add('session-rate-cleanup');
    const event = makeEvent({ id: 'evt-rate-cleanup', dedupeKey: 'dedupe-rate-cleanup' });

    await eventService.publish(event);
    const rateLimitState = runtime as unknown as {
      externalEventRateLimits: Map<string, { timestamps: number[] }>;
      scheduleExternalEventRateLimitCleanup(rateLimitKey: string): void;
    };
    expect(rateLimitState.externalEventRateLimits.has(execution.id)).toBe(true);

    const state = rateLimitState.externalEventRateLimits.get(execution.id)! as {
      timestamps: number[];
      cleanupTimer: Timer | null;
    };
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
    state.timestamps = [Date.now() - 60_001];
    rateLimitState.scheduleExternalEventRateLimitCleanup(execution.id);

    expect(rateLimitState.externalEventRateLimits.has(execution.id)).toBe(false);
  });

  test('coalesces all events after digest within the same rate window', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-sustained-rate-limit',
      startedAt: Date.now(),
    });
    tam.alive.add('session-sustained-rate-limit');
    const originalNow = Date.now;
    let fakeNow = originalNow();
    Date.now = () => fakeNow;
    try {
      const firstBurst = Array.from({ length: 15 }, (_, index) =>
        makeEvent({
          id: `evt-sustained-rate-first-${index}`,
          dedupeKey: `dedupe-sustained-rate-first-${index}`,
          occurredAt: 1_700_000_000_000 + index,
        })
      );
      for (const event of firstBurst) {
        await eventService.publish(event);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(injected).toHaveLength(11);

      fakeNow += 1_000;
      const secondBurst = Array.from({ length: 3 }, (_, index) =>
        makeEvent({
          id: `evt-sustained-rate-second-${index}`,
          dedupeKey: `dedupe-sustained-rate-second-${index}`,
          occurredAt: 1_700_000_001_000 + index,
        })
      );
      for (const event of secondBurst) {
        await eventService.publish(event);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(injected).toHaveLength(12);
      expect(injected[11]!.message).toContain(
        '3 events received for topics: github/lsm/neokai/pull_request/42.review_submitted'
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test('flushes digest to the current execution session', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-digest-stale',
      startedAt: Date.now(),
    });
    tam.alive.add('session-digest-stale');
    const events = Array.from({ length: 11 }, (_, index) =>
      makeEvent({
        id: `evt-digest-current-session-${index}`,
        dedupeKey: `dedupe-digest-current-session-${index}`,
        occurredAt: 1_700_000_000_000 + index,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    tam.alive.delete('session-digest-stale');
    tam.alive.add('session-digest-fresh');
    nodeExecutionRepo.update(execution.id, {
      agentSessionId: 'session-digest-fresh',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected).toHaveLength(11);
    expect(injected[10]!.sessionId).toBe('session-digest-fresh');
    expect(injected[10]!.message).toContain(
      '1 events received for topics: github/lsm/neokai/pull_request/42.review_submitted'
    );
    expect(eventStore.getById(events[10]!.id)?.state).toBe('delivered');
  });

  test('retries digest failures against the resolved flush target', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-digest-stale-retry',
      startedAt: Date.now(),
    });
    tam.alive.add('session-digest-stale-retry');
    await runtime.stop();
    let failNext = true;
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      if (failNext && command.metadata?.source === 'external_event_digest') {
        failNext = false;
        return { ok: false, error: 'temporary digest target failure' };
      }
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    const events = Array.from({ length: 11 }, (_, index) =>
      makeEvent({
        id: `evt-digest-resolved-retry-${index}`,
        dedupeKey: `dedupe-digest-resolved-retry-${index}`,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    tam.alive.delete('session-digest-stale-retry');
    tam.alive.add('session-digest-fresh-retry');
    nodeExecutionRepo.update(execution.id, {
      agentSessionId: 'session-digest-fresh-retry',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(10);
    const digestDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
    expect(digestDelivery.failureReason).toBe(
      'deliveryMode:defer; digest; temporary digest target failure'
    );

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(injected).toHaveLength(11);
    expect(injected[10]!.sessionId).toBe('session-digest-fresh-retry');
    expect(eventStore.getById(events[10]!.id)?.state).toBe('delivered');
  });

  test('does not deliver activation-flushed digest to a superseded session', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;

    // Events queue while the worker is not yet active (no live session).
    const events = Array.from({ length: 11 }, (_, index) =>
      makeEvent({
        id: `evt-digest-superseded-${index}`,
        dedupeKey: `dedupe-digest-superseded-${index}`,
        occurredAt: 1_700_000_000_000 + index,
      })
    );
    for (const event of events) {
      await eventService.publish(event);
    }
    for (const event of events) {
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
    }

    // The worker activates — spawn assigns its agentSessionId before the
    // activation flush drains the pending queue.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-activation',
      startedAt: Date.now(),
      completedAt: null,
    });
    tam.alive.add('session-activation');
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-activation',
    });

    // The first ten events dispatch synchronously to the activation session
    // (under the rate limit); the eleventh is deferred to the digest timer.
    expect(injected).toHaveLength(10);
    expect(injected.every((item) => item.sessionId === 'session-activation')).toBe(true);

    // Before the digest timer fires the activation session is superseded: the
    // worker crashed and its execution was reset to pending (agentSessionId
    // cleared) with no live session remaining.
    tam.alive.delete('session-activation');
    nodeExecutionRepo.update(execution.id, {
      status: 'pending',
      agentSessionId: null,
      startedAt: null,
      completedAt: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // The digest must NOT inject into the superseded (dead) session — it is
    // requeued as pending for the next activation instead.
    expect(injected).toHaveLength(10);
    const digestDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
    expect(digestDelivery.state).toBe('pending');
    expect(digestDelivery.failureReason).toContain('session loss');
    expect(eventStore.getById(events[10]!.id)?.state).toBe('published');
  });

  test('retargets activation flush to the current session when the activation session is superseded', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;

    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    // The activation session has been superseded by a respawned worker before
    // the flush runs: the node execution now points at a different live session.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-current',
      startedAt: Date.now(),
      completedAt: null,
    });
    tam.alive.add('session-current');

    // flushPendingNodeQueue is invoked with the stale activation session id;
    // resolveSubscriptionTarget re-resolves onto the current worker so the
    // event is never injected into the superseded session.
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-stale-activation',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-current');
    expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('preserves deferred mode when digest delivery is retried after rehydrate', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-digest-defer',
      startedAt: Date.now(),
    });
    await runtime.stop();
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async () => ({
      ok: false,
      error: 'temporary digest failure',
    }));
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    const events = Array.from({ length: 11 }, (_, index) =>
      makeEvent({
        id: `evt-digest-defer-${index}`,
        dedupeKey: `dedupe-digest-defer-${index}`,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    const digestDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
    expect(digestDelivery.state).toBe('pending');
    expect(digestDelivery.failureReason).toBe(
      'deliveryMode:defer; digest; temporary digest failure'
    );
  });

  test('delivers events within rate limit normally', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-within-rate-limit',
      startedAt: Date.now(),
    });
    tam.alive.add('session-within-rate-limit');
    const events = Array.from({ length: 10 }, (_, index) =>
      makeEvent({ id: `evt-within-rate-${index}`, dedupeKey: `dedupe-within-rate-${index}` })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected).toHaveLength(10);
    expect(injected.map((item) => JSON.parse(item.message).eventId)).toEqual(
      events.map((event) => event.id)
    );
  });

  test('skips re-injection of a failed delivery within the recoverable-failure cool-down', async () => {
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-cooldown-fail',
      startedAt: Date.now(),
    });
    tam.alive.add('session-cooldown-fail');
    // Simulate a recoverable dispatch failure (the storm trigger: a session
    // stuck in a provider-error loop where injection throws non-terminally).
    injectShouldFail = true;

    const event = makeEvent({ id: 'evt-cooldown', dedupeKey: 'dedupe-cooldown' });
    await eventService.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // First injection attempted and failed recoverably → delivery cool-down
    // armed. The event stays `published` (delivery non-terminal) so the source
    // can re-poll and the bounded retry path can still drive recovery.
    expect(injected).toHaveLength(1);
    expect(eventStore.getById(event.id)?.state).toBe('published');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    // Re-publishing the SAME event while its delivery is in cool-down must NOT
    // mint a fresh injection (no fresh `failed` row) — the gate skips and the
    // event stays `published` to re-evaluate once the window lifts.
    await eventService.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected).toHaveLength(1);
    expect(eventStore.getById(event.id)?.state).toBe('published');
    expect(runtime.getQueueHealthSnapshot().counters.cooldownSkips).toBeGreaterThanOrEqual(1);
  });

  test('a distinct event still delivers while another delivery is in cool-down', async () => {
    // Cool-down is per-delivery (event + target), not per-target: a fresh,
    // distinct event must still flow (the burst rate-limit / digest coalesces
    // distinct events); only re-dispatches of an already-failed delivery gate.
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-cooldown-distinct',
      startedAt: Date.now(),
    });
    tam.alive.add('session-cooldown-distinct');
    injectShouldFail = true;

    const eventA = makeEvent({ id: 'evt-cooldown-distinct-a', dedupeKey: 'dedupe-distinct-a' });
    await eventService.publish(eventA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);

    // A distinct event for the same (failing) target is NOT gated — it is a
    // separate delivery and is attempted on its own. (Publishing B also flushes
    // A's pending retry, so the exact injection count is not asserted; the
    // guarantee under test is that B itself reaches the session and delivers.)
    injectShouldFail = false;
    const eventB = makeEvent({ id: 'evt-cooldown-distinct-b', dedupeKey: 'dedupe-distinct-b' });
    await eventService.publish(eventB);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected.some((item) => JSON.parse(item.message).eventId === eventB.id)).toBe(true);
    expect(eventStore.getById(eventB.id)?.state).toBe('delivered');
  });

  test('re-injects a delivery after the recoverable-failure cool-down lifts', async () => {
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-cooldown-lift',
      startedAt: Date.now(),
    });
    tam.alive.add('session-cooldown-lift');
    injectShouldFail = true;

    const event = makeEvent({ id: 'evt-cooldown-lift', dedupeKey: 'dedupe-lift' });
    await eventService.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);

    // Within the cool-down window a re-poll of the same event is gated.
    await eventService.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(runtime.getQueueHealthSnapshot().counters.cooldownSkips).toBeGreaterThanOrEqual(1);

    // Advance past the default 30s cool-down window and let the target accept.
    // The same event's delivery now re-injects and delivers normally.
    injectShouldFail = false;
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) + 35_000;
    try {
      await eventService.publish(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(injected).toHaveLength(2);
      expect(injected.at(-1)!.sessionId).toBe('session-cooldown-lift');
      expect(eventStore.getById(event.id)?.state).toBe('delivered');
    } finally {
      Date.now = realNow;
    }
  });

  test('bounds the delivery cool-down map — sweeps expired entries on arm', () => {
    // A delivery that fails once and is never republished is only reaped lazily
    // on re-query, so a long-running daemon could grow the map without bound.
    // Once the map exceeds its cap, arming sweeps expired entries. White-box:
    // the map + arm helper are private.
    const rt = runtime as unknown as {
      armDeliveryCooldown(key: string): void;
      externalEventDeliveryCooldowns: Map<string, number>;
      deliveryCooldownMs: number;
      deliveryCooldownMapCap: number;
    };
    const cap = rt.deliveryCooldownMapCap;
    expect(cap).toBeGreaterThan(0);
    // Arm cap+1 distinct LIVE entries — the sweep runs but finds none expired.
    for (let i = 0; i <= cap; i++) rt.armDeliveryCooldown(`dk-${i}`);
    expect(rt.externalEventDeliveryCooldowns.size).toBe(cap + 1);
    // Backdate every entry so they are all past the window.
    const stale = Date.now() - rt.deliveryCooldownMs - 1;
    for (const key of rt.externalEventDeliveryCooldowns.keys()) {
      rt.externalEventDeliveryCooldowns.set(key, stale);
    }
    // One more arm triggers the sweep → all expired entries drop, only the new
    // live entry remains.
    rt.armDeliveryCooldown('dk-fresh');
    expect(rt.externalEventDeliveryCooldowns.size).toBe(1);
    expect(rt.externalEventDeliveryCooldowns.has('dk-fresh')).toBe(true);
  });

  test('drops queued deliveries older than ttl instead of delivering them', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent({ id: 'evt-expired-queued', dedupeKey: 'dedupe-expired-queued' });
    await eventService.publish(event);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 300_001;
    try {
      runtime.flushPendingNodeQueue({
        workflowRunId: run.id,
        taskId: task.id,
        nodeId: 'code',
        agentName: 'coder',
        sessionId: 'session-expired-queued',
      });
    } finally {
      Date.now = originalNow;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('ttl_expired');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('evicts expired queued deliveries from memory during retry reschedule', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const staleEvents = Array.from({ length: 50 }, (_, index) =>
      makeEvent({
        id: `evt-stale-queued-${index}`,
        dedupeKey: `dedupe-stale-queued-${index}`,
      })
    );
    for (const event of staleEvents) {
      await eventService.publish(event);
    }
    await runtime.stop();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 300_001;
    try {
      runtime.start();
    } finally {
      Date.now = originalNow;
    }
    const queued = runtime as unknown as {
      pendingExternalEventQueue: Map<string, Array<{ deliveryKey: string }>>;
    };
    expect([...queued.pendingExternalEventQueue.values()].flat()).toHaveLength(0);
    expect(eventStore.listDeliveries(staleEvents[0]!.id)[0]!.failureReason).toBe('ttl_expired');
  });

  test('drops rehydrated pending deliveries using original event created time', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent({
      id: 'evt-expired-rehydrated',
      dedupeKey: 'dedupe-expired-rehydrated',
    });
    await eventService.publish(event);
    await runtime.stop();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 300_001;
    try {
      runtime = new SpaceRuntime({
        db,
        spaceManager: new SpaceManager(db),
        spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        internalEventBus: bus,
        commandBus: createInternalCommandBus(),
        externalEventStore: eventStore,
        taskAgentManager: tam as never,
      });
      runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
      await runtime.rehydrateExecutors();
      runtime.flushPendingNodeQueue({
        workflowRunId: run.id,
        taskId: task.id,
        nodeId: 'code',
        agentName: 'coder',
        sessionId: 'session-expired-rehydrated',
      });
    } finally {
      Date.now = originalNow;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('ttl_expired');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('drops expired rehydrated delivery before scheduling retry', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-expired-retry',
      startedAt: Date.now(),
    });
    tam.alive.add('session-expired-retry');
    await runtime.stop();
    const failingCommandBus = createInternalCommandBus();
    failingCommandBus.register('agent.message.inject', async () => ({
      ok: false,
      error: 'temporary failure before restart',
    }));
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: failingCommandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    const event = makeEvent({
      id: 'evt-expired-rehydrated-retry',
      dedupeKey: 'dedupe-expired-rehydrated-retry',
    });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
    });
    await runtime.stop();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 300_001;
    try {
      runtime = new SpaceRuntime({
        db,
        spaceManager: new SpaceManager(db),
        spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        internalEventBus: bus,
        commandBus,
        externalEventStore: eventStore,
        taskAgentManager: tam as never,
      });
      runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
      await runtime.rehydrateExecutors();
    } finally {
      Date.now = originalNow;
    }

    expect(injected).toHaveLength(0);
    const expiredDelivery = eventStore.listDeliveries(event.id)[0]!;
    expect(expiredDelivery.state).toBe('failed');
    expect(expiredDelivery.failureReason).toBe('ttl_expired');
  });

  test('requeues pending digest deliveries across same-runtime stop and start', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-digest-stop-start',
      startedAt: Date.now(),
    });
    tam.alive.add('session-digest-stop-start');
    const events = Array.from({ length: 11 }, (_, index) =>
      makeEvent({
        id: `evt-digest-stop-start-${index}`,
        dedupeKey: `dedupe-digest-stop-start-${index}`,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    await runtime.stop();
    runtime.start();
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-digest-stop-start',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(eventStore.getById(events[10]!.id)?.state).toBe('delivered');
    expect(injected.some((item) => item.message.includes(events[10]!.id))).toBe(true);
  });

  test('preserves deferred mode for unflushed digest deliveries after rehydrate', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-digest-rehydrate-defer',
      startedAt: Date.now(),
    });
    const events = Array.from({ length: 11 }, (_, index) =>
      makeEvent({
        id: `evt-digest-rehydrate-defer-${index}`,
        dedupeKey: `dedupe-digest-rehydrate-defer-${index}`,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    await runtime.stop();
    const delivery = eventStore.listDeliveries(events[10]!.id)[0]!;
    expect(delivery.failureReason).toBe('deliveryMode:defer; digest pending during runtime stop');
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    await runtime.rehydrateExecutors();
    const queued = runtime as unknown as {
      pendingExternalEventQueue: Map<string, Array<{ deliveryMode: string }>>;
    };

    expect(
      [...queued.pendingExternalEventQueue.values()].some((items) =>
        items.some((item) => item.deliveryMode === 'defer')
      )
    ).toBe(true);
  });

  test('preserves deferred mode when digest fallback requeues after session loss', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-digest-fallback-lost',
      startedAt: Date.now(),
    });
    const events = Array.from({ length: 11 }, (_, index) =>
      makeEvent({
        id: `evt-digest-fallback-lost-${index}`,
        dedupeKey: `dedupe-digest-fallback-lost-${index}`,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    tam.alive.delete('session-digest-fallback-lost');
    nodeExecutionRepo.updateSessionId(execution.id, null);
    expect(nodeExecutionRepo.getById(execution.id)?.agentSessionId).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const delivery = eventStore.listDeliveries(events[10]!.id)[0]!;
    expect(delivery.state).toBe('pending');
    expect(delivery.failureReason).toBe('deliveryMode:defer; digest requeued after session loss');
    await runtime.stop();
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    await runtime.rehydrateExecutors();
    const rehydratedDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
    expect(rehydratedDelivery.failureReason).toBe(
      'deliveryMode:defer; digest requeued after session loss'
    );
    const queued = runtime as unknown as {
      pendingExternalEventQueue: Map<string, Array<{ deliveryMode: string }>>;
    };

    expect(
      [...queued.pendingExternalEventQueue.values()].some((items) =>
        items.some((item) => item.deliveryMode === 'defer')
      )
    ).toBe(true);
  });

  test('expires digest items preserved across stop before retry replay', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-digest-expire-stop',
      startedAt: Date.now(),
    });
    tam.alive.add('session-digest-expire-stop');
    const events = Array.from({ length: 11 }, (_, index) =>
      makeEvent({
        id: `evt-digest-expire-stop-${index}`,
        dedupeKey: `dedupe-digest-expire-stop-${index}`,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    await runtime.stop();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 300_001;
    try {
      runtime.start();
    } finally {
      Date.now = originalNow;
    }

    expect(injected.some((item) => item.message.includes(events[10]!.id))).toBe(false);
    const delivery = eventStore.listDeliveries(events[10]!.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('ttl_expired');
  });

  test('preserves large digest backlog during stop without pending queue overflow', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-digest-large-stop',
      startedAt: Date.now(),
    });
    tam.alive.add('session-digest-large-stop');
    const events = Array.from({ length: 61 }, (_, index) =>
      makeEvent({
        id: `evt-digest-large-stop-${index}`,
        dedupeKey: `dedupe-digest-large-stop-${index}`,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }
    await runtime.stop();

    for (const event of events.slice(10)) {
      const delivery = eventStore.listDeliveries(event.id)[0]!;
      expect(delivery.state).toBe('pending');
      expect(delivery.failureReason).not.toBe('pending_node_queue_overflow');
    }
  });

  test('preserves original queue age when replaying queued digest backlog', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-digest-backlog-age',
      startedAt: Date.now(),
    });
    await runtime.stop();
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async () => ({
      ok: false,
      error: 'temporary digest backlog failure',
    }));
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    const originalNow = Date.now;
    const originalCreatedAt = originalNow() - 299_999;
    Date.now = () => originalCreatedAt;
    const events = Array.from({ length: 11 }, (_, index) =>
      makeEvent({
        id: `evt-digest-backlog-age-${index}`,
        dedupeKey: `dedupe-digest-backlog-age-${index}`,
      })
    );
    for (const event of events) {
      await eventService.publish(event);
    }
    Date.now = () => originalCreatedAt + 300_000;
    try {
      runtime.flushPendingNodeQueue({
        workflowRunId: run.id,
        taskId: task.id,
        nodeId: 'code',
        agentName: 'coder',
        sessionId: 'session-digest-backlog-age',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      Date.now = originalNow;
    }

    const queuedAfterFailure = runtime as unknown as {
      pendingExternalEventQueue: Map<string, Array<{ createdAt: number }>>;
    };
    expect(
      [...queuedAfterFailure.pendingExternalEventQueue.values()]
        .flat()
        .some((item) => item.createdAt === originalCreatedAt)
    ).toBe(true);
    const digestDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
    expect(digestDelivery.state).toBe('pending');
    expect(digestDelivery.failureReason).toBe(
      'deliveryMode:defer; digest; temporary digest backlog failure'
    );
    Date.now = () => originalCreatedAt + 300_001;
    try {
      runtime.flushPendingNodeQueue({
        workflowRunId: run.id,
        taskId: task.id,
        nodeId: 'code',
        agentName: 'coder',
        sessionId: 'session-digest-backlog-age',
      });
    } finally {
      Date.now = originalNow;
    }
    const expiredDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
    expect(expiredDelivery.state).toBe('failed');
    expect(expiredDelivery.failureReason).toBe('ttl_expired');
  });

  test('preserves original queue age across transient retry requeues', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-retry-age',
      startedAt: Date.now(),
    });
    tam.alive.add('session-retry-age');
    await runtime.stop();
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async () => ({
      ok: false,
      error: 'temporary retry age failure',
    }));
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    const event = makeEvent({ id: 'evt-retry-age', dedupeKey: 'dedupe-retry-age' });

    await eventService.publish(event);
    const queued = runtime as unknown as {
      pendingExternalEventQueue: Map<string, Array<{ createdAt: number }>>;
    };
    const firstQueued = [...queued.pendingExternalEventQueue.values()][0]![0]!;
    const originalCreatedAt = firstQueued.createdAt;
    const originalNow = Date.now;
    Date.now = () => originalCreatedAt + 300_001;
    try {
      runtime.flushPendingNodeQueue({
        workflowRunId: run.id,
        taskId: task.id,
        nodeId: 'code',
        agentName: 'coder',
        sessionId: 'session-retry-age',
      });
    } finally {
      Date.now = originalNow;
    }

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('ttl_expired');
  });

  test('drops delivery that expires before scheduled retry dispatch', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-retry-dispatch-ttl',
      startedAt: Date.now(),
    });
    tam.alive.add('session-retry-dispatch-ttl');
    await runtime.stop();
    let attempt = 0;
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      attempt += 1;
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return attempt === 1
        ? { ok: false, error: 'temporary retry dispatch failure' }
        : { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    const event = makeEvent({
      id: 'evt-retry-dispatch-ttl',
      dedupeKey: 'dedupe-retry-dispatch-ttl',
    });
    await eventService.publish(event);
    const queued = runtime as unknown as {
      pendingExternalEventQueue: Map<string, Array<{ createdAt: number }>>;
    };
    const originalCreatedAt = [...queued.pendingExternalEventQueue.values()][0]![0]!.createdAt;
    const originalNow = Date.now;
    Date.now = () => originalCreatedAt + 300_001;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    } finally {
      Date.now = originalNow;
    }

    expect(injected).toHaveLength(1);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('ttl_expired');
  });

  test('enforces pending queue overflow cap and fails oldest delivery', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const events = Array.from({ length: 51 }, (_, index) =>
      makeEvent({
        id: `evt-overflow-${index}`,
        dedupeKey: `dedupe-overflow-${index}`,
      })
    );

    for (const event of events) {
      await eventService.publish(event);
    }

    const oldestDelivery = eventStore.listDeliveries(events[0]!.id)[0]!;
    expect(oldestDelivery.state).toBe('failed');
    expect(oldestDelivery.failureReason).toBe('pending_node_queue_overflow');

    // The worker activates — spawn assigns its agentSessionId to the node
    // execution before the activation flush drains the pending queue.
    nodeExecutionRepo.update(nodeExecutionRepo.listByNode(run.id, 'code')[0]!.id, {
      status: 'in_progress',
      agentSessionId: 'session-overflow',
      startedAt: Date.now(),
      completedAt: null,
    });
    tam.alive.add('session-overflow');
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-overflow',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(11);
    expect(injected.slice(0, 10).map((item) => JSON.parse(item.message).eventId)).toEqual(
      events.slice(1, 11).map((event) => event.id)
    );
    expect(injected[10]!.message).toContain(
      '40 events received for topics: github/lsm/neokai/pull_request/42.review_submitted'
    );
    expect(injected.some((item) => item.message.includes(events[0]!.id))).toBe(false);
    // The digest must list EVERY coalesced id (no cap/truncation) so every
    // delivered event remains fetchable via get_external_event(eventId).
    // events[1..40] are in the digest; verify an id well past the old 10-cap.
    expect(injected[10]!.message).toContain(events[30]!.id);
    expect(injected[10]!.message).toContain(events[40]!.id);
    expect(injected[10]!.message).not.toContain('more)`');
  });

  test('does not activate cancelled target executions', async () => {
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'cancelled',
      agentSessionId: 'session-cancelled',
      completedAt: Date.now(),
    });
    tam.alive.add('session-cancelled');

    const event = makeEvent();
    await eventService.publish(event);

    expect(tam.activationCalls).toHaveLength(0);
    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    expect(delivery.failureReason).toBe('deliveryMode:defer; node_execution_not_active');
    expect(eventStore.listPendingDeliveries()).toContainEqual(delivery);
    expect(eventStore.getById(event.id)?.state).toBe('published');
  });

  test('activates idle subscribed targets instead of failing node_execution_not_active', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-activated-event' }];
    tam.onActivate = () => {
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session-activated-event',
        completedAt: null,
      });
    };

    const event = makeEvent();
    await eventService.publish(event);

    expect(tam.activationCalls).toEqual([
      {
        taskId: task.id,
        workflowRunId: run.id,
        agentName: 'coder',
        options: { workflowNodeId: 'code' },
      },
    ]);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-activated-event');
    expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('delivered');
    expect(delivery.failureReason).toBeNull();
  });

  test('queues external events when activation starts without a ready session', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-starting-event' }];

    const event = makeEvent();
    await eventService.publish(event);

    expect(tam.activationCalls).toEqual([
      {
        taskId: task.id,
        workflowRunId: run.id,
        agentName: 'coder',
        options: { workflowNodeId: 'code' },
      },
    ]);
    expect(injected).toHaveLength(0);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-starting-event',
      completedAt: null,
    });
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-starting-event',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-starting-event');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('activation failures schedule bounded retries and terminalize', async () => {
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationError = new Error('spawn failed');

    const event = makeEvent();
    await eventService.publish(event);
    // Defer-encoded prefix so a daemon restart before the retry succeeds
    // reconstructs 'defer' (a bare activation_failed reason recovers as
    // 'immediate').
    expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
      'deliveryMode:defer; activation_failed; spawn failed'
    );

    await new Promise((resolve) => setTimeout(resolve, 5_600));

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('deliveryMode:defer; activation_failed; spawn failed');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
    expect(tam.activationCalls.length).toBeGreaterThanOrEqual(5);
    expect(tam.activationCalls.length).toBeLessThanOrEqual(6);
  });

  test('paused spaces keep external events queued without terminal retry burn', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);

    const event = makeEvent();
    await eventService.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 5_600));

    expect(tam.activationCalls).toHaveLength(0);
    const pending = eventStore.listDeliveries(event.id)[0]!;
    expect(pending.state).toBe('pending');
    expect(pending.failureReason).toBe('deliveryMode:defer; node_execution_not_active');

    db.prepare(`UPDATE spaces SET paused = 0 WHERE id = ?`).run(SPACE_ID);
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-after-pause',
      completedAt: null,
    });
    tam.alive.add('session-after-pause');
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-after-pause',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-after-pause');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('activation retry does not double-deliver after pending flush wins', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-race' }];

    const event = makeEvent();
    await eventService.publish(event);
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-race',
      completedAt: null,
    });
    tam.alive.add('session-race');
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-race',
    });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-race');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('delivers immediately for idle executions with retained live sessions', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: 'session-idle-stale',
      completedAt: Date.now(),
    });
    tam.alive.add('session-idle-stale');

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-idle-stale');
    // Delivered promptly (the inject layer delivers defer-mode input now when
    // idle); the runtime still always requests 'defer' — never mid-work.
    expect(injected[0]!.deliveryMode).toBe('defer');
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('delivered');
    expect(eventStore.listPendingDeliveries()).not.toContainEqual(delivery);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('flushes persisted pending deliveries when an idle worker activates', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });

    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-reactivated',
      completedAt: null,
    });
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-reactivated',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-reactivated');
    expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('flushes persisted pending deliveries in chronological order', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });

    const later = makeEvent({
      id: 'evt-later-pending-flush',
      dedupeKey: 'dedupe-later-pending-flush',
      occurredAt: 1_700_000_000_200,
      ingestedAt: 1_700_000_001_200,
    });
    const earlier = makeEvent({
      id: 'evt-earlier-pending-flush',
      dedupeKey: 'dedupe-earlier-pending-flush',
      occurredAt: 1_700_000_000_100,
      ingestedAt: 1_700_000_001_100,
    });
    await eventService.publish(later);
    await eventService.publish(earlier);
    const laterDelivery = eventStore.listDeliveries(later.id)[0]!;
    const earlierDelivery = eventStore.listDeliveries(earlier.id)[0]!;
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      Date.now() - 200,
      later.id
    );
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      Date.now() - 300,
      earlier.id
    );
    expect(laterDelivery.state).toBe('pending');
    expect(earlierDelivery.state).toBe('pending');

    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-reactivated-order',
      completedAt: null,
    });
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-reactivated-order',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected.map((item) => JSON.parse(item.message).eventId)).toEqual([
      earlier.id,
      later.id,
    ]);
    expect(eventStore.listDeliveries(earlier.id)[0]!.state).toBe('delivered');
    expect(eventStore.listDeliveries(later.id)[0]!.state).toBe('delivered');
  });

  test('concurrent flushPendingNodeQueue calls do not double-dispatch persisted deliveries', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    // Node idle with no live session → every event persists as a pending
    // delivery in the DB (failureReason set) waiting for an activation flush.
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });

    // Publish more events than the per-minute rate limit (default 10) so the
    // flush dispatch overflows into the rate-limit digest path, where the
    // concurrent-flush race lives (the digest timer defers the in-flight claim).
    const events = Array.from({ length: 12 }, (_, index) =>
      makeEvent({
        id: `evt-concurrent-flush-${index}`,
        dedupeKey: `dedupe-concurrent-flush-${index}`,
      })
    );
    for (const event of events) {
      await eventService.publish(event);
    }
    expect(eventStore.listPendingDeliveries()).toHaveLength(12);

    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-concurrent-flush',
      completedAt: null,
    });
    tam.alive.add('session-concurrent-flush');

    const flushTarget = {
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-concurrent-flush',
    };
    // Two back-to-back flush calls before the digest timer (setTimeout 0)
    // fires. The second flush re-reads the same DB-persisted pending rows and
    // must NOT re-select the deliveries already claimed by the first flush.
    runtime.flushPendingNodeQueue(flushTarget);
    runtime.flushPendingNodeQueue(flushTarget);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // 10 immediate injections + 1 digest injection.
    const immediateInjections = injected.filter(
      (item) => !item.message.includes('events received')
    );
    const digestInjections = injected.filter((item) => item.message.includes('events received'));
    expect(immediateInjections).toHaveLength(10);
    expect(digestInjections).toHaveLength(1);
    // The digest must cover exactly the 2 overflowed events — not 4 (which
    // would indicate the second flush re-dispatched the same deliveries).
    expect(digestInjections[0]!.message).toContain('2 events received');
    // Every delivery is delivered exactly once.
    for (const event of events) {
      expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    }
  });

  test('flushes DB-persisted pending deliveries even when in-memory queue is non-empty', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;

    // Event A: arrives while node is idle → persisted as pending in DB only
    // (not added to in-memory queue).
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    const idleEvent = makeEvent({
      id: 'evt-idle-split',
      dedupeKey: 'dedupe-idle-split',
    });
    await eventService.publish(idleEvent);
    expect(eventStore.listDeliveries(idleEvent.id)[0]!.state).toBe('pending');
    expect(eventStore.listDeliveries(idleEvent.id)[0]!.failureReason).toBe(
      'deliveryMode:defer; node_execution_not_active'
    );

    // Simulate a separate in-memory queued delivery (from a transient failure
    // while the node was active) by manually inserting one into the pending
    // queue. This delivery has a DIFFERENT delivery key from the idle event.
    const liveEvent = makeEvent({
      id: 'evt-live-split',
      dedupeKey: 'dedupe-live-split',
    });
    const liveDeliveryKey = `live-split-${liveEvent.id}`;
    eventStore.store(liveEvent);
    eventStore.registerExpectedDelivery(liveEvent.id, liveDeliveryKey, {
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
    });
    const livePayload = {
      eventId: liveEvent.id,
      source: 'github',
      topic: liveEvent.topic,
      dedupeKey: liveEvent.dedupeKey,
      summary: liveEvent.summary,
      payload: liveEvent.payload,
      occurredAt: liveEvent.occurredAt,
      ingestedAt: liveEvent.ingestedAt,
      spaceId: liveEvent.spaceId,
    };
    // Directly inject into the in-memory pending queue.
    const runtimeInternal = runtime as unknown as {
      pendingExternalEventQueue: Map<
        string,
        Array<{
          event: typeof livePayload;
          deliveryKey: string;
          deliveryMode: string;
          createdAt: number;
        }>
      >;
      buildQueueKey: (target: unknown) => string;
    };
    const queueKey = runtimeInternal.buildQueueKey({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
    });
    runtimeInternal.pendingExternalEventQueue.set(queueKey, [
      {
        event: livePayload,
        deliveryKey: liveDeliveryKey,
        deliveryMode: 'defer',
        createdAt: Date.now(),
      },
    ]);

    // On activation flush, BOTH the in-memory item and the DB-persisted item
    // should be delivered — the DB-persisted one must not be skipped.
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-idle-split',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const idleDeliveryAfter = eventStore.listDeliveries(idleEvent.id)[0]!;
    expect(idleDeliveryAfter.state).toBe('delivered');
    expect(eventStore.getById(idleEvent.id)?.state).toBe('delivered');
  });

  test('preserves chronological order across in-memory and DB-persisted sources', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;

    // Event A: older, persisted as pending while node is idle.
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    const olderEvent = makeEvent({
      id: 'evt-older-cross-source',
      dedupeKey: 'dedupe-older-cross',
    });
    await eventService.publish(olderEvent);
    expect(eventStore.listDeliveries(olderEvent.id)[0]!.state).toBe('pending');

    // Event B: newer, manually injected into the in-memory queue (simulates
    // a transient delivery failure while the node was active).
    const newerEvent = makeEvent({
      id: 'evt-newer-cross-source',
      dedupeKey: 'dedupe-newer-cross',
    });
    const newerKey = `newer-cross-${newerEvent.id}`;
    eventStore.store(newerEvent);
    eventStore.registerExpectedDelivery(newerEvent.id, newerKey, {
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
    });
    const newerPayload = {
      eventId: newerEvent.id,
      source: 'github',
      topic: newerEvent.topic,
      dedupeKey: newerEvent.dedupeKey,
      summary: newerEvent.summary,
      payload: newerEvent.payload,
      occurredAt: newerEvent.occurredAt,
      ingestedAt: newerEvent.ingestedAt,
      spaceId: newerEvent.spaceId,
    };
    const runtimeInternal = runtime as unknown as {
      pendingExternalEventQueue: Map<string, Array<Record<string, unknown>>>;
      buildQueueKey: (target: unknown) => string;
    };
    const queueKey = runtimeInternal.buildQueueKey({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
    });
    // Set older createdAt for the in-memory item to verify it's NOT dispatched
    // before the DB item — both have different createdAt values.
    runtimeInternal.pendingExternalEventQueue.set(queueKey, [
      {
        event: newerPayload,
        deliveryKey: newerKey,
        deliveryMode: 'defer',
        createdAt: Date.now(), // newer than the DB-persisted event
      },
    ]);

    // DB event has an older createdAt via event record.
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      Date.now() - 5000,
      olderEvent.id
    );

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-order-test',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    // The DB-persisted older event should be delivered before the newer
    // in-memory event despite the in-memory queue being processed first
    // in the code.
    expect(injected.map((item) => JSON.parse(item.message).eventId)).toEqual([
      olderEvent.id,
      newerEvent.id,
    ]);
  });

  test('preserves original TTL when DB-persisted delivery fails on activation', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;

    // Simulate a failing command bus for the activation dispatch.
    const failingCommandBus = createInternalCommandBus();
    failingCommandBus.register('agent.message.inject', async () => ({
      ok: false,
      error: 'activation dispatch failure',
    }));
    const runtimeWithFailure = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: failingCommandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtimeWithFailure.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    // Event arrives while node is idle → persisted as pending.
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    const event = makeEvent({
      id: 'evt-ttl-preserved',
      dedupeKey: 'dedupe-ttl-preserved',
    });
    await eventService.publish(event);
    // Set the event's created_at to near the TTL boundary.
    const oldCreatedAt = Date.now() - 299_000; // just under 5-minute TTL
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      oldCreatedAt,
      event.id
    );
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    runtimeWithFailure.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-ttl-test',
    });

    // Wait for the async dispatch to fail and the retry to be queued.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    // The retry queue should preserve the original createdAt, not reset to now.
    const retryQueued = runtimeWithFailure as unknown as {
      pendingExternalEventQueue: Map<string, Array<{ createdAt: number }>>;
    };
    const queuedItems = [...retryQueued.pendingExternalEventQueue.values()].flat();
    expect(queuedItems.some((item) => item.createdAt === oldCreatedAt)).toBe(true);
  });

  test('drops persisted pending delivery whose event predates TTL even when the delivery row was just registered (event-age TTL anchor)', async () => {
    // Regression guard for the TTL anchor decision (task #667): the TTL for a
    // DB-persisted pending delivery is measured from the EVENT's
    // creation/ingestion time, NOT the delivery row's registration time.
    // A delivery registered "now" for an already-stale event must still
    // expire — otherwise delayed registration (backlog replay, a subscription
    // added late, or a daemon-restart requeue) would resurrect stale events.
    // If the anchor were ever switched to registration age, this test would
    // fail (the delivery would be delivered instead of expired).
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    // Idle execution → delivery is persisted as pending (not in-memory queue).
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });

    const event = makeEvent({
      id: 'evt-delayed-registration',
      dedupeKey: 'dedupe-delayed-registration',
    });
    await eventService.publish(event);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    // The delivery row was registered moments ago (updated_at ≈ now).
    expect(Date.now() - delivery.updatedAt).toBeLessThan(5_000);

    // Backdate only the EVENT's created_at past the TTL window, leaving the
    // delivery registration time recent. This is the discriminator: under
    // event-age TTL this must expire; under registration-age TTL it would
    // still be deliverable.
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      Date.now() - 301_000, // just over the 5-minute EXTERNAL_EVENT_QUEUE_TTL_MS
      event.id
    );

    // Reactivate the worker so the activation flush attempts delivery.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-delayed-registration',
      completedAt: null,
    });
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-delayed-registration',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected).toHaveLength(0);
    const finalDelivery = eventStore.listDeliveries(event.id)[0]!;
    expect(finalDelivery.state).toBe('failed');
    expect(finalDelivery.failureReason).toBe('ttl_expired');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  // --- null-failureReason pending delivery invariant -----------------------
  //
  // A `pending` row whose `failureReason` is null is, by contract, still owned
  // by its original in-process dispatch path (the in-memory pending queue, an
  // in-flight dispatch, or a pending rate-limit digest). The activation flush
  // intentionally skips such rows so it never duplicates a delivery. The
  // counterpart to that skip is crash recovery: rows left `pending`+null by an
  // interruption are re-queued by requeuePersistedPendingDeliveries on the next
  // rehydrate, so the skip can never strand them permanently. These two tests
  // pin both halves of that invariant.

  test('does not re-dispatch a pending delivery with null failureReason during activation flush', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;

    // Persist a pending+null delivery row directly, simulating a row owned by
    // an in-process dispatch path that tracks it in memory (in-flight or
    // digest-pending) rather than via the failureReason column. The activation
    // flush must leave it untouched so its owner path delivers it exactly once.
    const event = makeEvent({ id: 'evt-null-failure-skip', dedupeKey: 'dedupe-null-failure-skip' });
    eventStore.store(event);
    const deliveryKey = JSON.stringify([
      'github',
      event.dedupeKey,
      task.id,
      'code',
      'coder',
      run.id,
    ]);
    eventStore.registerExpectedDelivery(event.id, deliveryKey, {
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
    });
    expect(eventStore.getDelivery(event.id, deliveryKey)!.state).toBe('pending');
    expect(eventStore.getDelivery(event.id, deliveryKey)!.failureReason).toBeNull();

    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-null-failure-skip',
      completedAt: null,
    });
    tam.alive.add('session-null-failure-skip');
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-null-failure-skip',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Not dispatched by the flush, and the row is unchanged — the owner path
    // remains responsible for it.
    expect(injected).toHaveLength(0);
    const delivery = eventStore.getDelivery(event.id, deliveryKey)!;
    expect(delivery.state).toBe('pending');
    expect(delivery.failureReason).toBeNull();
    expect(eventStore.listPendingDeliveries()).toContainEqual(delivery);
  });

  test('recovers a pending delivery with null failureReason after an interruption via requeue', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;

    // Persist a pending+null delivery row, as would be left by an in-flight or
    // digest-pending dispatch that was interrupted by a crash before stop()
    // could stamp a failureReason.
    const event = makeEvent({
      id: 'evt-null-failure-requeue',
      dedupeKey: 'dedupe-null-failure-requeue',
    });
    eventStore.store(event);
    const deliveryKey = JSON.stringify([
      'github',
      event.dedupeKey,
      task.id,
      'code',
      'coder',
      run.id,
    ]);
    eventStore.registerExpectedDelivery(event.id, deliveryKey, {
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
    });
    expect(eventStore.getDelivery(event.id, deliveryKey)!.failureReason).toBeNull();

    // Simulate a crash + restart: tear down the runtime and rebuild it over the
    // same DB, then rehydrate (which runs requeuePersistedPendingDeliveries).
    await runtime.stop();
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    await runtime.rehydrateExecutors();

    // Activate the node — requeue re-queued the null-failure row into the
    // in-memory pending queue, so the activation flush now drains and delivers it.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-null-failure-requeue',
      completedAt: null,
    });
    tam.alive.add('session-null-failure-requeue');
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-null-failure-requeue',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected).toHaveLength(1);
    expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
    expect(eventStore.getDelivery(event.id, deliveryKey)!.state).toBe('delivered');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('fails delivery when inactive target task is already done', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: 'session-done-task',
      completedAt: Date.now(),
    });
    taskRepo.updateTask(task.id, { status: 'done' });

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('target_task_terminal');
    expect(eventStore.listPendingDeliveries()).not.toContainEqual(delivery);
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('fails delivery when pending target execution belongs to a done task', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    expect(execution.status).toBe('pending');
    taskRepo.updateTask(task.id, { status: 'done' });

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('target_task_terminal');
    expect(eventStore.listPendingDeliveries()).not.toContainEqual(delivery);
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('does not reactivate a done task for a non-failure status event (status_pending/success)', async () => {
    const STATUS_PENDING_TOPIC = 'github/lsm/neokai/pull_request/42.status_pending';
    const { run, task } = await startRunWithSubscription(STATUS_PENDING_TOPIC);
    taskRepo.updateTask(task.id, { status: 'done', completedAt: Date.now() });
    workflowRunRepo.updateRun(run.id, { status: 'done', completedAt: Date.now() });

    const event = makeEvent({ topic: STATUS_PENDING_TOPIC });
    await eventService.publish(event);

    // pending/success are not failures — they must not reopen a done task.
    expect(taskRepo.getTask(task.id)?.status).toBe('done');
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('target_task_terminal');
  });

  test('does not reactivate a done task for a non-check-failed PR event but keeps the subscription', async () => {
    const REVIEW_TOPIC = 'github/lsm/neokai/pull_request/42.review_submitted';
    const { workflow, run, task } = await startRunWithSubscription(REVIEW_TOPIC);
    taskRepo.updateTask(task.id, { status: 'done', completedAt: Date.now() });
    workflowRunRepo.updateRun(run.id, { status: 'done', completedAt: Date.now() });

    const event = makeEvent({ topic: REVIEW_TOPIC });
    await eventService.publish(event);

    // A non-reactivating event does not reopen the task...
    expect(taskRepo.getTask(task.id)?.status).toBe('done');
    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('target_task_terminal');
    // ...but the subscription survives so a later check_failed can reactivate.
    expect(
      (
        runtime as unknown as {
          lookupSubscriptionTargets(topic: string): Array<{ workflowRunId?: string }>;
        }
      )
        .lookupSubscriptionTargets(REVIEW_TOPIC)
        .some((t) => t.workflowRunId === run.id)
    ).toBe(true);
  });

  test('refuses a queued event flushed after the task goes done (no injection past the gate)', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    // Event queues as a pending delivery while there is no live session.
    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    // The task completes (and a live session appears) before the flush runs.
    taskRepo.updateTask(task.id, { status: 'done', completedAt: Date.now() });
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-after-done',
      startedAt: Date.now(),
      completedAt: null,
    });
    tam.alive.add('session-after-done');
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-after-done',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The flush applies the task-lifecycle decision: a done task refuses a
    // non-reactivating event instead of injecting it past the gate.
    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('target_task_terminal');
  });

  test('recover re-registers workflow static interests after they were cleared', async () => {
    const STATIC_TOPIC = 'github/lsm/neokai/pull_request/42.merged';
    const { workflow, run, task } = await startRunWithSubscription(STATIC_TOPIC, 'code', {
      staticInterest: true,
    });
    // startWorkflowRun caches the executor; register the workflow's static
    // interests explicitly (as rehydrate would on a cold start).
    runtime.registerRunInterests(run.id, task.id, workflow.nodes);
    const lookup = (
      runtime as unknown as {
        lookupSubscriptionTargets(topic: string): Array<{ workflowRunId?: string }>;
      }
    ).lookupSubscriptionTargets.bind(runtime);
    expect(lookup(STATIC_TOPIC).some((t) => t.workflowRunId === run.id)).toBe(true);

    // A task cancellation clears all run interests (task-owned cleanup).
    runtime.clearRunInterests(run.id);
    expect(lookup(STATIC_TOPIC).some((t) => t.workflowRunId === run.id)).toBe(false);

    // Recovering the task (e.g. a retry) must re-register static interests from
    // the workflow definition even when the executor is already cached.
    await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');
    expect(lookup(STATIC_TOPIC).some((t) => t.workflowRunId === run.id)).toBe(true);
  });

  test('cancelWorkflowRun cancels a review task waiting at a gate', async () => {
    const { run, task } = await startRunWithSubscription();
    // The canonical task is waiting at a human-approval gate.
    taskRepo.updateTask(task.id, { status: 'review' });

    await runtime.cancelWorkflowRun(SPACE_ID, run.id);

    // The review task must be cancelled (not left live) so later events cannot
    // reach the obsolete workflow after the run is switched/cancelled.
    expect(taskRepo.getTask(task.id)?.status).toBe('cancelled');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('cancelled');
  });

  test('terminalizes mixed-outcome events after the final delivery succeeds', async () => {
    const event = makeEvent({ topic: 'github/owner/repo/pull_request/42.review_submitted' });
    eventStore.store(event);
    const failedDeliveryKey = JSON.stringify([
      'github',
      event.dedupeKey,
      'task-failed',
      'node-failed',
      'coder',
      'run-failed',
    ]);
    eventStore.registerExpectedDelivery(event.id, failedDeliveryKey, {
      workflowRunId: 'run-failed',
      taskId: 'task-failed',
      nodeId: 'node-failed',
      agentName: 'coder',
    });
    eventStore.markDeliveryFailed(event.id, failedDeliveryKey, {
      terminal: true,
      reason: 'simulated_prior_failure',
    });
    expect(eventStore.getById(event.id)?.state).toBe('published');

    const workflow = createWorkflow('review');
    const { run, tasks: reviewTasks } = await runtime.startWorkflowRun(
      SPACE_ID,
      workflow.id,
      'Run'
    );
    runtime.registerSubscription(run.id, reviewTasks[0]!.id, 'review', 'coder', event.topic);
    const execution = nodeExecutionRepo.listByNode(run.id, 'review')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-mixed',
      startedAt: Date.now(),
    });
    tam.alive.add('session-mixed');

    await eventService.publish(makeEvent({ id: 'evt-mixed-retry', dedupeKey: event.dedupeKey }));

    const deliveries = eventStore.listDeliveries(event.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.some((delivery) => delivery.state === 'delivered')).toBe(true);
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('retains unmatched events after stop/start until the TTL', async () => {
    await startRunWithSubscription();
    await runtime.executeTick();
    await runtime.stop();
    runtime.start();

    const event = makeEvent({ topic: 'github/lsm/neokai/pull_request/42.comment_created' });
    await eventService.publish(event);

    expect(eventStore.getById(event.id)?.state).toBe('published');
  });

  test('redispatches published events without deliveries after rehydrate', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-redispatch-stranded',
      startedAt: Date.now(),
    });
    tam.alive.add('session-redispatch-stranded');
    await runtime.stop();
    eventStore.store(makeEvent({ id: 'evt-stranded-without-deliveries' }));
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    await runtime.executeTick();

    expect(eventStore.listDeliveries('evt-stranded-without-deliveries')).toHaveLength(1);
    const delivery = eventStore.listDeliveries('evt-stranded-without-deliveries')[0]!;
    expect(delivery.state).toBe('delivered');
    expect(delivery.taskId).toBe(task.id);
    expect(eventStore.getById('evt-stranded-without-deliveries')?.state).toBe('delivered');
  });

  test('marks stranded published events without matches ignored after rehydrate opens delivery', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-redispatch-unmatched',
      startedAt: Date.now(),
    });
    await runtime.stop();
    eventStore.store(
      makeEvent({
        id: 'evt-stranded-without-matches',
        topic: 'github/lsm/neokai/pull_request/42.comment_created',
      })
    );

    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });

    await runtime.executeTick();

    expect(eventStore.listDeliveries('evt-stranded-without-matches')).toHaveLength(0);
    expect(eventStore.getById('evt-stranded-without-matches')?.state).toBe('published');
  });

  test('redispatches events that arrived during stop when runtime restarts', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-stop-start-sweep',
      startedAt: Date.now(),
    });
    tam.alive.add('session-stop-start-sweep');
    await runtime.executeTick();
    await runtime.stop();
    // Event arrives while stopped (subscriber detached, persisted only)
    eventStore.store(makeEvent({ id: 'evt-arrived-while-stopped' }));

    // Restart the same runtime instance (rehydrated=true, interests intact)
    runtime.start();
    // The sweep in start() fires async — wait for microtasks to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(eventStore.listDeliveries('evt-arrived-while-stopped')).toHaveLength(1);
    expect(eventStore.getById('evt-arrived-while-stopped')?.state).toBe('delivered');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-stop-start-sweep');
  });

  test('requeues persisted pending long-horizon deliveries during runtime rehydrate', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-pending-retry',
      spaceId: SPACE_ID,
      handle: 'pending-retry',
      displayName: 'Pending Retry',
    });
    const subscription = repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: DEFAULT_TOPIC,
    });
    const event = makeEvent({ id: 'evt-lh-pending-retry' });
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
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(longHorizonMessages).toHaveLength(1);
    expect(longHorizonMessages[0]!.agentId).toBe(agent.id);
    expect(longHorizonMessages[0]!.idempotencyKey).toBe(deliveryKey);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('marks invalid persisted pending long-horizon deliveries failed during rehydrate', async () => {
    const repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({
      id: 'lh-agent-invalid-pending',
      spaceId: SPACE_ID,
      handle: 'invalid-pending',
      displayName: 'Invalid Pending',
    });
    const subscription = repo.createSubscription({
      spaceId: SPACE_ID,
      agentId: agent.id,
      source: 'github',
      topic: 'space/task.done',
    });
    const event = makeEvent({ id: 'evt-lh-invalid-pending' });
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
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('Topic source "space" does not match source "github"');
    expect(longHorizonMessages).toHaveLength(0);
  });

  test('requeues persisted pending deliveries during runtime rehydrate', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    await runtime.stop();
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    await runtime.rehydrateExecutors();
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-rehydrated-pending',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('terminalizes persisted pending deliveries for terminal tasks during runtime rehydrate', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    taskRepo.updateTask(task.id, { status: 'done' });

    await runtime.stop();
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    await runtime.rehydrateExecutors();

    const rehydratedDelivery = eventStore.listDeliveries(event.id)[0]!;
    expect(rehydratedDelivery.state).toBe('failed');
    // The done task's subscription row is reconciled (purged) during rehydrate,
    // so the requeued pending delivery finds no subscriber and terminalizes
    // with subscription_no_longer_active rather than hanging.
    expect(rehydratedDelivery.failureReason).toBe('subscription_no_longer_active');
    expect(eventStore.listPendingDeliveries()).not.toContainEqual(rehydratedDelivery);
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('refuses delivery when a cancelled run reconciles its task to cancelled', async () => {
    const { run } = await startRunWithSubscription();
    workflowRunRepo.updateRun(run.id, { status: 'cancelled' });
    // The tick reconciles the cancelled run's canonical task to `cancelled`,
    // which is the task-owned tombstone that refuses delivery.
    await runtime.executeTick();
    expect(taskRepo.getTask(taskRepo.listByWorkflowRun(run.id)[0]!.id)?.status).toBe('cancelled');

    const event = makeEvent();
    await eventService.publish(event);

    // The cancelled run's subscription row is purged during the rehydrate that
    // executeTick triggers (cancelled-RUN teardown), so the event has no
    // subscriber and no delivery is created — matching production, where
    // cancelWorkflowRun's clearRunInterests would already have dropped the row.
    expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
    expect(eventStore.getById(event.id)?.state).not.toBe('delivered');
  });

  test('refreshes active run interests when subscriptions are rebuilt', async () => {
    const { workflow, run, task } = await startRunWithSubscription(DEFAULT_TOPIC);
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-updated-interests',
      startedAt: Date.now(),
    });
    tam.alive.add('session-updated-interests');

    // Clear old dynamic interest and register new ones (simulates what a runtime
    // caller would do after a workflow definition change)
    runtime.unregisterSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    runtime.registerRunInterests(run.id, task.id, workflow.nodes);
    runtime.registerSubscription(
      run.id,
      task.id,
      'code',
      'coder',
      'github/*/*/pull_request/*.comment_created'
    );
    await runtime.executeTick();

    const removedInterestEvent = makeEvent({ id: 'evt-removed-interest' });
    await eventService.publish(removedInterestEvent);
    await runtime.executeTick();
    expect(eventStore.getById(removedInterestEvent.id)?.state).toBe('published');
    expect(eventStore.listDeliveries(removedInterestEvent.id)).toHaveLength(0);

    const addedInterestEvent = makeEvent({
      id: 'evt-added-interest',
      topic: 'github/lsm/neokai/pull_request/42.comment_created',
    });
    await eventService.publish(addedInterestEvent);
    expect(eventStore.getById(addedInterestEvent.id)?.state).toBe('delivered');
    expect(eventStore.listDeliveries(addedInterestEvent.id)[0]!.taskId).toBe(task.id);
    expect(injected).toHaveLength(1);
  });

  test('clears stale queued deliveries when run interests are cleared', async () => {
    const { workflow, run, task } = await startRunWithSubscription(DEFAULT_TOPIC);
    const event = makeEvent({ id: 'evt-queued-before-interest-update' });
    await eventService.publish(event);
    const queuedDelivery = eventStore.listDeliveries(event.id)[0]!;
    expect(queuedDelivery.state).toBe('pending');

    // Clear interests with queued delivery cleanup (simulates what a runtime
    // caller would do after a workflow definition change removes interests)
    runtime.registerRunInterests(run.id, task.id, workflow.nodes, {
      clearQueuedDeliveries: true,
    });
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-stale-after-update',
    });

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('run_interests_rebuilt');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('queues events for blocked runs with no active execution path', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: 'session-cancelled',
      completedAt: Date.now(),
    });
    workflowRunRepo.updateRun(run.id, { status: 'blocked', failureReason: 'agentCrash' });
    await runtime.executeTick();

    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );

    const event = makeEvent();
    await eventService.publish(event);

    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
    expect(nodeExecutionRepo.listByWorkflowRun(run.id).map((item) => item.status)).toEqual([
      'idle',
    ]);
    // The task is still active, so a matching event is accepted (no longer
    // ignored) and dispatched to the resolved slot.
    expect(eventStore.listDeliveries(event.id)).toHaveLength(1);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('terminalizes delivery for target node with no queueable execution in multi-node run', async () => {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Workflow ${Math.random()}`,
      description: '',
      nodes: [
        {
          id: 'review',
          name: 'Review',
          agents: [
            {
              agentId: AGENT_ID,
              name: 'reviewer',
            },
          ],
        },
        {
          id: 'code',
          name: 'Code',
          agents: [
            {
              agentId: AGENT_ID,
              name: 'coder',
            },
          ],
        },
      ],
      transitions: [],
      startNodeId: 'review',
      rules: [],
      tags: [],
    });
    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    runtime.registerSubscription(run.id, tasks[0]!.id, 'review', 'reviewer', DEFAULT_TOPIC);
    runtime.registerSubscription(run.id, tasks[0]!.id, 'code', 'coder', DEFAULT_TOPIC);
    // Make the review node execution in_progress (active)
    const reviewExecution = nodeExecutionRepo.listByNode(run.id, 'review')[0]!;
    nodeExecutionRepo.update(reviewExecution.id, {
      status: 'in_progress',
      agentSessionId: 'session-review-active',
      startedAt: Date.now(),
    });
    // Create a cancelled execution for the code node (terminal for that target)
    const codeExecution = nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'code',
      agentName: 'coder',
      status: 'cancelled',
    });
    nodeExecutionRepo.update(codeExecution.id, {
      completedAt: Date.now(),
    });

    const event = makeEvent();
    await eventService.publish(event);

    // The code node should be persisted as pending instead of terminalized.
    const deliveries = eventStore.listDeliveries(event.id);
    expect(deliveries).toHaveLength(2);
    const codeDelivery = deliveries.find((d) => d.nodeId === 'code')!;
    expect(codeDelivery).toBeDefined();
    expect(codeDelivery.state).toBe('pending');
    expect(codeDelivery.failureReason).toBe('deliveryMode:defer; node_execution_not_active');
  });

  test('preserves queued deliveries while re-registering unchanged interests', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);

    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-preserved-reregister',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('retries transient external event injection failures from the pending queue', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-retry',
      startedAt: Date.now(),
    });
    tam.alive.add('session-retry');
    await runtime.stop();
    let failNext = true;
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: 'temporary injection failure' };
      }
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    const event = makeEvent();
    await eventService.publish(event);
    expect(injected).toHaveLength(0);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
    expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
      'deliveryMode:defer; temporary injection failure'
    );

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-retry',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('queues events for waiting_rebind executions instead of failing them terminally', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'waiting_rebind',
      completedAt: null,
    });

    const event = makeEvent();
    await eventService.publish(event);

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    // Defer-encoded reason (non-terminal) so a daemon restart reconstructs
    // 'defer' — a null reason would recover as 'immediate'.
    expect(delivery.failureReason).toBe('deliveryMode:defer; node_execution_pending');

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-waiting-rebind',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-waiting-rebind');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('drains transient retry queue for an in-progress session without respawn', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-retry-drain',
      startedAt: Date.now(),
    });
    tam.alive.add('session-retry-drain');
    await runtime.stop();
    let failNext = true;
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: 'temporary retry drain failure' };
      }
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );

    const event = makeEvent();
    await eventService.publish(event);

    expect(injected).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-retry-drain');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('reschedules queued transient retries across runtime stop and start', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-retry-restart',
      startedAt: Date.now(),
    });
    tam.alive.add('session-retry-restart');
    await runtime.stop();
    let failNext = true;
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: 'temporary restart retry failure' };
      }
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );

    const event = makeEvent();
    await eventService.publish(event);
    await runtime.stop();
    runtime.start();

    expect(injected).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-retry-restart');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: taskRepo.listByWorkflowRun(run.id)[0]!.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-retry-restart',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
  });

  test('suppresses retryable duplicates while a delivery attempt is in flight', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-inflight-dedupe',
      startedAt: Date.now(),
    });
    tam.alive.add('session-inflight-dedupe');
    await runtime.stop();
    let releaseDelivery!: () => void;
    const deliveryStarted = Promise.withResolvers<void>();
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      deliveryStarted.resolve();
      await new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );

    const event = makeEvent({ dedupeKey: 'dedupe-inflight' });
    const firstPublish = eventService.publish(event);
    await deliveryStarted.promise;
    await eventService.publish(
      makeEvent({ id: 'evt-inflight-duplicate', dedupeKey: event.dedupeKey })
    );

    expect(injected).toHaveLength(1);
    releaseDelivery();
    await firstPublish;
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(injected).toHaveLength(1);
  });

  test('does not fire retry timer while the same delivery is in flight', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-retry-inflight',
      startedAt: Date.now(),
    });
    tam.alive.add('session-retry-inflight');
    await runtime.stop();
    let attempts = 0;
    let releaseDelivery!: () => void;
    const duplicateDeliveryStarted = Promise.withResolvers<void>();
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      attempts++;
      if (attempts === 1) return { ok: false, error: 'temporary retry timer failure' };
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      duplicateDeliveryStarted.resolve();
      await new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
      // This test exercises the retry-timer in-flight guard via an immediate
      // duplicate publish; disable the per-delivery cool-down so the duplicate
      // re-dispatches (the cool-down is covered by its own dedicated tests).
      externalEventDeliveryCooldownMs: 0,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );

    const event = makeEvent({ dedupeKey: 'dedupe-retry-inflight' });
    await eventService.publish(event);
    const duplicatePublish = eventService.publish(
      makeEvent({ id: 'evt-retry-inflight-duplicate', dedupeKey: event.dedupeKey })
    );
    await duplicateDeliveryStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(injected).toHaveLength(1);
    expect(attempts).toBe(2);
    releaseDelivery();
    await duplicatePublish;
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('queues downstream events that arrive before subscribed node execution exists', async () => {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Workflow ${Math.random()}`,
      description: '',
      nodes: [
        {
          id: 'code',
          name: 'Code',
          agents: [{ agentId: AGENT_ID, name: 'coder' }],
        },
        {
          id: 'review',
          name: 'Review',
          agents: [
            {
              agentId: AGENT_ID,
              name: 'reviewer',
            },
          ],
        },
      ],
      transitions: [],
      startNodeId: 'code',
      endNodeId: 'review',
      rules: [],
      tags: [],
    });
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const task = taskRepo.listByWorkflowRun(run.id)[0]!;
    runtime.registerSubscription(run.id, task.id, 'review', 'reviewer', DEFAULT_TOPIC);

    await runtime.executeTick();
    const earlyEvent = makeEvent({ id: 'evt-downstream-before-activation' });
    await eventService.publish(earlyEvent);
    expect(eventStore.getById(earlyEvent.id)?.state).toBe('published');
    const earlyDelivery = eventStore.listDeliveries(earlyEvent.id)[0]!;
    expect(earlyDelivery.state).toBe('pending');
    expect(earlyDelivery.nodeId).toBe('review');

    nodeExecutionRepo.create({
      workflowRunId: run.id,
      workflowNodeId: 'review',
      agentName: 'reviewer',
      agentId: AGENT_ID,
      status: 'pending',
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'review',
      agentName: 'reviewer',
      sessionId: 'session-downstream-activated',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eventStore.getById(earlyEvent.id)?.state).toBe('delivered');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-downstream-activated');
  });

  test('registers all matching deliveries before successful delivery terminalizes source event', async () => {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Workflow ${Math.random()}`,
      description: '',
      nodes: [
        {
          id: 'code',
          name: 'Code',
          agents: [
            {
              agentId: AGENT_ID,
              name: 'coder',
            },
          ],
        },
        {
          id: 'review',
          name: 'Review',
          agents: [
            {
              agentId: AGENT_ID,
              name: 'reviewer',
            },
          ],
        },
      ],
      transitions: [],
      startNodeId: 'code',
      endNodeId: 'review',
      rules: [],
      tags: [],
    });
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const task = taskRepo.listByWorkflowRun(run.id)[0]!;
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    runtime.registerSubscription(run.id, task.id, 'review', 'reviewer', DEFAULT_TOPIC);
    const reviewExecution = nodeExecutionRepo.create({
      workflowRunId: run.id,
      workflowNodeId: 'review',
      agentName: 'reviewer',
      agentId: AGENT_ID,
      status: 'pending',
    });
    const codeExecution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(codeExecution.id, {
      status: 'in_progress',
      agentSessionId: 'session-multi-success',
      startedAt: Date.now(),
    });
    tam.alive.add('session-multi-success');
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    nodeExecutionRepo.update(reviewExecution.id, {
      status: 'idle',
      agentSessionId: 'session-review-idle',
      completedAt: Date.now(),
    });
    tam.alive.add('session-review-idle');
    workflowRunRepo.updateRun(run.id, { status: 'blocked' });

    const event = makeEvent();
    await eventService.publish(event);

    const deliveries = eventStore.listDeliveries(event.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => delivery.state === 'delivered')).toBe(true);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('keeps retrying a transient dispatch failure when only the run is terminal', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-retry-terminal-check',
      startedAt: Date.now(),
    });
    await runtime.stop();
    const commandBus = createInternalCommandBus();
    let injectAttempts = 0;
    commandBus.register('agent.message.inject', async () => {
      injectAttempts++;
      return { ok: false, error: 'simulated transient failure' };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );
    runtime.start();
    await runtime.executeTick();

    // Publish event → first dispatch attempt will fail transiently
    const event = makeEvent();
    await eventService.publish(event);
    expect(injectAttempts).toBe(1);

    // Cancel the run before the retry timer fires. The task is still active, so
    // run status no longer terminalizes the delivery — it stays pending.
    workflowRunRepo.updateRun(run.id, { status: 'cancelled' });

    // Trigger the retry by waiting for the retry timer
    await new Promise((resolve) => setTimeout(resolve, 250));

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    expect(injected).toHaveLength(0);
  });

  test('terminalizes retry when a done-run review task becomes terminal', async () => {
    const { run, task } = await startRunWithSubscription();
    taskRepo.updateTask(task.id, { status: 'review' });
    workflowRunRepo.updateRun(run.id, { status: 'done' });
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: 'session-retry-task-terminal-check',
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    await runtime.stop();
    const commandBus = createInternalCommandBus();
    let injectAttempts = 0;
    commandBus.register('agent.message.inject', async () => {
      injectAttempts++;
      return { ok: false, error: 'simulated transient failure' };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    runtime.start();
    await runtime.executeTick();

    const event = makeEvent({ id: 'evt-retry-task-terminal-check' });
    await eventService.publish(event);
    expect(injectAttempts).toBe(1);

    taskRepo.updateTask(task.id, { status: 'done' });

    await new Promise((resolve) => setTimeout(resolve, 1250));

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('target_task_terminal');
    expect(injectAttempts).toBe(1);
  });

  test('keeps retrying when the run becomes blocked without active execution during a transient retry', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-blocked-retry-check',
      startedAt: Date.now(),
    });
    await runtime.stop();
    const commandBus = createInternalCommandBus();
    let injectAttempts = 0;
    commandBus.register('agent.message.inject', async () => {
      injectAttempts++;
      return { ok: false, error: 'simulated transient failure' };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.executeTick();

    // Publish event → first dispatch attempt will fail transiently
    const event = makeEvent();
    await eventService.publish(event);
    expect(injectAttempts).toBe(1);

    // Now transition the run to blocked with no active execution
    workflowRunRepo.updateRun(run.id, { status: 'blocked' });
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      startedAt: null,
      completedAt: Date.now(),
      result: 'blocked for test',
    });

    // Trigger the retry by waiting for the retry timer. CI runners can delay the
    // timer slightly, so poll the persisted delivery state rather than assuming
    // one sleep lands after the retry callback.
    let delivery = eventStore.listDeliveries(event.id)[0]!;
    for (let attempt = 0; attempt < 10 && delivery.state === 'pending'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      delivery = eventStore.listDeliveries(event.id)[0]!;
    }

    // The task is still active, so a blocked run no longer terminalizes the
    // delivery — it stays pending for the next retry.
    expect(delivery.state).toBe('pending');
  });

  test('re-registers interests when recovering a terminal workflow run', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-pre-terminal',
      startedAt: Date.now(),
    });
    tam.alive.add('session-pre-terminal');

    // Simulate terminal cleanup — clear interests and mark run done
    runtime.clearRunInterests(run.id);
    workflowRunRepo.updateRun(run.id, { status: 'done' });
    tam.alive.delete('session-pre-terminal'); // session dies at terminalization

    // Recover the terminal run back to active
    await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

    // Re-register subscription for the recovered run
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    // Set up a live session for the recovered execution
    const executions = nodeExecutionRepo.listByWorkflowRun(run.id);
    const pendingExec = executions.find((e) => e.status === 'pending');
    expect(pendingExec).toBeDefined();
    nodeExecutionRepo.update(pendingExec!.id, {
      status: 'in_progress',
      agentSessionId: 'session-recovered',
      startedAt: Date.now(),
    });
    tam.alive.add('session-recovered');

    // Publish an event — interests should be re-registered after recovery
    const event = makeEvent();
    await eventService.publish(event);

    expect(injected.length).toBeGreaterThanOrEqual(1);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('delivered');
  });

  test('clears retry state when pending queue overflow drops a retry delivery', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-overflow-retry',
      startedAt: Date.now(),
    });
    tam.alive.add('session-overflow-retry');
    await runtime.stop();
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async () => ({
      ok: false,
      error: 'temporary overflow retry failure',
    }));
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );

    const originalNow = Date.now;
    let fakeNow = originalNow();
    Date.now = () => fakeNow;
    const events = Array.from({ length: 51 }, (_, index) =>
      makeEvent({
        id: `evt-overflow-retry-${index}`,
        dedupeKey: `dedupe-overflow-retry-${index}`,
      })
    );
    try {
      for (const event of events) {
        await eventService.publish(event);
        fakeNow += 100;
      }
    } finally {
      Date.now = originalNow;
    }

    // Let the rate-limit digest timer flush; the batched digest items are
    // requeued as pending deliveries, and the oldest one is dropped with the
    // overflow reason once the queue reaches its limit.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const droppedDelivery = events
      .map((event) => eventStore.listDeliveries(event.id)[0]!)
      .find((delivery) => delivery.failureReason === 'pending_node_queue_overflow');
    expect(droppedDelivery).toBeDefined();
    expect(droppedDelivery!.state).toBe('failed');
    const retryState = runtime as unknown as {
      externalEventRetryTimers: Map<string, unknown>;
      externalEventRetryCounts: Map<string, number>;
    };
    expect(retryState.externalEventRetryTimers.has(droppedDelivery!.deliveryKey)).toBe(false);
    expect(retryState.externalEventRetryCounts.has(droppedDelivery!.deliveryKey)).toBe(false);
  });

  test('fails delivery terminally when injection command handler is missing', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-no-handler',
      startedAt: Date.now(),
    });
    tam.alive.add('session-no-handler');
    await runtime.stop();
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );

    const event = makeEvent();
    await eventService.publish(event);

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toContain('No handler registered');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('fails delivery terminally when command bus is missing', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-no-command-bus',
      startedAt: Date.now(),
    });
    tam.alive.add('session-no-command-bus');
    await runtime.stop();
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );

    const event = makeEvent();
    await eventService.publish(event);

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toContain(
      "No handler registered for command 'agent.message.inject'"
    );
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('clears queued retry items when a later attempt fails terminally', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-terminal-after-retry',
      startedAt: Date.now(),
    });
    tam.alive.add('session-terminal-after-retry');
    await runtime.stop();
    const failingCommandBus = createInternalCommandBus();
    failingCommandBus.register('agent.message.inject', async () => ({
      ok: false,
      error: 'temporary before terminal',
    }));
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: failingCommandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );
    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
    await runtime.stop();

    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    await runtime.rehydrateExecutors();
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: taskRepo.listByWorkflowRun(run.id)[0]!.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-terminal-after-retry',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('failed');

    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: taskRepo.listByWorkflowRun(run.id)[0]!.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-terminal-after-retry',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(0);
  });

  test('terminalizes DB-only pending deliveries when run interests are cleared', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);
    const pendingDelivery = eventStore.listDeliveries(event.id)[0]!;
    expect(pendingDelivery.state).toBe('pending');

    runtime.clearRunInterests(run.id);

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('run_terminal_cleanup');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('terminalizes DB-only pending deliveries when target subscription is cleared', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);
    const pendingDelivery = eventStore.listDeliveries(event.id)[0]!;
    expect(pendingDelivery.state).toBe('pending');

    runtime.unregisterExecution(run.id, task.id, 'code', 'coder');

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('node_execution_cancelled');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('terminalizes persisted pending deliveries for cancelled tasks on rehydrate', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);
    taskRepo.updateTask(task.id, { status: 'cancelled' });
    await runtime.stop();

    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    await runtime.rehydrateExecutors();

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('target_task_terminal');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('activation flush delivers persisted pending deliveries regardless of run status', async () => {
    const { run, task } = await startRunWithSubscription();
    // Make the node execution non-active so the published event is persisted as
    // a retryable pending delivery (failureReason = node_execution_not_active),
    // which is the only kind collectPersistedPendingDeliveries re-dispatches.
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, { status: 'idle', completedAt: Date.now() });

    const event = makeEvent();
    await eventService.publish(event);
    const persisted = eventStore.listDeliveries(event.id)[0]!;
    expect(persisted.state).toBe('pending');
    expect(persisted.failureReason).toBe('deliveryMode:defer; node_execution_not_active');

    // Run transitions to terminal, but the task is still active and the node
    // reactivates with a live session — run status no longer gates delivery.
    workflowRunRepo.updateRun(run.id, { status: 'cancelled' });

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-activation-after-terminal',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('delivered');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-activation-after-terminal');
  });

  test('activation flush delivers persisted pending deliveries for blocked runs without active execution', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, { status: 'idle', completedAt: Date.now() });

    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
      'deliveryMode:defer; node_execution_not_active'
    );

    // Run becomes blocked with no active execution, but the task is still
    // active and the node reactivates with a live session.
    workflowRunRepo.updateRun(run.id, { status: 'blocked' });

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-activation-blocked-no-exec',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('delivered');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-activation-blocked-no-exec');
  });

  test('activation flush dispatches persisted pending deliveries for blocked runs with active execution', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, { status: 'idle', completedAt: Date.now() });

    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
      'deliveryMode:defer; node_execution_not_active'
    );

    // Reactivate the node execution, then leave the run blocked — a blocked run
    // with an active execution is still externally deliverable.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-activation-blocked-active',
      startedAt: Date.now(),
      completedAt: null,
    });
    tam.alive.add('session-activation-blocked-active');
    workflowRunRepo.updateRun(run.id, { status: 'blocked' });

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-activation-blocked-active',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(injected).toHaveLength(1);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('delivered');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('does not requeue persisted pending deliveries for removed subscriptions', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const event = makeEvent();
    await eventService.publish(event);
    await runtime.stop();
    // Create fresh runtime WITHOUT registering a subscription — simulates
    // the subscription being removed between runtime restarts
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: createInternalCommandBus(),
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });

    await runtime.rehydrateExecutors();
    // Subscriptions are now durable: a restart rehydrates them from the table
    // (see space-runtime-workflow-subscription-persistence.test.ts), so
    // restarting alone no longer drops the interest. Explicitly unregister to
    // exercise the removed-subscription path the rest of this test asserts on.
    runtime.unregisterSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-removed-interest',
    });

    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('subscription_no_longer_active');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('schedules persisted pending retries for active sessions on rehydrate', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-persisted-retry',
      startedAt: Date.now(),
    });
    tam.alive.add('session-persisted-retry');
    await runtime.stop();
    const failingCommandBus = createInternalCommandBus();
    failingCommandBus.register('agent.message.inject', async () => ({
      ok: false,
      error: 'persisted transient failure',
    }));
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: failingCommandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );
    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
    await runtime.stop();

    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(
      run.id,
      taskRepo.listByWorkflowRun(run.id)[0]!.id,
      'code',
      'coder',
      DEFAULT_TOPIC
    );

    await runtime.rehydrateExecutors();

    expect(injected).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-persisted-retry');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('preserves deferred delivery mode when rebuilding pending queue', async () => {
    const { workflow, run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-defer-rehydrate',
      startedAt: Date.now(),
    });
    await runtime.stop();
    let failNext = true;
    const failingCommandBus = createInternalCommandBus();
    failingCommandBus.register('agent.message.inject', async () => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: 'defer failure' };
      }
      return { ok: true };
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
      commandBus: failingCommandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
      'deliveryMode:defer; defer failure'
    );
    await runtime.stop();

    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    await runtime.rehydrateExecutors();
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-defer-rehydrate',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.deliveryMode).toBe('defer');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('activation timeout schedules bounded retries and terminalizes', async () => {
    const { run } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    // Empty result simulates activateTargetSessionsForMessage timing out.
    tam.activationResult = [];

    const event = makeEvent();
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
      'deliveryMode:defer; node_execution_not_active'
    );

    await new Promise((resolve) => setTimeout(resolve, 5_600));

    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('deliveryMode:defer; node_execution_not_active');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
    expect(tam.activationCalls.length).toBeGreaterThanOrEqual(5);
    expect(tam.activationCalls.length).toBeLessThanOrEqual(6);
  });

  test('static subscription without node execution does not activate future nodes', async () => {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Two-node workflow',
      description: '',
      nodes: [
        {
          id: 'start',
          name: 'Start',
          agents: [{ agentId: AGENT_ID, name: 'coder' }],
        },
        {
          id: 'future',
          name: 'Future',
          agents: [{ agentId: AGENT_ID, name: 'reviewer' }],
        },
      ],
      transitions: [],
      startNodeId: 'start',
      rules: [],
      tags: [],
    });
    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const task = tasks[0]!;
    // Only the start node has an execution; subscribe to the future node.
    runtime.registerSubscription(run.id, task.id, 'future', 'reviewer', DEFAULT_TOPIC, {
      subscriptionKind: 'static',
    });

    const event = makeEvent();
    await eventService.publish(event);

    expect(tam.activationCalls).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    expect(eventStore.getById(event.id)?.state).toBe('published');
  });

  test('successful activation drains older queued events before current', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    // Activation returns empty while the worker is idle, so older events persist
    // as retryable pending deliveries.
    tam.activationResult = [];

    const older = makeEvent({
      id: 'evt-older-queued',
      dedupeKey: 'dedupe-older-queued',
      occurredAt: 1_700_000_000_000,
    });
    const newer = makeEvent({
      id: 'evt-newer-queued',
      dedupeKey: 'dedupe-newer-queued',
      occurredAt: 1_700_000_000_100,
    });
    await eventService.publish(older);
    await eventService.publish(newer);
    expect(eventStore.listDeliveries(older.id)[0]!.state).toBe('pending');
    expect(eventStore.listDeliveries(newer.id)[0]!.state).toBe('pending');

    // The third event arrives while the worker is activating: the execution is
    // in_progress but has no sessionId yet, so activation kicks in and flushes
    // the older persisted pending deliveries before delivering the current one.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: null,
      completedAt: null,
    });
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-activated' }];
    tam.alive.add('session-activated');
    tam.onActivate = () => {
      nodeExecutionRepo.update(execution.id, {
        agentSessionId: 'session-activated',
      });
    };

    const current = makeEvent({
      id: 'evt-current-activating',
      dedupeKey: 'dedupe-current-activating',
      occurredAt: 1_700_000_000_200,
    });
    await eventService.publish(current);

    expect(injected.map((item) => JSON.parse(item.message).eventId)).toEqual([
      older.id,
      newer.id,
      current.id,
    ]);
    expect(eventStore.getById(older.id)?.state).toBe('delivered');
    expect(eventStore.getById(newer.id)?.state).toBe('delivered');
    expect(eventStore.getById(current.id)?.state).toBe('delivered');
  });

  test('awaits queued flush before delivering activating event', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const older = makeEvent({
      id: 'evt-older-async-flush',
      dedupeKey: 'dedupe-older-async-flush',
      occurredAt: 1_700_000_000_000,
    });
    await eventService.publish(older);
    expect(eventStore.listDeliveries(older.id)[0]!.state).toBe('pending');

    // Rebuild runtime with an awaitable inject so we can observe ordering.
    await runtime.stop();
    let releaseFirstInject!: () => void;
    const firstInjectStarted = Promise.withResolvers<void>();
    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      if (injected.length === 1) {
        firstInjectStarted.resolve();
        await new Promise<void>((resolve) => {
          releaseFirstInject = resolve;
        });
      }
      return { ok: true };
    });
    runtime = new SpaceRuntime({
      db,
      spaceManager,
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    // Activate the node: the next event triggers a flush of the older pending
    // delivery, then delivers itself. The async flush must complete the older
    // inject before the current event is injected.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: null,
      completedAt: null,
    });
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-async-flush' }];
    tam.alive.add('session-async-flush');
    tam.onActivate = () => {
      nodeExecutionRepo.update(execution.id, {
        agentSessionId: 'session-async-flush',
      });
    };

    const current = makeEvent({
      id: 'evt-current-async-flush',
      dedupeKey: 'dedupe-current-async-flush',
      occurredAt: 1_700_000_000_100,
    });
    const publishPromise = eventService.publish(current);
    await firstInjectStarted.promise;
    expect(injected).toHaveLength(1);
    expect(JSON.parse(injected[0]!.message).eventId).toBe(older.id);
    releaseFirstInject();
    await publishPromise;

    expect(injected.map((item) => JSON.parse(item.message).eventId)).toEqual([
      older.id,
      current.id,
    ]);
    expect(eventStore.getById(older.id)?.state).toBe('delivered');
    expect(eventStore.getById(current.id)?.state).toBe('delivered');
  });

  test('reschedules paused-space deliveries after resume', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);

    tam.activationResult = [];
    const event = makeEvent({ id: 'evt-paused-resume' });
    await eventService.publish(event);

    expect(tam.activationCalls).toHaveLength(0);
    const pending = eventStore.listDeliveries(event.id)[0]!;
    expect(pending.state).toBe('pending');
    expect(pending.failureReason).toBe('deliveryMode:defer; node_execution_not_active');

    // Resume the space. The runtime's onSpaceResumed hook must schedule an
    // activation retry for the sessionless pending delivery.
    db.prepare(`UPDATE spaces SET paused = 0 WHERE id = ?`).run(SPACE_ID);
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: null,
      completedAt: null,
    });
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-resume' }];
    tam.alive.add('session-resume');
    tam.onActivate = () => {
      nodeExecutionRepo.update(execution.id, {
        agentSessionId: 'session-resume',
      });
    };
    runtime.start();
    await spaceManager.resumeSpace(SPACE_ID);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(tam.activationCalls.length).toBeGreaterThanOrEqual(1);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-resume');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('resume preserves the original event TTL and expires stale deliveries', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);

    tam.activationResult = [];
    const event = makeEvent({ id: 'evt-paused-resume-ttl' });
    await eventService.publish(event);
    // Backdate the event past its TTL window while paused.
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      Date.now() - 301_000,
      event.id
    );

    // Resume shortly after — the queued item must keep the original event-age
    // anchor, so the delivery TTL-expires instead of getting a fresh window
    // measured from resume time.
    db.prepare(`UPDATE spaces SET paused = 0 WHERE id = ?`).run(SPACE_ID);
    runtime.start();
    await spaceManager.resumeSpace(SPACE_ID);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(injected).toHaveLength(0);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('ttl_expired');
    expect(eventStore.getById(event.id)?.state).toBe('failed');

    await runtime.stop();
  });

  test('requeues paused-space deliveries that resolve to a live session on resume', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);

    tam.activationResult = [];
    const event = makeEvent({ id: 'evt-paused-resume-session' });
    await eventService.publish(event);

    expect(tam.activationCalls).toHaveLength(0);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    // Resume with a LIVE session already attached to the execution so the
    // deferred delivery resolves via resolveSubscriptionTarget. The resume path
    // must schedule a delivery retry (scheduleExternalEventRetry) — not an
    // activation retry — and the event must be delivered without activation.
    db.prepare(`UPDATE spaces SET paused = 0 WHERE id = ?`).run(SPACE_ID);
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-resume-live',
      completedAt: null,
    });
    tam.alive.add('session-resume-live');
    runtime.start();
    await spaceManager.resumeSpace(SPACE_ID);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(tam.activationCalls).toHaveLength(0);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-resume-live');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('excludes retried delivery from activation flush drain', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const event = makeEvent({ id: 'evt-exclude-retry' });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
      'deliveryMode:defer; node_execution_not_active'
    );

    // Before the activation retry fires, make activation succeed. The retry
    // calls flushPendingNodeQueueAsync with the current deliveryKey excluded;
    // without that exclusion the DB-persisted pending row would be delivered
    // twice (once by the flush and once by the post-flush enqueue).
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: null,
      completedAt: null,
    });
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-exclude-retry' }];
    tam.alive.add('session-exclude-retry');
    tam.onActivate = () => {
      nodeExecutionRepo.update(execution.id, {
        agentSessionId: 'session-exclude-retry',
      });
    };

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(injected).toHaveLength(1);
    expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('rehydrates sessionless activation retries after restart', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const event = makeEvent({ id: 'evt-sessionless-rehydrate' });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
      'deliveryMode:defer; node_execution_not_active'
    );
    await runtime.stop();

    const commandBus = createInternalCommandBus();
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
    });
    runtime = new SpaceRuntime({
      db,
      spaceManager,
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    // Activation should succeed when the rehydrated retry fires.
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-rehydrated-retry' }];
    tam.alive.add('session-rehydrated-retry');
    tam.onActivate = () => {
      nodeExecutionRepo.update(execution.id, {
        agentSessionId: 'session-rehydrated-retry',
      });
    };

    // Reset call tracking so we only measure what happens after rehydrate.
    tam.activationCalls = [];
    injected = [];

    await runtime.rehydrateExecutors();
    expect(tam.activationCalls).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(tam.activationCalls.length).toBeGreaterThanOrEqual(1);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-rehydrated-retry');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('preserves chronological order when older activation retry activates first', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const older = makeEvent({
      id: 'evt-older-retry-first',
      dedupeKey: 'dedupe-older-retry-first',
      occurredAt: 1_700_000_000_000,
    });
    const newer = makeEvent({
      id: 'evt-newer-retry-first',
      dedupeKey: 'dedupe-newer-retry-first',
      occurredAt: 1_700_000_000_100,
    });
    await eventService.publish(older);
    // Stagger ingestion so the DB `created_at` ordering matches the intended
    // chronological order; without a gap both rows may share the same ms.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await eventService.publish(newer);
    expect(eventStore.listDeliveries(older.id)[0]!.state).toBe('pending');
    expect(eventStore.listDeliveries(newer.id)[0]!.state).toBe('pending');

    // The older event's retry fires first and activates the agent. The drain
    // includes the older event in the sorted batch so it is delivered before
    // the newer pending row, regardless of which retry timer fires first.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: null,
      completedAt: null,
    });
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-retry-order' }];
    tam.alive.add('session-retry-order');
    tam.onActivate = () => {
      nodeExecutionRepo.update(execution.id, {
        agentSessionId: 'session-retry-order',
      });
    };

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(injected.map((item) => JSON.parse(item.message).eventId)).toEqual([older.id, newer.id]);
    expect(eventStore.getById(older.id)?.state).toBe('delivered');
    expect(eventStore.getById(newer.id)?.state).toBe('delivered');
  });

  test('scopes activation retry to original delivery when subscription is removed', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const event = makeEvent({ id: 'evt-subscription-removed' });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    // Remove the subscription before the retry fires.
    runtime.unregisterSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    // The retry targets the specific delivery and terminalizes it, instead of
    // replaying the whole event and marking it ignored while the row stays pending.
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('subscription_no_longer_active');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('unregisters space-resume hook on stop', async () => {
    const manager = spaceManager;
    const before = (manager as unknown as { onSpaceResumedCallbacks: unknown[] })
      .onSpaceResumedCallbacks.length;
    const runtime2 = new SpaceRuntime({
      db,
      spaceManager: manager,
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: (runtime as unknown as { config: { commandBus: unknown } }).config.commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    const afterRegister = (manager as unknown as { onSpaceResumedCallbacks: unknown[] })
      .onSpaceResumedCallbacks.length;
    expect(afterRegister).toBe(before + 1);

    await runtime2.stop();
    const afterStop = (manager as unknown as { onSpaceResumedCallbacks: unknown[] })
      .onSpaceResumedCallbacks.length;
    expect(afterStop).toBe(before);
  });

  test('rehydrates sessionless activation timers after stop-start', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const event = makeEvent({ id: 'evt-stop-start-retry' });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    await runtime.stop();

    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-stop-start' }];
    tam.alive.add('session-stop-start');
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-stop-start',
      startedAt: Date.now(),
    });

    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-stop-start');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');

    await runtime.stop();
  });

  test('keeps activation retries alive while spawn is pending', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'pending',
      agentSessionId: null,
      completedAt: null,
    });

    const event = makeEvent({ id: 'evt-pending-spawn' });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
    expect(tam.activationCalls).toHaveLength(0);

    // Simulate the background spawn completing before the retry fires.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-pending-spawn',
    });
    tam.alive.add('session-pending-spawn');

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-pending-spawn');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('orders older retry before newer pending rows in resolved-session drain', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const older = makeEvent({
      id: 'evt-older-retry-live',
      dedupeKey: 'dedupe-older-retry-live',
      occurredAt: 1_700_000_000_000,
    });
    const newer = makeEvent({
      id: 'evt-newer-retry-live',
      dedupeKey: 'dedupe-newer-retry-live',
      occurredAt: 1_700_000_000_100,
    });

    await eventService.publish(older);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await eventService.publish(newer);

    expect(eventStore.listDeliveries(older.id)[0]!.state).toBe('pending');
    expect(eventStore.listDeliveries(newer.id)[0]!.state).toBe('pending');

    // Make the session live; the older retry fires first and the drain must
    // include the current (older) event in the sorted batch so A is delivered
    // before B, even though B is already persisted as a pending row.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-retry-drain-order',
    });
    tam.alive.add('session-retry-drain-order');

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(injected.map((item) => JSON.parse(item.message).eventId)).toEqual([older.id, newer.id]);
    expect(eventStore.getById(older.id)?.state).toBe('delivered');
    expect(eventStore.getById(newer.id)?.state).toBe('delivered');
  });

  test('re-registers space-resume hook on start after stop', async () => {
    const manager = spaceManager;
    const before = (manager as unknown as { onSpaceResumedCallbacks: unknown[] })
      .onSpaceResumedCallbacks.length;
    const runtime2 = new SpaceRuntime({
      db,
      spaceManager: manager,
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus: (runtime as unknown as { config: { commandBus: unknown } }).config.commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });
    const afterRegister = (manager as unknown as { onSpaceResumedCallbacks: unknown[] })
      .onSpaceResumedCallbacks.length;
    expect(afterRegister).toBe(before + 1);

    await runtime2.stop();
    expect(
      (manager as unknown as { onSpaceResumedCallbacks: unknown[] }).onSpaceResumedCallbacks
    ).toHaveLength(before);

    runtime2.start();
    expect(
      (manager as unknown as { onSpaceResumedCallbacks: unknown[] }).onSpaceResumedCallbacks
    ).toHaveLength(before + 1);

    await runtime2.stop();
  });

  test('terminalizes resumed deliveries whose subscription was removed', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const event = makeEvent({ id: 'evt-resume-subscription-removed' });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    await spaceManager.pauseSpace(SPACE_ID);
    runtime.unregisterSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    await spaceManager.resumeSpace(SPACE_ID);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('subscription_no_longer_active');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('does not activate blocked executions so they stay on the blocked-run recovery path', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'blocked',
      agentSessionId: null,
      startedAt: null,
      completedAt: null,
    });

    const event = makeEvent({ id: 'evt-blocked-exec' });
    await eventService.publish(event);

    // Activation should not have been attempted for a blocked execution.
    expect(tam.activationCalls).toHaveLength(0);
    // The delivery stays pending/queued for the recovery path rather than
    // being terminally failed.
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
  });

  test('expires activation retry instead of redispatching stale event', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const event = makeEvent({ id: 'evt-activation-ttl' });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    // Backdate the event past the TTL window before the activation retry fires.
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      Date.now() - 301_000,
      event.id
    );

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('ttl_expired');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('keeps activation retry pending when only the run becomes undeliverable', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const event = makeEvent({ id: 'evt-activation-run-shutdown' });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    // Run becomes cancelled before the activation retry fires. The task is
    // still active, so run status no longer terminalizes the delivery.
    workflowRunRepo.updateRun(run.id, { status: 'cancelled' });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
  });

  test('ordered dispatch skips delivery terminalized while batch was prepared', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });

    const earlier = makeEvent({ id: 'evt-terminalized-early' });
    const later = makeEvent({ id: 'evt-terminalized-late' });
    await eventService.publish(earlier);
    await eventService.publish(later);
    expect(eventStore.listDeliveries(earlier.id)[0]!.state).toBe('pending');
    expect(eventStore.listDeliveries(later.id)[0]!.state).toBe('pending');

    // Activate the node so the flush will dispatch both queued items.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-terminalized-dispatch',
      completedAt: null,
    });
    tam.alive.add('session-terminalized-dispatch');

    // Simulate a concurrent cleanup terminalizing the earlier delivery before
    // the ordered dispatch loop reaches it.
    const earlierDelivery = eventStore.listDeliveries(earlier.id)[0]!;
    eventStore.markDeliveryFailed(earlier.id, earlierDelivery.deliveryKey, {
      terminal: true,
      reason: 'subscription_no_longer_active',
    });

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-terminalized-dispatch',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(injected.map((item) => JSON.parse(item.message).eventId)).toEqual([later.id]);
    expect(eventStore.listDeliveries(earlier.id)[0]!.state).toBe('failed');
    expect(eventStore.listDeliveries(later.id)[0]!.state).toBe('delivered');
  });

  test('preserves event age when requeueing activation retries for pending executions', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'pending',
      agentSessionId: null,
      completedAt: null,
    });

    const event = makeEvent({ id: 'evt-pending-activation-age' });
    await eventService.publish(event);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');

    // Backdate the event past the TTL window. The pending-execution queueing
    // must carry the original createdAt so the activation retry TTL check
    // expires the stale event instead of redispatching it after spawn.
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      Date.now() - 301_000,
      event.id
    );

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toBe('ttl_expired');
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('preserves deferred mode when activation retry reaches a live session', async () => {
    const { run, task } = await startRunWithSubscription();
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });
    tam.activationResult = [];

    const event = makeEvent({ id: 'evt-activation-defer-mode' });
    await eventService.publish(event);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');

    // Simulate a rehydrated/sessionless retry whose pending row encoded defer mode.
    eventStore.markDeliveryFailed(event.id, delivery.deliveryKey, {
      terminal: false,
      reason: 'deliveryMode:defer; digest pending during session loss',
    });

    // Now make the session live and trigger the activation retry.
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-activation-defer',
    });
    tam.alive.add('session-activation-defer');

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('session-activation-defer');
    expect(injected[0]!.deliveryMode).toBe('defer');
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });
});

describe('SpaceRuntime queue-health snapshot', () => {
  let db: Database;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let workflowManager: SpaceWorkflowManager;
  let runtime: SpaceRuntime;
  let eventStore: ExternalEventStore;
  let queueHealthMetrics: ExternalEventQueueMetrics;
  let eventService: ExternalEventService;
  let injected: Array<{ sessionId: string; message: string; deliveryMode?: string }>;
  let tam: MockTaskAgentManager;
  let bus: ReturnType<typeof createDaemonInternalEventBus>;

  beforeEach(() => {
    db = makeDb();
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    bus = createDaemonInternalEventBus();
    const commandBus = createInternalCommandBus();
    eventStore = new ExternalEventStore(db);
    queueHealthMetrics = new ExternalEventQueueMetrics();
    // Mirror SpaceRuntimeService wiring: observe terminal transitions from a
    // single point so delivered/failure counters stay accurate.
    eventStore.setDeliveryTerminalHook((event) => queueHealthMetrics.recordDeliveryTerminal(event));
    eventService = new ExternalEventService(eventStore, bus);
    injected = [];
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({
        sessionId: command.sessionId,
        message: command.message,
        deliveryMode: command.deliveryMode,
      });
      return { ok: true };
    });
    tam = new MockTaskAgentManager();
    runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus,
      externalEventStore: eventStore,
      queueHealthMetrics,
      taskAgentManager: tam as never,
    });
  });

  afterEach(() => {
    void runtime.stop();
  });

  function createWorkflow(): SpaceWorkflow {
    return workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Workflow ${Math.random()}`,
      description: '',
      nodes: [
        {
          id: 'code',
          name: 'Code',
          agents: [{ agentId: AGENT_ID, name: 'coder' }],
        },
      ],
      transitions: [],
      startNodeId: 'code',
      rules: [],
      tags: [],
    });
  }

  async function startRun(): Promise<{ runId: string; taskId: string }> {
    const workflow = createWorkflow();
    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const task = tasks[0]!;
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    return { runId: run.id, taskId: task.id };
  }

  test('reports zero gauges and counters before any event', () => {
    const snapshot = runtime.getQueueHealthSnapshot();
    expect(snapshot.gauges.queueDepth).toBe(0);
    expect(snapshot.gauges.queueKeys).toBe(0);
    expect(snapshot.gauges.inFlight).toBe(0);
    expect(snapshot.gauges.persistedPending).toBe(0);
    expect(snapshot.counters.enqueue).toBe(0);
    expect(snapshot.counters.delivered).toBe(0);
    expect(snapshot.counters.flushAttempts).toBe(0);
    expect(snapshot.gauges.queueAgeMs).toBeNull();
  });

  test('enqueues pending events and reports depth, source, target state, and age', async () => {
    const { runId } = await startRun();
    // Node execution starts `pending` with no session, so the event is queued.
    expect(nodeExecutionRepo.listByNode(runId, 'code')[0]!.status).toBe('pending');
    await eventService.publish(makeEvent());

    const snapshot = runtime.getQueueHealthSnapshot();
    expect(snapshot.counters.enqueue).toBe(1);
    expect(snapshot.counters.enqueueBySource).toEqual({ github: 1 });
    expect(snapshot.counters.enqueueByTargetState).toEqual({
      'run=in_progress;node=pending': 1,
    });
    expect(snapshot.gauges.queueDepth).toBe(1);
    expect(snapshot.gauges.queueKeys).toBe(1);
    expect(snapshot.gauges.queueAgeMs).not.toBeNull();
    expect(snapshot.gauges.queueAgeMs!.count).toBe(1);
  });

  test('counts cap-eviction terminal failures when a target queue overflows', async () => {
    await startRun();
    // 50 items fill the per-target queue; the 51st evicts the oldest, which the
    // store hook records as a terminal pending_node_queue_overflow failure.
    for (let i = 0; i < 51; i++) {
      await eventService.publish(makeEvent());
    }

    const snapshot = runtime.getQueueHealthSnapshot();
    expect(snapshot.counters.enqueue).toBe(51);
    expect(snapshot.counters.finalFailuresByReason['pending_node_queue_overflow']).toBe(1);
    expect(snapshot.failuresByCategory.cap_eviction).toBe(1);
    // Queue is capped at 50.
    expect(snapshot.gauges.queueDepth).toBe(50);
  });

  test('counts delivered after a successful injection into a live session', async () => {
    const { runId } = await startRun();
    const execution = nodeExecutionRepo.listByNode(runId, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-live',
      startedAt: Date.now(),
    });
    tam.alive.add('session-live');

    await eventService.publish(makeEvent());

    expect(injected).toHaveLength(1);
    const snapshot = runtime.getQueueHealthSnapshot();
    expect(snapshot.counters.delivered).toBe(1);
    expect(snapshot.counters.enqueue).toBe(0);
    expect(snapshot.gauges.queueDepth).toBe(0);
    expect(snapshot.counters.flushAttempts).toBeGreaterThanOrEqual(1);
  });
});
