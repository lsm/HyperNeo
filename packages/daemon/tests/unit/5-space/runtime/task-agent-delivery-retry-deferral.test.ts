/**
 * TaskAgentManager delivery-retry error deferral tests (task #944).
 *
 * A RECOVERABLE provider error during a delivery-driven node-agent turn must be
 * INVISIBLE to Space: the durable message_delivery job retries it (PR #2471),
 * and only the job dead-lettering is terminal. The deferral keys off the JOB
 * ROW (pending/processing = still in flight), not the `session.error` broadcast
 * — which ErrorManager throttles after 3 identical occurrences per 10s (Codex
 * P1 #1) and which unrelated subsystems can fire during an otherwise successful
 * turn (Codex P1 #2). These tests pin `registerCompletionCallback`:
 *   - a recoverable `session.error` does NOT block the node,
 *   - an idle while a delivery job is active is NOT a completion (throttled or
 *     missing error events included),
 *   - `session.delivery_settled` (job completed, nothing in flight) completes
 *     the node — including a successful turn that had an unrelated recoverable
 *     error,
 *   - the dead-letter settlement (`session.error` with no details) and a
 *     genuinely non-recoverable error DO block the node.
 *
 * The session→task→execution link is seeded directly; the listener logic
 * (registerCompletionCallback + handleSubSessionError) is what's under test,
 * exercised through the real internalEventBus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  isCompletedTurnResult,
  isSettledSteerResult,
} from '../../../../src/lib/agent/message-delivery';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { settleMessageDeliveryDeadLetter } from '../../../../src/lib/job-handlers/message-delivery-dead-letter';
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
  /** Durable turn-delivery outcome stand-in for the reconcile path. */
  let turnOutcome: 'completed' | 'dead' | null;
  /** Stand-in: a dead turn row NOT belonging to the stamped kickoff. */
  let deadNonKickoffTurn: boolean;
  /** Stand-in: the kickoff's persisted sdk_messages send_status (null = gone). */
  let kickoffSendStatus: string | null;
  /** Stand-in: a SUCCESS terminal result after the kickoff's consumption. */
  let kickoffTerminalResult: boolean;
  /** Makes the durable-outcome lookup throw N times (catch-path tests). */
  let outcomeThrowBudget: number;
  /** Throw on every ODD lookup instead of consuming a budget. */
  let throwOnOddOutcomeCalls: boolean;
  /** Count of durable-outcome lookups the reconcile performed. */
  let outcomeCalls: number;
  let executionId: string;
  let completed: boolean;
  /** Mutable stand-in for the session's active (pending/processing) delivery-job set. */
  let activeJobs: Set<string>;
  /** Stand-in for jobs currently being DRIVEN (claimed processing). */
  let processingTurnJobs: Set<string>;
  /** Stand-in: the session is inside driveDeliveryTurn (an in-flight drive). */
  let deliveryTurnDriving: boolean;

  beforeEach(() => {
    // Shorten the crash-window reconciliation delay (read at subscribe time in
    // registerCompletionCallback) so the reconciliation tests run in tens of
    // ms. Tests that must stay timer-free keep an active job or rely on paths
    // that do not consult it.
    process.env.HYPERNEO_DELIVERY_SETTLE_RECONCILE_MS = '15';
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

    bus = createDaemonInternalEventBus();

    nodeExecRepo = new NodeExecutionRepository(db);

    activeJobs = new Set(['kickoff-uuid']);
    processingTurnJobs = new Set(['kickoff-uuid']); // the kickoff TURN is being driven
    deliveryTurnDriving = true; // the drive is in flight
    // Stand-in for the durable turn-delivery outcome the reconcile reads
    // (deliveryTurnOutcomeSince): null = no settled turn for this activation.
    turnOutcome = null;
    deadNonKickoffTurn = false;
    kickoffSendStatus = null;
    kickoffTerminalResult = false;
    outcomeThrowBudget = 0;
    throwOnOddOutcomeCalls = false;
    outcomeCalls = 0;
    const config = {
      db: {
        getDatabase: () => db,
        // hasActiveDeliveryJob / reconciliation resolve job state from here.
        getSDKMessageRepo: () => ({
          getDeliveryContent: (_sid: string, uuid: string) =>
            uuid === 'kickoff-uuid' && kickoffSendStatus
              ? { content: 'x', sendStatus: kickoffSendStatus }
              : null,
          hasTerminalResultAfter: (_sid: string, uuid: string) =>
            uuid === 'kickoff-uuid' && kickoffTerminalResult,
        }),
        getJobQueueRepo: () => ({
          activeDeliveryMessageUuids: () => activeJobs,
          hasProcessingDeliveryForSession: () => processingTurnJobs.size > 0,
          hasDeadTurnExcept: () => deadNonKickoffTurn,
          // uuid-correlated: only the stamped kickoff's outcome qualifies.
          deliveryTurnOutcomeSince: (_sid: string, uuid: string) => {
            outcomeCalls++;
            if (outcomeThrowBudget > 0) {
              outcomeThrowBudget--;
              throw new Error('database is locked');
            }
            if (throwOnOddOutcomeCalls && outcomeCalls % 2 === 1) {
              throw new Error('database is locked');
            }
            return uuid === 'kickoff-uuid' ? turnOutcome : null;
          },
        }),
      },
      taskRepo,
      nodeExecutionRepo: nodeExecRepo,
      internalEventBus: bus,
    } as unknown as TaskAgentManagerConfig;
    manager = new TaskAgentManager(config);

    // Seed the execution AFTER the manager so its activation postdates the
    // runtime boot (isPreUpgradeActivation keys on manager construction ≈
    // daemon start — a pre-boot activation is the rollout-compat shape).
    const execution = nodeExecRepo.create({
      workflowRunId: 'run-1',
      workflowNodeId: 'n-1',
      agentName: 'coder',
      agentSessionId: SUB_SESSION_ID,
      status: 'in_progress',
    });
    executionId = execution.id;
    // Stamp this activation's expected kickoff (as spawnWorkflowNodeAgentForExecution
    // does before the first await) so the reconcile can correlate with it.
    nodeExecRepo.update(executionId, { data: { kickoffMessageUuid: 'kickoff-uuid' } });

    // Seed the in-memory session→task map both findParentTaskIdForSubSession and
    // getSubSession resolve through. The fake session reports a non-zero SDK
    // message count so the idle-completion path does not bail as "not started".
    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    subSessions.set(task.id, new Map());
    subSessions.get(task.id)!.set(SUB_SESSION_ID, {
      id: SUB_SESSION_ID,
      getSDKMessageCount: () => 5,
      getProcessingState: () => ({ status: 'idle' }),
      isDeliveryTurnDriving: () => deliveryTurnDriving,
    });

    completed = false;
    manager.registerCompletionCallback(SUB_SESSION_ID, async () => {
      completed = true;
    });
  });

  afterEach(() => {
    // Disarm any still-pending reconcile timer so it cannot fire against the
    // closed DB after this test (the combined unsub clears it).
    const listeners = (
      manager as unknown as {
        sessionListeners: Map<string, () => void>;
      }
    ).sessionListeners;
    for (const unsub of listeners.values()) unsub();
    delete process.env.HYPERNEO_DELIVERY_SETTLE_RECONCILE_MS;
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
  /** Simulate a delivery job completing: nothing left in flight + settle event. */
  const settleDelivery = async (): Promise<void> => {
    activeJobs.clear();
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'kickoff-uuid',
      role: 'turn',
    });
    await flush();
  };
  const nodeStatus = (): string | undefined => nodeExecRepo.getById(executionId)?.status;

  it('a recoverable error does not block the node, and the retry settles it as complete', async () => {
    await publishError(RECOVERABLE_DETAILS);
    expect(nodeStatus()).toBe('in_progress'); // not blocked — retry pending

    await publishIdle(); // post-error idle — job still retrying, suppressed
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');

    await settleDelivery(); // retry succeeded
    expect(completed).toBe(true);
  });

  it('a THROTTLED 4th error cannot leak a completion (idle stays suppressed; dead-letter blocks)', async () => {
    // Codex P1 #1: ErrorManager throttles the 4th identical session.error in
    // 10s, but the failed turn still idles. The idle must stay suppressed
    // because the JOB — not the error event — drives suppression.
    await publishError(RECOVERABLE_DETAILS); // attempt 1 error (unthrottled)
    await publishIdle(); // suppressed — job retrying
    await publishIdle(); // attempt 2+ failed with NO error event (throttled)
    expect(completed).toBe(false); // must NOT complete while retrying
    expect(nodeStatus()).toBe('in_progress');

    // Retries exhausted → dead-letter publishes session.error with no details.
    activeJobs.clear(); // dead row leaves the active set
    await publishError(undefined);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('an unrelated recoverable error during a SUCCESSFUL turn does not suppress completion (Codex P1 #2)', async () => {
    // The turn succeeded (a result was produced) but an unrelated subsystem
    // fired a recoverable session.error mid-turn. The old flag-based approach
    // suppressed the successful idle with no retry/dead-letter ever coming,
    // stranding the node. Now the settle event completes it.
    await publishError(RECOVERABLE_DETAILS); // unrelated — no block
    await publishIdle(); // job still processing the successful turn — suppressed
    expect(completed).toBe(false);

    await settleDelivery(); // job completed — no retry ever scheduled
    expect(completed).toBe(true);
  });

  it('an idle with NO active delivery job completes immediately (no settle hop)', async () => {
    activeJobs.clear(); // job completed before the idle event reached us
    await publishIdle();
    expect(completed).toBe(true);
  });

  it('a settle with another job still in flight does not fire; the last settle does', async () => {
    // A steer job queued behind the turn: the turn's settle must not complete
    // the node while the steer is undelivered.
    await publishIdle(); // suppressed — turn job active
    activeJobs.delete('kickoff-uuid');
    activeJobs.add('steer-uuid');
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'kickoff-uuid',
      role: 'turn',
    });
    await flush();
    expect(completed).toBe(false); // steer still in flight

    await settleDelivery(); // last job settles
    expect(completed).toBe(true);
  });

  it('a STEER settle never completes the node mid-work (Codex P1)', async () => {
    // A steer is consumed mid-turn while the agent is still working — its job
    // settles at consumption. Even with nothing else tracked active, this must
    // NOT fire completion (it would tear down the error listeners while the
    // turn is running, so a later failure could no longer block the node).
    activeJobs.clear();
    activeJobs.add('turn-uuid'); // the owning turn's job — still driving
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'steer-uuid',
      role: 'steer',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');

    // The owning turn's settle (always later — its job completes at turn end)
    // is what completes the node.
    await settleDelivery();
    expect(completed).toBe(true);
  });

  it('a dead-lettered STEER repays a suppressed idle when it was the last job (Codex P2)', async () => {
    // Kickoff turn succeeded but its settle was suppressed while a steer was
    // in flight; the steer then dead-letters. The failed handoff must not fail
    // the node — and must not strand it either: with nothing else in flight
    // and the kickoff durably completed, it repays the suppressed completion.
    turnOutcome = 'completed';
    await publishIdle(); // suppressed — kickoff job active
    activeJobs.delete('kickoff-uuid');
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'kickoff-uuid',
      role: 'turn',
    }); // ignored — steer still active
    await flush();
    activeJobs.clear(); // steer now dead — nothing in flight
    await bus.publish('session.delivery_failed', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'steer-uuid',
      origin: 'space_inject',
      role: 'steer',
    });
    await flush();
    expect(completed).toBe(true); // repaid, NOT blocked
    expect(nodeStatus()).toBe('in_progress'); // not blocked
  });

  it('reconciles a settle lost to a daemon crash (durable completed turn)', async () => {
    // Crash between the job row's completion and the settle publication: the
    // idle was suppressed, no event is coming. The durable row says the turn
    // completed successfully for this activation — the delayed reconciliation
    // fires completion.
    turnOutcome = 'completed';
    await publishIdle(); // suppressed — job active
    activeJobs.clear(); // job completed; settle event LOST
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(true);
  });

  it('reconciles a lost dead-letter publication by BLOCKING (durable dead turn)', async () => {
    // Crash between the job row going dead and the delivery_failed
    // publication: the idle was suppressed while the job was active; the dead
    // row is absent from hasActiveDeliveryJob. Transcript rows (the failed
    // turn's partial output) must NOT satisfy the reconcile — the durable dead
    // turn row makes it BLOCK instead. (Codex P2.)
    turnOutcome = 'dead';
    await publishIdle(); // suppressed — job active
    activeJobs.clear(); // job dead; delivery_failed event LOST
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a flushed PEER turn is not the activation kickoff — reconcile declines (Codex P2)', async () => {
    // A pending-message flush can run a peer handoff as a role:'turn' job in
    // the window before the kickoff is enqueued. If the daemon dies there, a
    // completed peer turn must NOT satisfy the reconciliation for the
    // unstarted node — only the stamped kickoff's settlement qualifies.
    nodeExecRepo.update(executionId, { data: null }); // no kickoff stamped yet
    turnOutcome = 'completed'; // the PEER turn's outcome — wrong uuid, filtered out
    await publishIdle();
    activeJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('reconciliation ignores a reused session whose kickoff was never enqueued (Codex P2)', async () => {
    // Crash between registering the callback and enqueuing the next kickoff on
    // a REUSED session: idle, historical transcript, no active job. No turn
    // job settled for THIS activation — the timer must not complete the node.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('reconciliation does not fire while a job is active or the session is processing', async () => {
    await publishIdle(); // suppressed — job active
    // Session still processing a retry turn: reconciliation timer elapses but
    // must not complete.
    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    for (const nodeMap of subSessions.values()) {
      const session = nodeMap.get(SUB_SESSION_ID) as
        | { getProcessingState: () => { status: string } }
        | undefined;
      if (session) session.getProcessingState = () => ({ status: 'processing' });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('the dead-letter settlement (session.error with no details) blocks the node', async () => {
    activeJobs.clear();
    await publishError(undefined);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a non-recoverable error blocks the node immediately', async () => {
    await publishError(NON_RECOVERABLE_DETAILS);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('with delivery v2 disabled and no durable rows, a recoverable error blocks (legacy)', async () => {
    const prev = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
    try {
      // A pure-legacy boot has no message_delivery rows; nothing can retry.
      activeJobs.clear();
      processingTurnJobs.clear();
      await publishError(RECOVERABLE_DETAILS);
      expect(completed).toBe(false);
      expect(nodeStatus()).toBe('blocked');
    } finally {
      if (prev === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = prev;
    }
  });

  it('after a v2 rollback restart, an ACTIVE durable row still owns completion (Codex P2)', async () => {
    // The processor starts unconditionally and claims the previous boot's
    // v2 rows; the flag being off now must not re-enable first-idle-completes.
    // A retryable terminal-result failure idles WITHOUT session.error while
    // the old job is still active — the idle must stay suppressed.
    const prev = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
    try {
      await publishIdle(); // job active → suppressed despite the flag
      expect(completed).toBe(false);
      expect(nodeStatus()).toBe('in_progress');

      // And its dead-letter still blocks through the row-driven event path.
      activeJobs.clear();
      processingTurnJobs.clear();
      await bus.publish('session.delivery_failed', {
        sessionId: SUB_SESSION_ID,
        messageUuid: 'kickoff-uuid',
        origin: 'space_inject',
        role: 'turn',
      });
      await flush();
      expect(nodeStatus()).toBe('blocked');
    } finally {
      if (prev === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = prev;
    }
  });

  it('an idle with zero SDK messages never fires, even after the job settles (not-started gate)', async () => {
    // The not-started early return must hold on BOTH completion paths — an
    // eager-spawn session that never received its kickoff must not be marked
    // complete by delivery settlement alone. (Review: sdkCount===0 ordering.)
    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    for (const nodeMap of subSessions.values()) {
      const session = nodeMap.get(SUB_SESSION_ID) as
        | { getSDKMessageCount: () => number }
        | undefined;
      if (session) session.getSDKMessageCount = () => 0;
    }
    // Unstamp: this test pins the not-started gate on the COMPLETION paths
    // (a stamped kickoff with no settlement row is the lost-kickoff case,
    // pinned separately below).
    nodeExecRepo.update(executionId, { data: null });

    await publishIdle(); // zero messages — no fire
    expect(completed).toBe(false);
    await settleDelivery(); // zero messages — still no fire
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a stamped kickoff with no delivery row (lost pre-enqueue) blocks for re-spawn', async () => {
    // Daemon exit between the execution update (stamp) and the inject's
    // enqueue: no settlement or idle can ever arrive. The reconcile blocks so
    // the runtime's blocked-execution machinery re-activates the node.
    turnOutcome = null; // no delivery row for the stamped kickoff
    await publishIdle(); // suppressed while the job was 'active'
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('an expired settlement (consumed row + terminal result, job row aged out) completes', async () => {
    // Daemon down past the 7-day job retention: the completed kickoff's job
    // row is gone but its sdk_messages row survives as 'consumed' WITH a
    // success terminal result after it — the node must complete, not
    // block-and-re-spawn finished work.
    kickoffSendStatus = 'consumed';
    kickoffTerminalResult = true;
    turnOutcome = null; // job row gone
    await publishIdle(); // suppressed while the job was active
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(true);
    expect(nodeStatus()).not.toBe('blocked');
  });

  it('a consumed kickoff with NO terminal result after blocks (crash mid-turn)', async () => {
    // 'consumed' is stamped when the SDK ACKNOWLEDGES the prompt — before the
    // turn runs. A daemon exit mid-turn leaves consumed + no success result;
    // the rowless classification must not complete the node (round-17/Codex
    // P2) — it blocks for re-spawn like any never-finished turn.
    kickoffSendStatus = 'consumed';
    kickoffTerminalResult = false;
    turnOutcome = null;
    await publishIdle();
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a FAILED message row blocks (aged-out dead-letter), never completes', async () => {
    // send_status 'failed' means the delivery terminalized as failed (the
    // dead-letter settlement flipped it; the dead job row then aged out).
    // Block for re-spawn — completing here would advance the workflow over a
    // failed kickoff.
    kickoffSendStatus = 'failed';
    turnOutcome = null;
    await publishIdle();
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a DEFERRED kickoff declines and does not block (rate-limit cooldown)', async () => {
    // A kickoff deferred by a rate-limit cooldown / parent-task limit is
    // persisted 'deferred' with NO delivery job — the node is healthy but
    // paused. The reconciliation must decline (and re-arm), never block:
    // blocking would mark a paused node failed and later re-spawn a duplicate
    // kickoff when the cooldown re-enqueues the real one.
    kickoffSendStatus = 'deferred';
    turnOutcome = null;
    await publishIdle();
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a LEGACY (v2-off) activation with no job row completes via the message row (Codex P2)', async () => {
    // Stamped but delivered via the legacy inline path (no job row ever);
    // crash after the legacy turn idled but before the listener. The consumed
    // message row plus its terminal result classifies it as delivered →
    // complete, not lost.
    const prev = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
    try {
      kickoffSendStatus = 'consumed';
      kickoffTerminalResult = true;
      turnOutcome = null;
      activeJobs.clear();
      processingTurnJobs.clear();
      await publishIdle(); // the legacy idle — no suppression (no rows)
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      expect(completed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = prev;
    }
  });

  it('the settlement fallback session.error for a NON-kickoff dead turn does not block', async () => {
    // A flushed peer message won the arbiter (space_inject origin); its
    // dead-letter publishes the uuid-less settlement session.error. With the
    // kickoff not dead and a dead non-kickoff turn row present, the error is
    // attributed to the peer delivery and declined.
    deadNonKickoffTurn = true;
    turnOutcome = null; // kickoff itself not dead
    activeJobs.clear();
    processingTurnJobs.clear();
    await publishError(undefined); // settlement fallback: no details
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a dead-lettered TURN blocks the node even with no session.error (recovery-origin kickoff)', async () => {
    // Codex P2: the settlement's session.error is gated to space_inject+turn,
    // so a recovery-origin re-enqueued kickoff dead-letters with no terminal
    // session.error. `session.delivery_failed` (published for every dead
    // delivery) must still block it. (The dead row no longer occupies the
    // active set, but the block path does not consult it.)
    await bus.publish('session.delivery_failed', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'kickoff-uuid',
      origin: 'recovery', // NOT space_inject — the settlement's session.error gate skips it (matches reconcileStrandedDeliveries' re-enqueue origin)
      role: 'turn',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('isCompletedTurnResult: only genuinely completed turns pass (Codex P2)', () => {
    // The onComplete hook filters on this predicate before publishing
    // session.delivery_settled: non-success outcomes that still complete the
    // job (skipped — e.g. an ACP reclaim of a still-`submitted` prompt,
    // aborted, no_content, archived, stale_attempt) must NOT emit the terminal
    // success signal, or the node would complete without the prompt processed.
    expect(isCompletedTurnResult({ outcome: 'completed' })).toBe(true);
    // A prior-attempt termination observed by this claim is still a genuinely
    // completed turn (durable marker).
    expect(isCompletedTurnResult({ outcome: 'completed', skipped: 'turn_terminated' })).toBe(true);
    expect(isCompletedTurnResult({ outcome: 'skipped', sendStatus: 'submitted' })).toBe(false);
    expect(isCompletedTurnResult({ outcome: 'aborted' })).toBe(false);
    expect(isCompletedTurnResult({ outcome: 'no_content' })).toBe(false);
    expect(isCompletedTurnResult({ outcome: 'archived' })).toBe(false);
    expect(isCompletedTurnResult({ outcome: 'stale_attempt' })).toBe(false);
    expect(isCompletedTurnResult(null)).toBe(false);
    // Steer settlements: only genuinely delivered handoffs qualify.
    expect(isSettledSteerResult({ outcome: 'consumed' })).toBe(true);
    expect(isSettledSteerResult({ outcome: 'already_consumed' })).toBe(true);
    expect(isSettledSteerResult({ outcome: 'skipped', sendStatus: 'submitted' })).toBe(false);
    expect(isSettledSteerResult({ outcome: 'aborted' })).toBe(false);
    expect(isSettledSteerResult(null)).toBe(false);
  });

  it('a flushed PEER turn settle does not complete the node live (Codex P1)', async () => {
    // The flush's peer handoff runs as a turn job after the callback is
    // registered but BEFORE the kickoff is injected — no stamp exists yet, so
    // its live settlement must not complete the unstarted node.
    nodeExecRepo.update(executionId, { data: null }); // kickoff not injected yet
    activeJobs.clear();
    processingTurnJobs.clear();
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'peer-flush-uuid', // the PEER's turn — not the kickoff
      role: 'turn',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');

    // The actual kickoff (stamped) settling is what completes the node.
    nodeExecRepo.update(executionId, { data: { kickoffMessageUuid: 'kickoff-uuid' } });
    await settleDelivery();
    expect(completed).toBe(true);
  });

  it('a turn settle for a session with NO execution row keeps the stamp-less path', async () => {
    // Post-approval merger shape: no node_executions row → no stamp to check →
    // the settle still completes (nothing to falsely complete).
    nodeExecRepo.update(executionId, { agentSessionId: null }); // detach the row
    activeJobs.clear();
    processingTurnJobs.clear();
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'any-turn-uuid',
      role: 'turn',
    });
    await flush();
    expect(completed).toBe(true); // callback fired via the stamp-less path
  });

  it('a recoverable error while only a STEER is processing blocks (no driving turn)', async () => {
    // A claimed steer is a mid-turn feed — its driving TURN owns the retry.
    // With no processing turn, a continuation-replay error must block.
    processingTurnJobs.clear(); // only a steer is claimed — no driving turn
    activeJobs.add('steer-uuid');
    await publishError(RECOVERABLE_DETAILS);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('the OWNING turn settle completes a kickoff that settled as a steer (Codex P1)', async () => {
    // Kickoff lost the arbiter to a flush (settled as a consumed steer); the
    // flush's peer turn outlasted the reconcile delay. Its settle carries a
    // uuid ≠ the stamp — the durable correlated outcome (kickoff consumed +
    // owning turn completed) must accept it.
    turnOutcome = 'completed'; // durable: kickoff-as-steer consumed + owner completed
    activeJobs.clear();
    processingTurnJobs.clear();
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'peer-turn-uuid', // ≠ stamped 'kickoff-uuid'
      role: 'turn',
    });
    await flush();
    expect(completed).toBe(true);
  });

  it('a uuid-mismatched turn settle with NO durable kickoff settlement declines', async () => {
    turnOutcome = null; // kickoff row not settled (or owner still live)
    activeJobs.clear();
    processingTurnJobs.clear();
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'peer-turn-uuid',
      role: 'turn',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('the reconcile RE-ARMS when its shot falls inside a long turn (Codex P1)', async () => {
    // First shot: session still processing (turn > delay) → re-arm. Then the
    // turn ends and its settle is lost; the re-armed shot repairs.
    turnOutcome = 'completed';
    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    let live: { getProcessingState: () => { status: string } } | undefined;
    for (const nodeMap of subSessions.values()) {
      live = nodeMap.get(SUB_SESSION_ID) as typeof live;
    }
    if (live) live.getProcessingState = () => ({ status: 'processing' });
    await new Promise<void>((resolve) => setTimeout(resolve, 25)); // first shot re-arms
    if (live) live.getProcessingState = () => ({ status: 'idle' }); // turn ends
    activeJobs.clear();
    processingTurnJobs.clear(); // settle lost — durable rows carry the truth
    await new Promise<void>((resolve) => setTimeout(resolve, 60)); // re-armed shot
    expect(completed).toBe(true);
  });

  it('a THROWN reconcile shot re-arms once and recovers (transient SQLITE_BUSY)', async () => {
    // Round-17 P2: a transient throw in the one-shot used to surrender the
    // crash repair permanently. The catch must re-arm so the next shot
    // completes the repair. Deferred status keeps every later shot declining
    // (and re-arming), so >= 2 lookups proves the re-arm happened.
    outcomeThrowBudget = 1;
    kickoffSendStatus = 'deferred';
    turnOutcome = null;
    await publishIdle();
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(outcomeCalls).toBeGreaterThanOrEqual(2);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a PERSISTENTLY throwing reconcile gives up after its one bounded re-arm', async () => {
    // The catch-side re-arm is bounded: two consecutive throws, then stop —
    // a broken lookup must not spin the timer forever.
    outcomeThrowBudget = Number.POSITIVE_INFINITY;
    await publishIdle();
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(outcomeCalls).toBe(2);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a NON-THROWING decline resets the retry budget (alternating throws keep repairing)', async () => {
    // Round-18 P2: the reset must follow every non-throwing shot, declines
    // included — otherwise one transient failure permanently consumes the
    // allowance even after many healthy in-flight checks. Odd calls throw,
    // even calls decline-and-re-arm (deferred): the chain must keep going.
    throwOnOddOutcomeCalls = true;
    kickoffSendStatus = 'deferred';
    turnOutcome = null;
    await publishIdle();
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(outcomeCalls).toBeGreaterThanOrEqual(5);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a mid-construction activation declines instead of classifying a lost kickoff', async () => {
    // Round-18 P2: the spawn stamps the kickoff BEFORE its setup/memory
    // construction awaits, so no delivery or message row can exist yet —
    // the reconcile must not fire the lost-kickoff block while the in-memory
    // pre-inject guard is held. Once construction ends (guard released), the
    // next re-armed shot classifies normally.
    const preInject = (manager as unknown as { preInjectKickoffExecutions: Set<string> })
      .preInjectKickoffExecutions;
    preInject.add(executionId);
    turnOutcome = null;
    kickoffSendStatus = null; // no rows yet
    await publishIdle();
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress'); // declined, re-armed

    preInject.delete(executionId); // construction finished/failed
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(nodeStatus()).toBe('blocked'); // now classified as lost
  });

  it('a FAILED terminal-decision persist keeps the listeners and retries the block', async () => {
    // Round-18 P2: if handleSubSessionError rejects (transient SQLite on the
    // blocked-status update), the decision must not be consumed — listeners
    // stay armed and the re-armed reconcile retries the block from the
    // durable dead row.
    const managerInternals = manager as unknown as {
      handleSubSessionError: (sid: string, error: string) => Promise<void>;
    };
    const original = managerInternals.handleSubSessionError.bind(manager);
    let persistAttempts = 0;
    managerInternals.handleSubSessionError = (sid: string, error: string) => {
      persistAttempts++;
      if (persistAttempts === 1) return Promise.reject(new Error('database is locked'));
      return original(sid, error);
    };
    turnOutcome = 'dead';
    await publishIdle();
    activeJobs.clear();
    processingTurnJobs.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(persistAttempts).toBeGreaterThanOrEqual(2); // retried after the rejection
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a recoverable error while a turn row is CLAIMED but not DRIVING blocks (rehydration race)', async () => {
    // Round-19 P2: during rehydration the restored session is published to
    // the runtime caches before the direct streaming/continuation-replay
    // awaits, and the processor can claim an unrelated restored turn in that
    // window — a processing ROW exists, but no drive is in flight and that
    // job cannot retry the replay's error. The deferral must not apply.
    deliveryTurnDriving = false; // claimed, driveDeliveryTurn not entered
    await publishError(RECOVERABLE_DETAILS);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a PRE-UPGRADE unstamped execution completes via the live settle (rollout compat)', async () => {
    // Round-19 P1: executions already in_progress at deploy time carry no
    // kickoffMessageUuid (the parent revision never wrote one). Their
    // reclaimed delivery settles the node through the stamp-less path
    // instead of being declined as "pre-kickoff window".
    nodeExecRepo.update(executionId, { data: null, startedAt: Date.now() - 3_600_000 });
    activeJobs.clear();
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'legacy-kickoff-uuid', // unknown uuid — no stamp to match
      role: 'turn',
    });
    await flush();
    expect(completed).toBe(true);
  });

  it('a PRE-UPGRADE unstamped execution blocks on a dead turn (rollout compat)', async () => {
    nodeExecRepo.update(executionId, { data: null, startedAt: Date.now() - 3_600_000 });
    activeJobs.clear();
    await bus.publish('session.delivery_failed', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'legacy-kickoff-uuid',
      origin: 'space_inject',
      role: 'turn',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a settled STEER that was the last job repays the suppressed idle (ACP shape)', async () => {
    // The owning turn finished while an ACP steer was parked awaiting
    // acceptance: the turn's idle AND settle were both suppressed (steer
    // active). The accepted steer later settles ('already_consumed') as the
    // LAST active job — its settlement must repay the completion. The
    // kickoff's durable settlement ('completed') is the activation evidence.
    turnOutcome = 'completed';
    await publishIdle(); // suppressed — kickoff job active
    activeJobs.delete('kickoff-uuid');
    activeJobs.add('steer-uuid');
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'kickoff-uuid',
      role: 'turn',
    }); // ignored — steer still in flight
    await flush();
    expect(completed).toBe(false);

    activeJobs.clear(); // steer settles — nothing in flight, session idle
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'steer-uuid',
      role: 'steer',
    });
    await flush();
    expect(completed).toBe(true);
  });

  it('a settled STEER does not complete the node while the turn is still running', async () => {
    // Steer consumed mid-turn (no other job active in the fixture) but the
    // live processing state says the session is still working — the steer
    // settlement must not fire completion.
    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    for (const nodeMap of subSessions.values()) {
      const session = nodeMap.get(SUB_SESSION_ID) as
        | { getProcessingState: () => { status: string } }
        | undefined;
      if (session) session.getProcessingState = () => ({ status: 'processing' });
    }
    activeJobs.clear();
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'steer-uuid',
      role: 'steer',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a recoverable error with NO active delivery job blocks (non-delivery work)', async () => {
    // Rehydration path shape: the listener registers, the session starts
    // streaming / replays tool continuations directly — no delivery job can
    // retry an error from that work, and no delivery_failed will repay it.
    // The deferral must not apply; the error blocks as before this PR.
    activeJobs.clear();
    processingTurnJobs.clear();
    await publishError(RECOVERABLE_DETAILS);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a recoverable error while the job is merely QUEUED blocks (continuation replay)', async () => {
    // Rehydration shape: a tool-continuation replay runs directly (no job is
    // driving the session) while an unrelated delivery job sits pending —
    // active, but not being driven, so it cannot retry the replay's error.
    // The deferral must not apply.
    processingTurnJobs.clear(); // queued only — nothing is being driven
    await publishError(RECOVERABLE_DETAILS);
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('the crash reconcile repairs a stranded settle even after v2 is switched OFF', async () => {
    // Operator rollback after the crash: the durable rows were written while
    // v2 was enabled; the reconciliation must not depend on the current flag.
    const prev = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
    try {
      turnOutcome = 'completed'; // durable: the stamped kickoff completed
      await publishIdle(); // suppressed before the crash — job was active
      activeJobs.clear();
      processingTurnJobs.clear();
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      expect(completed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = prev;
    }
  });

  it('an UNRELATED recovery turn dead-letter does not block the node (Codex P2)', async () => {
    // The startup reconciler re-enqueues an older stranded message on a reused
    // session as an origin:'recovery' turn job; its dead-letter is not this
    // activation's kickoff and must not fail the node.
    await bus.publish('session.delivery_failed', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'old-stranded-uuid', // ≠ the stamped kickoff
      origin: 'recovery',
      role: 'turn',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a restored old steer settling in the pre-kickoff window does not complete (Codex P1)', async () => {
    // Reused session: callback registered, new kickoff not yet injected (no
    // stamp). An old steer reclaimed with its message already consumed
    // settles 'already_consumed' while the restored session idles — the
    // historical transcript must NOT complete the new execution.
    nodeExecRepo.update(executionId, { data: null }); // kickoff not injected yet
    turnOutcome = 'completed'; // stale durable evidence — must be ignored without the stamp
    activeJobs.clear();
    processingTurnJobs.clear();
    await bus.publish('session.delivery_settled', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'old-steer-uuid',
      role: 'steer',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');

    // The same old steer dead-lettering must neither block nor repay.
    await bus.publish('session.delivery_failed', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'old-steer-uuid',
      origin: 'recovery',
      role: 'steer',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('a dead-lettered KICKOFF-AS-STEER blocks the node (Codex P1)', async () => {
    // The kickoff lost the turn arbiter to a flush and was persisted as a
    // steer; its dead-letter (e.g. ACP acceptance timeout) is the node's
    // FAILED KICKOFF — it must block, not repay like an ordinary steer.
    await bus.publish('session.delivery_failed', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'kickoff-uuid', // === the execution's stamp
      origin: 'space_inject',
      role: 'steer',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });

  it('a dead-lettered STEER does not block the node (mid-turn handoff failure)', async () => {
    await bus.publish('session.delivery_failed', {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'steer-uuid',
      origin: 'space_inject',
      role: 'steer',
    });
    await flush();
    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('in_progress');
  });

  it('composition: the real dead-letter settlement wired through the bus blocks the node', async () => {
    // Wire app.ts's actual onDead composition (delivery_failed broadcast +
    // settleMessageDeliveryDeadLetter) against the same bus the manager
    // listens on, then simulate a space_inject turn job dying.
    const payload = {
      sessionId: SUB_SESSION_ID,
      messageUuid: 'kickoff-uuid',
      origin: 'space_inject',
      role: 'turn',
    } as const;
    await bus.publish('session.delivery_failed', { ...payload });
    await settleMessageDeliveryDeadLetter(payload, {
      markDeliveryFailedByUuid: () => null, // no sdk_messages row in this fixture
      publishStatusChanged: () => Promise.resolve(),
      publishSessionError: (sid, error) => bus.publish('session.error', { sessionId: sid, error }),
      settleSkippedDelivery: () => Promise.resolve(),
    });
    await flush();

    expect(completed).toBe(false);
    expect(nodeStatus()).toBe('blocked');
  });
});
