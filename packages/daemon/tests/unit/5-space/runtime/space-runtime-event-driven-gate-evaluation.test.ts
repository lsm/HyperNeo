/**
 * Service-level integration tests for event-driven gate evaluation (#616).
 *
 * Covers the full chain:
 *   gate blocks → auto-subscribe to GitHub PR events
 *   external event published → handleBlockedRunExternalEvent → notifyGateDataChanged
 *   gate opens → clearPrEventSubscriptionsForRun → session notified
 *
 * Uses real SQLite-backed repos and a real ChannelRouter so the gate
 * activation path is exercised end-to-end. The TaskAgentManager is stubbed
 * to capture injected messages and to keep session liveness state truthful.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { createInternalCommandBus } from '../../../../src/lib/internal-command-bus';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository';
import { GateOpenStateRepository } from '../../../../src/storage/repositories/gate-open-state-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

const SPACE_ID = 'space-event-driven-gate-eval';
const AGENT_ID = 'agent-event-driven-gate-eval';
const PR_URL = 'https://github.com/lsm/neokai/pull/42';
const PR_EVENT_TOPIC = 'github/lsm/neokai/pull_request/42.review_submitted';

interface TestContext {
  db: Database;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  nodeExecutionRepo: NodeExecutionRepository;
  gateDataRepo: GateDataRepository;
  workflowManager: SpaceWorkflowManager;
  service: SpaceRuntimeService;
  eventStore: ExternalEventStore;
  eventService: ExternalEventService;
  injected: Array<{ sessionId: string; message: string }>;
  runtimeNotifications: string[];
  tam: TaskAgentManagerStub;
}

class TaskAgentManagerStub {
  alive = new Set<string>();
  injected: Array<{ sessionId: string; message: string }> = [];
  spawned: string[] = [];

  isSessionAlive(sessionId: string): boolean {
    return this.alive.has(sessionId);
  }
  getAgentSessionById(_sessionId: string): null {
    return null;
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
  async injectRuntimeRecoveryMessage(subSessionId: string, message: string): Promise<string> {
    this.injected.push({ sessionId: subSessionId, message });
    return 'ok';
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

function makeDb(): Database {
  const db = new Database(':memory:');
  createSpaceTables(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
  ).run(SPACE_ID, SPACE_ID, '/tmp/event-driven-gate-eval', 'EventDrivenGateEval', now, now);
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, tools, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, '', '[]', '', ?, ?)`
  ).run(AGENT_ID, SPACE_ID, 'Coder', now, now);
  return db;
}

/** Build a gate field that checks `approved === true` (writers = [] → human-only). */
const approvedField = {
  name: 'approved',
  type: 'boolean',
  writers: [],
  check: { op: '==', value: true },
} as const;

/** String field for stashing the PR URL in gate data. */
const prUrlField = {
  name: 'pr_url',
  type: 'string',
  writers: ['coder'],
  check: { op: 'exists' },
} as const;

async function setup(options: {
  gates: SpaceWorkflow['gates'];
  channels?: SpaceWorkflow['channels'];
}): Promise<TestContext> {
  const db = makeDb();
  const taskRepo = new SpaceTaskRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const gateDataRepo = new GateDataRepository(db);
  const gateOpenStateRepo = new GateOpenStateRepository(db);
  const workflowRunRepo = new SpaceWorkflowRunRepository(db, gateOpenStateRepo);
  const channelCycleRepo = new ChannelCycleRepository(db);
  const workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
  const bus = new InternalEventBus<DaemonInternalEventMap>();
  const commandBus = createInternalCommandBus();
  const eventStore = new ExternalEventStore(db);
  const eventService = new ExternalEventService(eventStore, bus);
  const injected: Array<{ sessionId: string; message: string }> = [];
  commandBus.register('agent.message.inject', async (command) => {
    injected.push({ sessionId: command.sessionId, message: command.message });
    return { ok: true };
  });

  const tam = new TaskAgentManagerStub();
  const runtimeNotifications: string[] = [];
  // Override the stub's recovery injection so we can assert it was invoked by
  // the service-level notification path (separate from command-bus injection).
  tam.injectRuntimeRecoveryMessage = async (_sessionId, message) => {
    runtimeNotifications.push(message);
    return 'ok';
  };
  const tamProxy: TaskAgentManager = tam as unknown as TaskAgentManager;

  const service = new SpaceRuntimeService({
    db,
    spaceManager: new SpaceManager(db),
    spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    tickIntervalMs: 60_000,
    gateDataRepo,
    gateOpenStateRepo,
    channelCycleRepo,
    internalEventBus: bus,
    commandBus,
    externalEventStore: eventStore,
  });
  service.setTaskAgentManager(tamProxy);

  // Seed workflow with the provided gates/channels.
  workflowManager.createWorkflow({
    spaceId: SPACE_ID,
    name: `Workflow ${Math.random()}`,
    description: '',
    nodes: [
      { id: 'code', name: 'Code', agents: [{ agentId: AGENT_ID, name: 'coder' }] },
      { id: 'review', name: 'Review', agents: [{ agentId: AGENT_ID, name: 'reviewer' }] },
    ],
    transitions: [],
    startNodeId: 'code',
    rules: [],
    tags: [],
    gates: options.gates,
    channels: options.channels ?? [],
  });

  return {
    db,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    gateDataRepo,
    workflowManager,
    service,
    eventStore,
    eventService,
    injected,
    runtimeNotifications,
    tam,
  };
}

