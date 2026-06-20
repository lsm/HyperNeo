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
import type { SpaceWorkflow } from '@neokai/shared';
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

    // After the gate opens, subsequent PR events should not deliver (subscription cleared).
    ctx.injected.length = 0;
    const followUp: ExternalEvent = {
      id: `evt-followup-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-followup-${Math.random().toString(36).slice(2)}`,
      summary: 'Stale event after gate opened',
      payload: { action: 'review_submitted' },
    };
    await ctx.eventService.publish(followUp);
    expect(ctx.injected).toHaveLength(0);
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
});
