import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { createInternalCommandBus } from '../../../../src/lib/internal-command-bus';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

setDefaultTimeout(10_000);

const SPACE_ID = 'space-admission-parity';
const AGENT_ID = 'agent-admission-parity';
const DEFAULT_TOPIC = 'github/*/*/pull_request/*.review_*';

type TranscriptEntry = string;
type TranscriptExpectation = string | RegExp;

function makeDb(): Database {
  const db = new Database(':memory:');
  createSpaceTables(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(SPACE_ID, SPACE_ID, '/tmp/admission-parity', 'Admission Parity', now, now);
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
  activationCalls: Array<{ taskId: string; workflowRunId: string; agentName: string }> = [];
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
    agentName: string
  ): Promise<Array<{ agentName: string; sessionId: string }>> {
    this.activationCalls.push({ taskId, workflowRunId, agentName });
    if (this.activationError) throw this.activationError;
    this.onActivate?.();
    for (const result of this.activationResult) {
      this.alive.add(result.sessionId);
    }
    return this.activationResult;
  }

  async spawnWorkflowNodeAgentForExecution(execution: { id: string }): Promise<string> {
    const sessionId = `session-${execution.id}`;
    this.alive.add(sessionId);
    return sessionId;
  }
}

function expectTranscript(actual: TranscriptEntry[], expected: TranscriptExpectation[]): void {
  const matches =
    actual.length === expected.length &&
    expected.every((entry, index) =>
      typeof entry === 'string' ? actual[index] === entry : entry.test(actual[index] ?? '')
    );
  if (!matches) {
    throw new Error(
      `transcript mismatch\n--- actual ---\n${actual.join('\n')}\n--- expected ---\n${expected.map(String).join('\n')}`
    );
  }
}