async function seedBlockedRunWithPr(
  ctx: TestContext,
  workflowId: string
): Promise<{ runId: string; coderSessionId: string; coderExecutionId: string }> {
  const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);
  const { run } = await runtime.startWorkflowRun(SPACE_ID, workflowId, 'Run');
  const execution = ctx.nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
  const coderSessionId = `session-coder-${run.id}`;
  ctx.nodeExecutionRepo.update(execution.id, {
    status: 'in_progress',
    agentSessionId: coderSessionId,
    startedAt: Date.now(),
  });
  ctx.tam.alive.add(coderSessionId);

  // Plant the PR URL into gate data so resolvePrUrlForRun() can find it.
  const workflow = ctx.workflowManager.getWorkflow(workflowId)!;
  const firstGateId = workflow.gates?.[0]?.id ?? 'gate';
  ctx.gateDataRepo.merge(run.id, firstGateId, { pr_url: PR_URL });

  ctx.workflowRunRepo.updateRun(run.id, { status: 'blocked', failureReason: 'agentCrash' });
  // Execution stays in_progress with a live session so the blocked run is
  // still considered deliverable by handleExternalEvent.
  return { runId: run.id, coderSessionId, coderExecutionId: execution.id };
}

describe('SpaceRuntimeService event-driven gate evaluation', () => {
  test('notifyGateDataChanged auto-subscribes a blocked run to GitHub PR events when prUrl is resolvable', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [
        {
          id: 'ch-code-to-review',
          from: 'coder',
          to: 'reviewer',
          gateId: 'approval',
        },
      ],
    });

    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Force the auto-subscribe path by calling notifyGateDataChanged (still blocked).
    await ctx.service.notifyGateDataChanged(runId, 'approval');

    // Publish a PR event — the auto-subscription should match and deliver.
    const event: ExternalEvent = {
      id: `evt-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
      summary: 'Codex approved',
      payload: { action: 'review_submitted', user: 'codex', content: '+1' },
    };
    await ctx.eventService.publish(event);

    expect(ctx.injected.length).toBeGreaterThanOrEqual(1);
    expect(ctx.eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('notifyGateDataChanged replays a retained PR event for an already in_progress run', async () => {
    const ctx = await setup({
      gates: [{ id: 'approval', fields: [approvedField, prUrlField] }],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = ctx.nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    const coderSessionId = `session-coder-${run.id}`;
    ctx.nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: coderSessionId,
      startedAt: Date.now(),
    });
    ctx.tam.alive.add(coderSessionId);
    ctx.gateDataRepo.merge(run.id, 'approval', { pr_url: PR_URL });

    // Halt the tick loop and clear any auto-sub the sweep created, so the next
    // published PR event is genuinely retained (published, no delivery rows).
    await runtime.stop();
    runtime.clearPrEventSubscriptionsForRun(run.id);

    const event: ExternalEvent = {
      id: `evt-retained-inprogress-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-retained-inprogress-${Math.random().toString(36).slice(2)}`,
      summary: 'review',
      payload: { action: 'review_submitted' },
    };
    await ctx.eventService.publish(event);
    expect(ctx.eventStore.listDeliveries(event.id)).toHaveLength(0);
    expect(ctx.eventStore.getById(event.id)?.state).toBe('published');

    // A gate-data write on the already in_progress run must create the sub AND
    // replay the retained event — no transition will replay it.
    await ctx.service.notifyGateDataChanged(run.id, 'approval');

    expect(ctx.injected.length).toBeGreaterThanOrEqual(1);
    expect(ctx.eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('handleBlockedRunExternalEvent re-evaluates gates and clears auto-subscription when a gate opens', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [
        {
          id: 'ch-code-to-review',
          from: 'coder',
          to: 'reviewer',
          gateId: 'approval',
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Auto-subscribe first (simulating what notifyGateDataChanged does on still-blocked).
    await ctx.service.notifyGateDataChanged(runId, 'approval');

    // Satisfy the gate — mark approved in gate data. Next re-eval should open.
    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });

    // Simulate an external event landing for the blocked run.
    await ctx.service.handleBlockedRunExternalEvent({
      runId,
      event: {
        namespaceId: SPACE_ID,
        spaceId: SPACE_ID,
        eventId: `evt-${Math.random().toString(36).slice(2)}`,
        source: 'github',
        topic: PR_EVENT_TOPIC,
        dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
        summary: 'Codex approved',
        payload: { action: 'review_submitted', user: 'codex', content: '+1' },
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
      },
    });

    // Courtesy notification must reach the still-alive coder session.
    expect(ctx.runtimeNotifications.length).toBeGreaterThanOrEqual(1);
    expect(ctx.runtimeNotifications[0]).toMatch(/gate re-evaluation triggered by external event/i);

    // After the gate opens, subsequent PR events should still deliver while the
    // run is in_progress.
    ctx.injected.length = 0;
    const followUp: ExternalEvent = {
      id: `evt-followup-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-followup-${Math.random().toString(36).slice(2)}`,
      summary: 'Follow-up event after gate opened',
      payload: { action: 'review_submitted' },
    };
    await ctx.eventService.publish(followUp);
    expect(ctx.injected).toHaveLength(1);
  });

  test('handleBlockedRunExternalEvent no-ops for non-blocked runs', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField],
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    // Run stays in_progress — never transitioned to blocked.
    await runtime.executeTick();

    await ctx.service.handleBlockedRunExternalEvent({
      runId: run.id,
      event: {
        namespaceId: SPACE_ID,
        spaceId: SPACE_ID,
        eventId: 'evt-noop',
        source: 'github',
        topic: PR_EVENT_TOPIC,
        dedupeKey: 'dedupe-noop',
        summary: 'noop',
        payload: {},
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
      },
    });

    expect(ctx.runtimeNotifications).toHaveLength(0);
  });

  test('handleBlockedRunExternalEvent no-ops when the run has no PR URL', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField],
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    ctx.workflowRunRepo.updateRun(run.id, { status: 'blocked', failureReason: 'agentCrash' });
    await runtime.executeTick();
    // No pr_url seeded — auto-subscribe should skip silently.

    await ctx.service.handleBlockedRunExternalEvent({
      runId: run.id,
      event: {
        namespaceId: SPACE_ID,
        spaceId: SPACE_ID,
        eventId: 'evt-no-prurl',
        source: 'github',
        topic: PR_EVENT_TOPIC,
        dedupeKey: 'dedupe-no-prurl',
        summary: 'noop',
        payload: {},
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
      },
    });

    expect(ctx.runtimeNotifications).toHaveLength(0);
  });

  test('handleBlockedRunExternalEvent transitions the run back to in_progress when a gate opens', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [
        {
          id: 'ch-code-to-review',
          from: 'coder',
          to: 'reviewer',
          gateId: 'approval',
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Satisfy the approval gate, then drive event-driven re-evaluation.
    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });

    await ctx.service.handleBlockedRunExternalEvent({
      runId,
      event: {
        namespaceId: SPACE_ID,
        spaceId: SPACE_ID,
        eventId: `evt-resume-${Math.random().toString(36).slice(2)}`,
        source: 'github',
        topic: PR_EVENT_TOPIC,
        dedupeKey: `dedupe-resume-${Math.random().toString(36).slice(2)}`,
        summary: 'Codex approved',
        payload: {},
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
      },
    });

    // Run must transition blocked → in_progress so the tick loop spawns the
    // newly-activated review node. Otherwise the gate is open but the workflow
    // is stuck in blocked status.
    const updatedRun = ctx.workflowRunRepo.getRun(runId);
    expect(updatedRun?.status).toBe('in_progress');
    // Session still got the courtesy notification.
    expect(ctx.runtimeNotifications.length).toBeGreaterThanOrEqual(1);
  });

  test('handleBlockedRunExternalEvent promotes the canonical task out of blocked when the run resumes', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [
        {
          id: 'ch-code-to-review',
          from: 'coder',
          to: 'reviewer',
          gateId: 'approval',
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Mark the canonical task as blocked (mirrors what markFailed RPC does).
    const tasks = ctx.taskRepo.listByWorkflowRun(runId);
    const canonical = tasks[0]!;
    ctx.taskRepo.updateTask(canonical.id, {
      status: 'blocked',
      pendingCheckpointType: 'gate',
    });

    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });

    await ctx.service.handleBlockedRunExternalEvent({
      runId,
      event: {
        namespaceId: SPACE_ID,
        spaceId: SPACE_ID,
        eventId: `evt-task-resume-${Math.random().toString(36).slice(2)}`,
        source: 'github',
        topic: PR_EVENT_TOPIC,
        dedupeKey: `dedupe-task-resume-${Math.random().toString(36).slice(2)}`,
        summary: 'Codex approved',
        payload: {},
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
      },
    });

    const updatedTask = ctx.taskRepo.getTask(canonical.id);
    expect(updatedTask?.status).toBe('in_progress');
    expect(updatedTask?.pendingCheckpointType).toBeNull();
  });

  test('rehydrateBlockedRunPrEventSubscriptions rebuilds auto-subscriptions for blocked runs after a restart', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [
        {
          id: 'ch-code-to-review',
          from: 'coder',
          to: 'reviewer',
          gateId: 'approval',
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Simulate restart: the topic trie is in-memory, so manually clear it.
    ctx.service.runtime.clearPrEventSubscriptionsForRun(runId);
    ctx.service.runtime.clearRunInterests(runId);

    // Rehydrate — should rebuild the auto-subscription from persisted gate data.
    await ctx.service.rehydrateBlockedRunPrEventSubscriptions();

    // Publishing a PR event must now match and deliver.
    const event: ExternalEvent = {
      id: `evt-rehydrate-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-rehydrate-${Math.random().toString(36).slice(2)}`,
      summary: 'Codex approved',
      payload: { action: 'review_submitted' },
    };
    await ctx.eventService.publish(event);
    expect(ctx.injected.length).toBeGreaterThanOrEqual(1);
  });

  test('rehydrateBlockedRunPrEventSubscriptions skips runs without a resolvable PR URL', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField],
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    ctx.workflowRunRepo.updateRun(run.id, { status: 'blocked', failureReason: 'agentCrash' });

    // No pr_url in gate data — rehydrate must skip silently.
    await ctx.service.rehydrateBlockedRunPrEventSubscriptions();

    const event: ExternalEvent = {
      id: `evt-no-prurl-rehydrate-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-no-prurl-rehydrate-${Math.random().toString(36).slice(2)}`,
      summary: 'noop',
      payload: {},
    };
    await ctx.eventService.publish(event);
    expect(ctx.injected).toHaveLength(0);
  });

  test('onRunBlocked fires sync when recoverStalledRuns transitions a run to blocked (no explicit gate write)', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [
        {
          id: 'ch-code-to-review',
          from: 'coder',
          to: 'reviewer',
          gateId: 'approval',
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

    // Seed gate data with a PR URL — but DO NOT call notifyGateDataChanged
    // so the auto-subscription is NOT registered via the write_gate path.
    ctx.gateDataRepo.merge(run.id, 'approval', { pr_url: PR_URL });

    // Simulate the tick-loop stall path: cancel the only execution so
    // recoverStalledRunsForSpace has no driveable work and transitions the
    // run to blocked. The onRunBlocked hook should fire
    // notifyRunBlocked automatically during the run→blocked transition;
    // the fallback slot lookup reuses the cancelled execution's
    // nodeId / agentName. NO manual re-activation of the execution — the
    // test must reflect production behavior where the agent session is gone
    // at the moment of stall-recovery.
    const execution = ctx.nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    ctx.nodeExecutionRepo.update(execution.id, {
      status: 'cancelled',
      completedAt: Date.now(),
    });
    await runtime.recoverStalledRunsForSpace(SPACE_ID);

    // Run is now blocked via the recovery path (not via gate write).
    expect(ctx.workflowRunRepo.getRun(run.id)?.status).toBe('blocked');

    // Pre-satisfy the approval gate so the next re-evaluation opens it.
    ctx.gateDataRepo.merge(run.id, 'approval', { approved: true, approvedAt: Date.now() });

    // Publishing a PR event triggers fireBlockedRunExternalEventHook BEFORE
    // the delivery filter — so even with no live execution to deliver to,
    // the hook fires handleBlockedRunExternalEvent, the gate opens, and the
    // run transitions blocked → in_progress. This is the production behavior
    // asserted by this test (no manual session activation).
    const event: ExternalEvent = {
      id: `evt-recover-blocked-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-recover-blocked-${Math.random().toString(36).slice(2)}`,
      summary: 'Codex approved',
      payload: {},
    };
    await ctx.eventService.publish(event);
    // The hook chain is fire-and-forget; let the microtask queue drain so
    // transitionBlockedRunToInProgress completes before assertion.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Hook fired → gate re-evaluated → opened → transitionBlockedRunToInProgress.
    expect(ctx.workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
  });

  test('rehydrateBlockedRunPrEventSubscriptionsForSpace rebuilds subscriptions for a paused-then-resumed space', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [
        {
          id: 'ch-code-to-review',
          from: 'coder',
          to: 'reviewer',
          gateId: 'approval',
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Simulate restart wiping the in-memory topic trie.
    ctx.service.runtime.clearPrEventSubscriptionsForRun(runId);
    ctx.service.runtime.clearRunInterests(runId);

    // Startup rehydrate happens once but skips paused spaces; verify the
    // scoped variant works when called manually (mirrors the resume RPC).
    const count = ctx.service.rehydrateBlockedRunPrEventSubscriptionsForSpace(SPACE_ID);
    expect(count).toBe(1);

    const event: ExternalEvent = {
      id: `evt-resume-space-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-resume-space-${Math.random().toString(36).slice(2)}`,
      summary: 'Codex approved',
      payload: {},
    };
    await ctx.eventService.publish(event);
    expect(ctx.injected.length).toBeGreaterThanOrEqual(1);
  });

  test('notifyRunBlocked registers auto-subscription for runs blocked via direct transitionStatus (markFailed / gate rejection paths)', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

    // Seed gate data with PR URL.
    ctx.gateDataRepo.merge(run.id, 'approval', { pr_url: PR_URL });
    // Mark execution in_progress so the slot fallback resolves.
    const execution = ctx.nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    const sessionId = `session-markfailed-${run.id}`;
    ctx.nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: sessionId,
      startedAt: Date.now(),
    });
    ctx.tam.alive.add(sessionId);

    // Simulate markFailed RPC: direct transitionStatus + notifyRunBlocked.
    ctx.workflowRunRepo.transitionStatus(run.id, 'blocked');
    await ctx.service.notifyRunBlocked(run.id);

    // Publishing a PR event must now match and deliver.
    const event: ExternalEvent = {
      id: `evt-markfailed-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-markfailed-${Math.random().toString(36).slice(2)}`,
      summary: 'Codex approved',
      payload: {},
    };
    await ctx.eventService.publish(event);
    expect(ctx.injected.length).toBeGreaterThanOrEqual(1);
  });

  test('onBlockedRunExternalEvent respects spaceId — cross-space PR events do not fire gate re-eval', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Pre-satisfy the gate so any re-eval would open it.
    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });

    // Publish the PR event under a DIFFERENT space id via the bus directly
    // (bypassing ExternalEventStore which has an FK on spaceId). The
    // auto-subscription matches by topic, but the hook must reject the run
    // because its spaceId does not match the event's spaceId.
    await (
      ctx.service.runtime as unknown as {
        internalEventBus: {
          publish: (event: string, payload: unknown) => Promise<unknown>;
        };
      }
    ).internalEventBus.publish('externalEvent.published', {
      namespaceId: 'space-other',
      spaceId: 'space-other',
      eventId: `evt-x-space-${Math.random().toString(36).slice(2)}`,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      dedupeKey: `dedupe-x-space-${Math.random().toString(36).slice(2)}`,
      summary: 'cross-space',
      payload: {},
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
    });
    // Let the fire-and-forget hook chain drain.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Hook skipped at the runtime guard (run.spaceId !== payload.spaceId)
    // so the run stays blocked and no notification fires.
    expect(ctx.workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(ctx.runtimeNotifications).toHaveLength(0);
  });

  test('transitionBlockedRunToInProgress clears stale failureReason on resume', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);
    // Confirm the seeded failureReason is what we expect to clear.
    expect(ctx.workflowRunRepo.getRun(runId)?.failureReason).toBe('agentCrash');

    // Pre-satisfy the gate so the event-driven re-eval opens it.
    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });

    await ctx.service.handleBlockedRunExternalEvent({
      runId,
      event: {
        namespaceId: SPACE_ID,
        spaceId: SPACE_ID,
        eventId: `evt-clear-reason-${Math.random().toString(36).slice(2)}`,
        source: 'github',
        topic: PR_EVENT_TOPIC,
        dedupeKey: `dedupe-clear-reason-${Math.random().toString(36).slice(2)}`,
        summary: 'Codex approved',
        payload: {},
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
      },
    });
    // Let the fire-and-forget hook chain drain.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = ctx.workflowRunRepo.getRun(runId);
    expect(updated?.status).toBe('in_progress');
    // failureReason must be cleared (repo maps NULL → undefined on read).
    expect(updated?.failureReason ?? null).toBeNull();
  });

  test('onBeforeRedispatch hook fires inside the first executeTick before redispatch sweep', async () => {
    const calls: number[] = [];
    // Construct a runtime directly so we can inject the hook before start().
    const db = makeDb();
    const workflowRunRepo = new SpaceWorkflowRunRepository(db);
    const taskRepo = new SpaceTaskRepository(db);
    const nodeExecutionRepo = new NodeExecutionRepository(db);
    const workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    const bus = new InternalEventBus<DaemonInternalEventMap>();
    const commandBus = createInternalCommandBus();
    const runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      commandBus,
      externalEventStore: new ExternalEventStore(db),
      tickIntervalMs: 60_000,
      onBeforeRedispatch: async () => {
        calls.push(Date.now());
      },
    });
    // Bypass the normal start() path (which would also schedule ticks) and
    // drive executeTick directly so the recovery branch runs once.
    await runtime.executeTick();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test('handleGateDataChangedComplete resumes the run when a deferred retry opens a gate', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);
    // Pre-satisfy the gate so notifyGateDataChanged opens it on the next eval.
    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });

    // Simulate the deferred-retry path: it calls notifyGateDataChanged
    // directly (not the public handleBlockedRunExternalEvent entry point),
    // so the only post-hook that runs is onGateDataChangedComplete.
    await ctx.service.notifyGateDataChanged(runId, 'approval');
    // Let the fire-and-forget resume chain drain.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The complete-hook must have transitioned the run out of blocked.
    expect(ctx.workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
  });

  test('promoteCanonicalTaskAfterRunResume clears stale blockReason and result', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Seed stale block metadata on the canonical task.
    const tasks = ctx.taskRepo.listByWorkflowRun(runId);
    const canonical = tasks[0]!;
    ctx.taskRepo.updateTask(canonical.id, {
      status: 'blocked',
      blockReason: 'gate_rejected',
      result: 'Gate rejected',
      pendingCheckpointType: 'gate',
    });

    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });
    await ctx.service.handleBlockedRunExternalEvent({
      runId,
      event: {
        namespaceId: SPACE_ID,
        spaceId: SPACE_ID,
        eventId: `evt-clear-meta-${Math.random().toString(36).slice(2)}`,
        source: 'github',
        topic: PR_EVENT_TOPIC,
        dedupeKey: `dedupe-clear-meta-${Math.random().toString(36).slice(2)}`,
        summary: 'Codex approved',
        payload: {},
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = ctx.taskRepo.getTask(canonical.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.blockReason ?? null).toBeNull();
    expect(updated?.result ?? null).toBeNull();
    expect(updated?.pendingCheckpointType ?? null).toBeNull();
  });

  test('transitionRunStatusAndEmit preserves PR auto-subscription when run leaves blocked for in_progress', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId, coderSessionId } = await seedBlockedRunWithPr(ctx, workflow.id);
    await ctx.service.notifyRunBlocked(runId);

    const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);
    await (
      runtime as unknown as {
        transitionRunStatusAndEmit(runId: string, nextStatus: 'in_progress'): Promise<unknown>;
      }
    ).transitionRunStatusAndEmit(runId, 'in_progress');

    const targets = (
      runtime as unknown as {
        lookupSubscriptionTargets(topic: string): Array<{
          workflowRunId?: string;
          subscriptionKind?: string;
        }>;
      }
    ).lookupSubscriptionTargets(PR_EVENT_TOPIC);
    expect(targets.some((t) => t.workflowRunId === runId && t.subscriptionKind === 'auto')).toBe(
      true
    );

    ctx.injected.length = 0;
    const event: ExternalEvent = {
      id: `evt-after-resume-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-after-resume-${Math.random().toString(36).slice(2)}`,
      summary: 'review comment while in_progress',
      payload: {},
    };
    await ctx.eventService.publish(event);
    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]!.sessionId).toBe(coderSessionId);
  });

  test('transitionRunStatusAndEmit clears PR auto-subscription on terminal transitions', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);

    for (const terminalStatus of ['cancelled', 'done'] as const) {
      const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);
      const task = ctx.taskRepo.listByWorkflowRun(runId)[0]!;
      await ctx.service.notifyRunBlocked(runId);

      if (terminalStatus === 'done') {
        await (
          runtime as unknown as {
            transitionRunStatusAndEmit(runId: string, nextStatus: 'in_progress'): Promise<unknown>;
          }
        ).transitionRunStatusAndEmit(runId, 'in_progress');
        // Block the task so reconcileTerminalRunTasks skips dispatchPostApproval
        // while still allowing clearRunInterests to run.
        ctx.taskRepo.updateTask(task.id, { status: 'blocked' });
      }
      await (
        runtime as unknown as {
          transitionRunStatusAndEmit(
            runId: string,
            nextStatus: 'cancelled' | 'done'
          ): Promise<unknown>;
        }
      ).transitionRunStatusAndEmit(runId, terminalStatus);

      if (terminalStatus === 'done') {
        await runtime.executeTick();
      }

      const targets = (
        runtime as unknown as {
          lookupSubscriptionTargets(topic: string): Array<{
            workflowRunId?: string;
            subscriptionKind?: string;
          }>;
        }
      ).lookupSubscriptionTargets(PR_EVENT_TOPIC);
      expect(targets.some((t) => t.workflowRunId === runId && t.subscriptionKind === 'auto')).toBe(
        false
      );

      ctx.injected.length = 0;
      const event: ExternalEvent = {
        id: `evt-after-${terminalStatus}-${Math.random().toString(36).slice(2)}`,
        spaceId: SPACE_ID,
        source: 'github',
        topic: PR_EVENT_TOPIC,
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
        dedupeKey: `dedupe-after-${terminalStatus}-${Math.random().toString(36).slice(2)}`,
        summary: `stale event after ${terminalStatus}`,
        payload: {},
      };
      await ctx.eventService.publish(event);
      expect(ctx.injected).toHaveLength(0);
    }
  });

  test('handleBlockedRunExternalEvent does not treat a previously-open unrelated gate as newly opened', async () => {
    // Multi-gate workflow: gate A was already open before the run blocked.
    // gate B is the still-closed blocking gate a PR event should re-evaluate.
    // The PR event does NOT open B; only A remains open. The handler must
    // NOT treat A's pre-existing open state as a new gate-open signal that
    // triggers resume + auto-sub clear.
    const db = makeDb();
    const workflowRunRepo = new SpaceWorkflowRunRepository(db);
    const taskRepo = new SpaceTaskRepository(db);
    const nodeExecutionRepo = new NodeExecutionRepository(db);
    const gateDataRepo = new GateDataRepository(db);
    const gateOpenStateRepo = new GateOpenStateRepository(db);
    const channelCycleRepo = new ChannelCycleRepository(db);
    const workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    const bus = new InternalEventBus<DaemonInternalEventMap>();
    const commandBus = createInternalCommandBus();
    const eventStore = new ExternalEventStore(db);
    const eventService = new ExternalEventService(eventStore, bus);
    const injected: Array<{ sessionId: string; message: string }> = [];
    commandBus.register('agent.message.inject', async (command) => {
      injected.push({ sessionId: command.sessionId, message: command.message });
      return { ok: true };
    });
    const tam = new TaskAgentManagerStub();
    const runtimeNotifications: string[] = [];
    tam.injectRuntimeRecoveryMessage = async (_sid, msg) => {
      runtimeNotifications.push(msg);
      return 'ok';
    };

    const service = new SpaceRuntimeService({
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      tickIntervalMs: 60_000,
      gateDataRepo,
      gateOpenStateRepo,
      channelCycleRepo,
      internalEventBus: bus,
      commandBus,
      externalEventStore: eventStore,
    });
    service.setTaskAgentManager(tam as unknown as TaskAgentManager);

    // Two gates: gate A (already-open) and gate B (the blocking one).
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Multi-Gate ${Math.random()}`,
      description: '',
      nodes: [
        { id: 'code', name: 'Code', agents: [{ agentId: AGENT_ID, name: 'coder' }] },
        { id: 'review', name: 'Review', agents: [{ agentId: AGENT_ID, name: 'reviewer' }] },
      ],
      transitions: [],
      startNodeId: 'code',
      rules: [],
      tags: [],
      gates: [
        {
          id: 'gate-a',
          fields: [
            { name: 'approved', type: 'boolean', writers: [], check: { op: '==', value: true } },
          ],
        },
        {
          id: 'gate-b',
          fields: [
            { name: 'approved', type: 'boolean', writers: [], check: { op: '==', value: true } },
            prUrlField,
          ],
        },
      ],
      channels: [
        { id: 'ch-a', from: 'coder', to: 'reviewer', gateId: 'gate-a' },
        { id: 'ch-b', from: 'coder', to: 'reviewer', gateId: 'gate-b' },
      ],
    });

    const runtime = await service.createOrGetRuntime(SPACE_ID);
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: `session-${run.id}`,
      startedAt: Date.now(),
    });
    tam.alive.add(`session-${run.id}`);

    // Pre-open gate A (the unrelated gate). Gate B stays closed.
    gateDataRepo.merge(run.id, 'gate-a', { approved: true, approvedAt: Date.now() });
    await service.notifyGateDataChanged(run.id, 'gate-a');
    expect(gateOpenStateRepo.isOpen(run.id, 'gate-a').open).toBe(true);

    // Block the run + persist pr_url for the auto-subscribe.
    gateDataRepo.merge(run.id, 'gate-b', { pr_url: PR_URL });
    workflowRunRepo.transitionStatus(run.id, 'blocked');

    // Publish a PR event. Re-evaluates both gates. gate A is still open
    // (unchanged), gate B is still closed. anyOpened must stay false.
    const event: ExternalEvent = {
      id: `evt-multi-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-multi-${Math.random().toString(36).slice(2)}`,
      summary: 'irrelevant PR event',
      payload: {},
    };
    await eventService.publish(event);
    // Let the awaited hook chain drain.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run stays blocked — gate B did not open.
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
    // No courtesy notification fired.
    expect(runtimeNotifications).toHaveLength(0);
  });

  test('clearPrEventSubscriptionsForRun removes in-memory queued deliveries for the auto target', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Make the execution target queueable but not yet deliverable so a PR
    // event gets queued rather than delivered immediately.
    const execution = ctx.nodeExecutionRepo.listByNode(runId, 'code')[0]!;
    ctx.nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: null,
      completedAt: null,
    });
    // Re-mark active session id AFTER cleared, so the slot exists but has no
    // live session yet — exercise the queueing path.
    ctx.nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: `session-queued-${runId}`,
      completedAt: null,
    });
    ctx.tam.alive.delete(`session-queued-${runId}`); // ensure not "live"

    const event: ExternalEvent = {
      id: `evt-queued-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-queued-${Math.random().toString(36).slice(2)}`,
      summary: 'Queued delivery',
      payload: {},
    };
    ctx.service.runtime.ensurePrEventSubscriptionForRun(runId);
    await ctx.eventService.publish(event);
    expect(ctx.eventStore.listDeliveries(event.id)).toHaveLength(1);

    const pendingQueues = ctx.service.runtime as unknown as {
      pendingExternalEventQueue: Map<string, unknown[]>;
    };

    // Now clear the auto subscription. Queued deliveries for the auto target
    // must be purged so a later session spawn does not flush a stale
    // delivery for a subscription that no longer exists.
    ctx.service.runtime.clearPrEventSubscriptionsForRun(runId);
    expect(pendingQueues.pendingExternalEventQueue.size).toBe(0);

    // Re-attach a live session. The delivery for this event is no longer
    // pending after the clear, so flushing the pending queue must not
    // re-deliver it. Reset the captured injections so the assertion is scoped
    // to the flush rather than the initial publish-time delivery.
    ctx.injected.length = 0;
    ctx.tam.alive.add(`session-queued-${runId}`);
    ctx.service.runtime.flushPendingNodeQueue({
      workflowRunId: runId,
      taskId: ctx.taskRepo.listByWorkflowRun(runId)[0]!.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: `session-queued-${runId}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.injected).toHaveLength(0);
  });

  test('P1 regression: approve gate then reject clears the gate-open cache so deliverMessage does not bypass', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const runtime = await ctx.service.createOrGetRuntime(SPACE_ID);
    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = ctx.nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    ctx.nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: `session-p1-${run.id}`,
      startedAt: Date.now(),
    });
    ctx.tam.alive.add(`session-p1-${run.id}`);

    // Approve the gate — caches open=true.
    ctx.gateDataRepo.merge(run.id, 'approval', { approved: true, approvedAt: Date.now() });
    await ctx.service.notifyGateDataChanged(run.id, 'approval');
    expect(new GateOpenStateRepository(ctx.db).isOpen(run.id, 'approval').open).toBe(true);

    // Reject via the same gate-data write path that approveGate RPC uses.
    ctx.gateDataRepo.merge(run.id, 'approval', {
      approved: false,
      rejectedAt: Date.now(),
      reason: 'tester rejected',
      approvalSource: 'human',
    });
    // Mirror the rejection-path side effects: transition to blocked clears
    // the gate-open cache via workflowRunRepo.transitionStatus.
    ctx.workflowRunRepo.transitionStatus(run.id, 'blocked');

    // Cache must now report closed — a subsequent deliverMessage must not
    // bypass the rejected gate.
    expect(new GateOpenStateRepository(ctx.db).isOpen(run.id, 'approval').open).toBe(false);
  });

  test('P2-1: fireBlockedRunExternalEventHook skips paused spaces', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);

    // Pre-satisfy the gate so any re-eval would open it.
    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });

    // Pause the space directly via DB.
    ctx.db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);

    const event: ExternalEvent = {
      id: `evt-paused-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-paused-${Math.random().toString(36).slice(2)}`,
      summary: 'during pause',
      payload: {},
    };
    await ctx.eventService.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run stays blocked — paused space skipped the resume chain.
    expect(ctx.workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(ctx.runtimeNotifications).toHaveLength(0);
  });

  test('P2-2: PR event delivered during blocked hook is delivered once after gate opens', async () => {
    const ctx = await setup({
      gates: [
        {
          id: 'approval',
          fields: [approvedField, prUrlField],
        },
      ],
      channels: [{ id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' }],
    });
    const workflow = ctx.workflowManager.listWorkflows(SPACE_ID)[0]!;
    const { runId } = await seedBlockedRunWithPr(ctx, workflow.id);
    // Pre-satisfy the gate so the hook opens it during event processing.
    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });

    const event: ExternalEvent = {
      id: `evt-stale-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-stale-${Math.random().toString(36).slice(2)}`,
      summary: 'wake-up event',
      payload: {},
    };
    await ctx.eventService.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The hook preserved/refreshed the auto-sub and transitioned the run to
    // in_progress. The event should be delivered once to the active slot, not
    // dropped as a stale auto-target snapshot.
    expect(ctx.injected).toHaveLength(1);
    expect(ctx.eventStore.getById(event.id)?.state).toBe('delivered');
  });
});
