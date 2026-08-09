/**
 * Service-level integration tests for event-driven gate evaluation.
 *
 * Covers the full chain (post #886, after the runtime-owned PR auto-subscription
 * was removed in favor of the coder's prompt-driven dynamic subscription):
 *   coder subscribes via subscribe_pr_events({}) → external event published
 *   → handleBlockedRunExternalEvent → notifyGateDataChanged
 *   → gate opens → session notified + run resumed.
 *
 * Also covers the leak fix: a PR event is delivered only to the coder's explicit
 * subscription, never to a reviewer/QA slot that did not subscribe.
 *
 * Uses real SQLite-backed repos and a real ChannelRouter so the gate
 * activation path is exercised end-to-end. The TaskAgentManager is stubbed
 * to capture injected messages and to keep session liveness state truthful.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
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
import { CodingArtifactProfile } from '../../../../src/lib/space/workflows/coding-artifact-profile';
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
// The topic pattern the coder registers via subscribe_pr_events({}) for its PR.
const CODER_PR_TOPIC_PATTERN = 'github/lsm/neokai/pull_request/42.*';

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
    artifactProfile: new CodingArtifactProfile({ db, gateDataRepo }),
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

  // The coder self-subscribes to its own PR events (subscribe_pr_events({})).
  // This is the prompt-driven dynamic subscription that replaced the runtime's
  // gate-blocked auto-subscription (task #886).
  const task = ctx.taskRepo.listByWorkflowRun(run.id)[0]!;
  runtime.registerSubscription(run.id, task.id, 'code', 'coder', CODER_PR_TOPIC_PATTERN);

  ctx.workflowRunRepo.updateRun(run.id, { status: 'blocked', failureReason: 'agentCrash' });
  // Execution stays in_progress with a live session so the blocked run is
  // still considered deliverable by handleExternalEvent.
  return { runId: run.id, coderSessionId, coderExecutionId: execution.id };
}

describe('SpaceRuntimeService event-driven gate evaluation', () => {
  test('coder prompt-driven dynamic subscription receives matching PR events', async () => {
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

    // Publish a PR event — the coder's dynamic subscription should match and deliver.
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
    void runId;
  });

  test('a PR event is not delivered to a reviewer slot that did not subscribe (leak fix)', async () => {
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

    // The reviewer is the active node (review phase), with a live session but
    // NO subscription — it never called subscribe_pr_events.
    const reviewerExecution = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'review',
      agentName: 'reviewer',
      status: 'in_progress',
      startedAt: Date.now(),
    });
    const reviewerSessionId = `session-reviewer-${run.id}`;
    ctx.nodeExecutionRepo.update(reviewerExecution.id, {
      agentSessionId: reviewerSessionId,
    });
    ctx.tam.alive.add(reviewerSessionId);
    ctx.workflowRunRepo.updateRun(run.id, { status: 'blocked', failureReason: 'agentCrash' });

    const event: ExternalEvent = {
      id: `evt-leak-${Math.random().toString(36).slice(2)}`,
      spaceId: SPACE_ID,
      source: 'github',
      topic: PR_EVENT_TOPIC,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      dedupeKey: `dedupe-leak-${Math.random().toString(36).slice(2)}`,
      summary: 'CI green',
      payload: { action: 'review_submitted' },
    };
    await ctx.eventService.publish(event);

    // No matching subscription → the reviewer session receives nothing and the
    // event is terminally ignored (no auto-subscription attaches to the active
    // reviewer slot).
    expect(ctx.injected.every((entry) => entry.sessionId !== reviewerSessionId)).toBe(true);
    expect(ctx.eventStore.getById(event.id)?.state).toBe('ignored');
  });

  test('handleBlockedRunExternalEvent re-evaluates gates and notifies the session when a gate opens', async () => {
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

  test('handleBlockedRunExternalEvent no-ops when no gate opens', async () => {
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
      artifactProfile: new CodingArtifactProfile({ db, gateDataRepo }),
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