describe('SpaceRuntime external-event admission parity', () => {
  const decisions: string[] = [];
  let db: Database;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let workflowManager: SpaceWorkflowManager;
  let runtime: SpaceRuntime;
  let eventStore: ExternalEventStore;
  let eventService: ExternalEventService;
  let tam: MockTaskAgentManager;
  let bus: ReturnType<typeof createDaemonInternalEventBus>;
  let transcript: TranscriptEntry[];
  let injectShouldFail: boolean;
  let injectGate: { promise: Promise<void>; release: () => void } | null;

  function createWorkflow(nodeId = 'code'): SpaceWorkflow {
    return workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Workflow ${Math.random()}`,
      description: '',
      nodes: [
        {
          id: nodeId,
          name: 'Code',
          agents: [{ agentId: AGENT_ID, name: 'coder' }],
        },
      ],
      transitions: [],
      startNodeId: nodeId,
      rules: [],
      tags: [],
    });
  }

  async function startRunWithSubscription(
    topic = DEFAULT_TOPIC
  ): Promise<{ run: { id: string }; task: SpaceTask }> {
    const workflow = createWorkflow();
    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const task = tasks[0]!;
    runtime.registerSubscription(run.id, task.id, 'code', 'coder', topic);
    return { run, task };
  }

  function markExecution(
    runId: string,
    update: {
      status: string;
      agentSessionId?: string;
    }
  ): void {
    const execution = nodeExecutionRepo.listByNode(runId, 'code')[0]!;
    nodeExecutionRepo.update(execution.id, {
      status: update.status as never,
      ...(update.agentSessionId ? { agentSessionId: update.agentSessionId } : {}),
      startedAt: Date.now(),
    });
  }

  function toPublishedPayload(event: ExternalEvent): Record<string, unknown> {
    return {
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
    };
  }

  function deliveryKeyFor(event: ExternalEvent, taskId: string, runId: string): string {
    return JSON.stringify([event.source, event.dedupeKey, taskId, 'code', 'coder', runId]);
  }

  function targetFor(taskId: string, runId: string): Record<string, unknown> {
    return { workflowRunId: runId, taskId, nodeId: 'code', agentName: 'coder' };
  }

  async function callDeliverToWorkflowTarget(
    target: Record<string, unknown>,
    event: ExternalEvent,
    deliveryKey: string
  ): Promise<void> {
    await (
      runtime as unknown as {
        deliverExternalEventToWorkflowTarget: (
          target: unknown,
          payload: unknown,
          deliveryKey: string
        ) => Promise<void>;
      }
    ).deliverExternalEventToWorkflowTarget(target, toPublishedPayload(event), deliveryKey);
  }

  function instrument(target: object, key: string, record: (...args: never[]) => void): void {
    const holder = target as Record<string, (...args: never[]) => unknown>;
    const original = holder[key]!;
    holder[key] = function (this: unknown, ...args: never[]) {
      record(...args);
      return original.apply(this, args);
    } as (...args: never[]) => unknown;
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
    tam = new MockTaskAgentManager();
    transcript = [];
    injectShouldFail = false;
    injectGate = null;

    commandBus.register('agent.message.inject', async (command) => {
      transcript.push(`inject:${command.sessionId}:${command.deliveryMode}`);
      if (injectGate) await injectGate.promise;
      if (injectShouldFail) {
        return { ok: false, error: 'recoverable injection failure' };
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
      commandBus,
      externalEventStore: eventStore,
      taskAgentManager: tam as never,
    });

    const rt = runtime as unknown as Record<string, (...args: never[]) => unknown>;
    const prep = rt['prepareExternalEventTask']!;
    rt['prepareExternalEventTask'] = function (this: unknown, ...args: never[]) {
      const result = prep.apply(this, args) as { action: string };
      decisions.push(result.action);
      return result;
    } as (...args: never[]) => unknown;

    instrument(runtime, 'queueForPendingNode', (...args: never[]) => {
      transcript.push(`queue:${(args[3] as string | undefined) ?? 'immediate'}`);
    });
    instrument(runtime, 'scheduleActivationRetry', (...args: never[]) => {
      const options = (args[4] ?? {}) as { preserveAttemptCount?: boolean };
      transcript.push(`retry:${args[3]}${options.preserveAttemptCount ? ':preserve' : ''}`);
    });
    instrument(runtime, 'scheduleExternalEventRetry', (...args: never[]) => {
      transcript.push(`retryExternal:${args[4]}`);
    });
    instrument(runtime, 'clearExternalEventRetry', () => {
      transcript.push('clearRetry');
    });
    instrument(runtime, 'clearQueuedDelivery', () => {
      transcript.push('clearQueued');
    });
    instrument(runtime, 'activateSubscribedTargetForExternalEvent', () => {
      transcript.push('activate');
    });
    instrument(runtime, 'normalizeStaleInterruptedSession', () => {
      transcript.push('normalize');
    });
    instrument(runtime, 'deliverDigestToSession', () => {
      transcript.push('digestFlush');
    });

    instrument(eventStore, 'markDeliveryFailed', (...args: never[]) => {
      const options = args[2] as { terminal: boolean; reason: string };
      transcript.push(`fail:${options.terminal ? 'terminal' : 'recoverable'}:${options.reason}`);
    });
    instrument(eventStore, 'markDeliveryDelivered', () => {
      transcript.push('delivered');
    });
    instrument(eventStore, 'markEventFailedIfAllDeliveriesTerminal', () => {
      transcript.push('eventFailedIfAll');
    });
    instrument(eventStore, 'markEventDeliveredIfAllDeliveriesDelivered', () => {
      transcript.push('eventDeliveredIfAll');
    });
  });

  afterEach(async () => {
    await runtime.stop();
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function liveSession(runId: string, sessionId: string, status = 'idle'): void {
    markExecution(runId, { status: 'in_progress', agentSessionId: sessionId });
    tam.alive.add(sessionId);
    tam.processingStates.set(sessionId, status);
  }

  test('live idle session: defer flush delivers with delivered marks', async () => {
    const { run } = await startRunWithSubscription();
    liveSession(run.id, 'session-live-idle');

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'normalize',
      'clearRetry',
      'inject:session-live-idle:defer',
      'clearRetry',
      'clearQueued',
      'delivered',
      'eventDeliveredIfAll',
      'eventFailedIfAll',
    ]);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
  });

  test('live mid-interrupt session: parked with preserved retry, no inject, no normalize effect', async () => {
    const { run } = await startRunWithSubscription();
    liveSession(run.id, 'session-mid-interrupt', 'interrupted');
    tam.interrupting.add('session-mid-interrupt');

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'normalize',
      'queue:defer',
      'retry:deliveryMode:defer; target_session_interrupted:preserve',
      'fail:recoverable:deliveryMode:defer; target_session_interrupted',
    ]);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    expect(delivery.failureReason).toBe('deliveryMode:defer; target_session_interrupted');
    expect(tam.processingStates.get('session-mid-interrupt')).toBe('interrupted');
  });

  test('stale interrupted session: normalize runs, then defer flush delivers', async () => {
    const { run } = await startRunWithSubscription();
    liveSession(run.id, 'session-stale-interrupt', 'interrupted');

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'normalize',
      'clearRetry',
      'inject:session-stale-interrupt:defer',
      'clearRetry',
      'clearQueued',
      'delivered',
      'eventDeliveredIfAll',
      'eventFailedIfAll',
    ]);
    expect(tam.processingStates.get('session-stale-interrupt')).toBe('idle');
  });

  test('live session with paused space: recoverable defer mark only, no normalize, no cleanup', async () => {
    const { run } = await startRunWithSubscription();
    liveSession(run.id, 'session-paused');
    db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
    runtime.holdSpaceDeliveries(SPACE_ID);

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, ['fail:recoverable:deliveryMode:defer; space_paused']);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('pending');
    expect(delivery.failureReason).toBe('deliveryMode:defer; space_paused');
    expect(runtime.getQueueHealthSnapshot().counters.pausedSpaceSkips).toBeGreaterThanOrEqual(1);

    db.prepare(`UPDATE spaces SET paused = 0 WHERE id = ?`).run(SPACE_ID);
  });

  test('bound but dead session: stale-skip metric, still flushes and injects defer', async () => {
    const { run } = await startRunWithSubscription();
    markExecution(run.id, { status: 'in_progress', agentSessionId: 'session-dead' });
    tam.processingStates.set('session-dead', 'idle');

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'clearRetry',
      'inject:session-dead:defer',
      'clearRetry',
      'clearQueued',
      'delivered',
      'eventDeliveredIfAll',
      'eventFailedIfAll',
    ]);
    expect(runtime.getQueueHealthSnapshot().counters.staleSessionSkips).toBeGreaterThanOrEqual(1);
  });

  test('pending execution: queued with preserved retry, no inject', async () => {
    const { run } = await startRunWithSubscription();
    markExecution(run.id, { status: 'pending' });

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'queue:defer',
      'retry:deliveryMode:defer; node_execution_pending:preserve',
      'fail:recoverable:deliveryMode:defer; node_execution_pending',
    ]);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
  });

  test('waiting_rebind execution: queued with preserved retry, no inject', async () => {
    const { run } = await startRunWithSubscription();
    markExecution(run.id, { status: 'waiting_rebind' });

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'queue:defer',
      'retry:deliveryMode:defer; node_execution_pending:preserve',
      'fail:recoverable:deliveryMode:defer; node_execution_pending',
    ]);
  });

  test('blocked execution: activation declined, queued with counting retry and recoverable mark', async () => {
    const { run } = await startRunWithSubscription();
    markExecution(run.id, { status: 'blocked' });

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'activate',
      'queue:defer',
      'retry:deliveryMode:defer; node_execution_not_active',
      'fail:recoverable:deliveryMode:defer; node_execution_not_active',
    ]);
    expect(tam.activationCalls).toHaveLength(0);
  });

  test('activation success: normalize, then defer flush delivers', async () => {
    const { run } = await startRunWithSubscription();
    markExecution(run.id, { status: 'in_progress' });
    tam.activationResult = [{ agentName: 'coder', sessionId: 'session-activated' }];
    tam.processingStates.set('session-activated', 'idle');
    tam.onActivate = () => {
      markExecution(run.id, { status: 'in_progress', agentSessionId: 'session-activated' });
    };

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'activate',
      'normalize',
      'clearRetry',
      'inject:session-activated:defer',
      'clearRetry',
      'clearQueued',
      'delivered',
      'eventDeliveredIfAll',
      'eventFailedIfAll',
    ]);
    expect(tam.activationCalls).toHaveLength(1);
  });

  test('activation failure: queued with activation_failed counting retry', async () => {
    const { run } = await startRunWithSubscription();
    markExecution(run.id, { status: 'in_progress' });
    tam.activationError = new Error('boom');

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'activate',
      'queue:defer',
      'retry:deliveryMode:defer; activation_failed; boom',
      'fail:recoverable:deliveryMode:defer; activation_failed; boom',
    ]);
    expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
  });

  test('activation without session: double recoverable mark around counting retry', async () => {
    const { run } = await startRunWithSubscription();
    markExecution(run.id, { status: 'in_progress' });
    tam.activationResult = [];

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'activate',
      'fail:recoverable:deliveryMode:defer; node_execution_not_active',
      'retry:deliveryMode:defer; node_execution_not_active',
      'fail:recoverable:deliveryMode:defer; node_execution_not_active',
    ]);
  });

  test('cancelled task: terminal fail with cleanup', async () => {
    const { run, task } = await startRunWithSubscription();
    liveSession(run.id, 'session-cancelled-task');
    taskRepo.updateTask(task.id, { status: 'cancelled' });

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, [
      'fail:terminal:target_task_terminal',
      'eventFailedIfAll',
      'clearRetry',
      'clearQueued',
    ]);
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('missing task: terminal invalid_target_ownership with cleanup', async () => {
    const { run, task } = await startRunWithSubscription();
    liveSession(run.id, 'session-missing-task');
    const event = makeEvent();
    eventStore.store(event);
    const deliveryKey = deliveryKeyFor(event, task.id, run.id);
    eventStore.registerExpectedDelivery(event.id, deliveryKey, {
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
    });
    db.prepare(`DELETE FROM space_tasks WHERE id = ?`).run(task.id);
    transcript.length = 0;

    await callDeliverToWorkflowTarget(targetFor(task.id, run.id), event, deliveryKey);

    expectTranscript(transcript, [
      'fail:terminal:invalid_target_ownership',
      'eventFailedIfAll',
      'clearRetry',
      'clearQueued',
    ]);
    expect(eventStore.getById(event.id)?.state).toBe('failed');
  });

  test('removed subscription: terminal fail with cleanup', async () => {
    const { run, task } = await startRunWithSubscription();
    liveSession(run.id, 'session-unsubscribed');
    runtime.unregisterSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

    const event = makeEvent();
    await eventService.publish(event);

    expectTranscript(transcript, []);
    expect(eventStore.getById(event.id)?.state).toBe('published');
    expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
  });

  test('subscription removed after registration: terminal fail when delivery attempted directly', async () => {
    const { run, task } = await startRunWithSubscription();
    liveSession(run.id, 'session-late-unsub');
    const event = makeEvent();
    eventStore.store(event);
    const deliveryKey = deliveryKeyFor(event, task.id, run.id);
    eventStore.registerExpectedDelivery(event.id, deliveryKey, {
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
    });
    runtime.unregisterSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    transcript.length = 0;

    await callDeliverToWorkflowTarget(targetFor(task.id, run.id), event, deliveryKey);

    expectTranscript(transcript, [
      'fail:terminal:subscription_no_longer_active',
      'eventFailedIfAll',
      'clearRetry',
      'clearQueued',
    ]);
  });

  test('terminal delivery: skipped without effects', async () => {
    const { run, task } = await startRunWithSubscription();
    liveSession(run.id, 'session-terminal');
    const event = makeEvent();
    eventStore.store(event);
    const deliveryKey = deliveryKeyFor(event, task.id, run.id);
    eventStore.registerExpectedDelivery(event.id, deliveryKey, {
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
    });
    eventStore.markDeliveryFailed(event.id, deliveryKey, {
      terminal: true,
      reason: 'subscription_no_longer_active',
    });
    transcript.length = 0;

    await callDeliverToWorkflowTarget(targetFor(task.id, run.id), event, deliveryKey);

    expectTranscript(transcript, []);
  });

  test('in-flight claim conflict: second dispatch skipped with metric', async () => {
    const { run, task } = await startRunWithSubscription();
    liveSession(run.id, 'session-inflight');
    let release: () => void = () => {};
    injectGate = { promise: new Promise<void>((r) => (release = r)), release };

    const event = makeEvent();
    const first = eventService.publish(event);
    await tick();

    const deliveryKey = deliveryKeyFor(event, task.id, run.id);
    transcript.length = 0;
    await callDeliverToWorkflowTarget(targetFor(task.id, run.id), event, deliveryKey);

    expectTranscript(transcript, []);
    expect(runtime.getQueueHealthSnapshot().counters.claimConflicts).toBeGreaterThanOrEqual(1);

    release();
    await first;
  });

  test('recoverable inject failure: cooldown armed, queued with external retry', async () => {
    const { run } = await startRunWithSubscription();
    liveSession(run.id, 'session-cooldown');
    injectShouldFail = true;

    const event = makeEvent();
    await eventService.publish(event);
    await tick();

    expectTranscript(transcript, [
      'normalize',
      'clearRetry',
      'inject:session-cooldown:defer',
      'fail:recoverable:deliveryMode:defer; recoverable injection failure',
      'queue:defer',
      'retryExternal:deliveryMode:defer; recoverable injection failure',
    ]);

    transcript.length = 0;
    await eventService.publish(event);
    await tick();

    expectTranscript(transcript, []);
    expect(runtime.getQueueHealthSnapshot().counters.cooldownSkips).toBeGreaterThanOrEqual(1);
  });

  test('missing command bus: terminal failure with cleanup', async () => {
    const { run } = await startRunWithSubscription();
    liveSession(run.id, 'session-no-bus');

    const rt = runtime as unknown as { config: { commandBus?: unknown } };
    const originalBus = rt.config.commandBus;
    rt.config.commandBus = undefined;

    const event = makeEvent();
    await eventService.publish(event);

    rt.config.commandBus = originalBus;

    expectTranscript(transcript, [
      'normalize',
      'clearRetry',
      /^fail:terminal:deliveryMode:defer; .*/,
      'clearRetry',
      'clearQueued',
      'eventFailedIfAll',
    ]);
    const delivery = eventStore.listDeliveries(event.id)[0]!;
    expect(delivery.state).toBe('failed');
    expect(delivery.failureReason).toContain('agent.message.inject');
  });

  test('flush of queued delivery: injects defer with delivered marks', async () => {
    const { run, task } = await startRunWithSubscription();
    markExecution(run.id, { status: 'pending' });

    const event = makeEvent();
    await eventService.publish(event);
    expectTranscript(transcript, [
      'queue:defer',
      'retry:deliveryMode:defer; node_execution_pending:preserve',
      'fail:recoverable:deliveryMode:defer; node_execution_pending',
    ]);

    transcript.length = 0;
    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-flush',
    });
    await tick();

    expectTranscript(transcript, [
      'clearRetry',
      'inject:session-flush:defer',
      'clearRetry',
      'clearQueued',
      'delivered',
      'eventDeliveredIfAll',
      'eventFailedIfAll',
    ]);
    expect(eventStore.getById(event.id)?.state).toBe('delivered');
  });

  test('flush after unsubscribe: terminal subscription failure from the flush gate', async () => {
    const { run, task } = await startRunWithSubscription();
    markExecution(run.id, { status: 'pending' });

    const event = makeEvent();
    await eventService.publish(event);
    runtime.unregisterSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
    transcript.length = 0;

    runtime.flushPendingNodeQueue({
      workflowRunId: run.id,
      taskId: task.id,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-flush-unsub',
    });
    await tick();

    expectTranscript(transcript, [
      'fail:terminal:subscription_no_longer_active',
      'eventFailedIfAll',
      'clearRetry',
    ]);
  });

  test('over-rate event: buffered into digest, flushed as one digest inject', async () => {
    const { run } = await startRunWithSubscription();
    liveSession(run.id, 'session-digest');

    for (let i = 0; i < 10; i++) {
      await eventService.publish(makeEvent());
    }
    transcript.length = 0;

    const overflow = makeEvent();
    await eventService.publish(overflow);
    expectTranscript(transcript, ['normalize', 'clearRetry']);

    await tick();
    expectTranscript(transcript.slice(2), [
      'digestFlush',
      'inject:session-digest:defer',
      'clearRetry',
      'clearQueued',
      'delivered',
      'eventDeliveredIfAll',
      'eventFailedIfAll',
    ]);
    expect(eventStore.getById(overflow.id)?.state).toBe('delivered');
  });

  test('digest item with cancelled task: terminal fail at digest flush', async () => {
    const { run, task } = await startRunWithSubscription();
    liveSession(run.id, 'session-digest-cancel');

    for (let i = 0; i < 10; i++) {
      await eventService.publish(makeEvent());
    }
    const overflow = makeEvent();
    await eventService.publish(overflow);

    taskRepo.updateTask(task.id, { status: 'cancelled' });
    transcript.length = 0;
    await tick();

    expectTranscript(transcript, [
      'digestFlush',
      'fail:terminal:target_task_terminal',
      'eventFailedIfAll',
    ]);
    expect(eventStore.getById(overflow.id)?.state).toBe('failed');
  });

  test('decision coverage: the admission matrix only ever produces deliver or fail', () => {
    expect(decisions.length).toBeGreaterThan(10);
    expect(decisions.every((action) => action === 'deliver' || action === 'fail')).toBe(true);
  });
});
