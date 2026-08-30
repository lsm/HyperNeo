import { describe, expect, it } from 'bun:test';
import type { NodeExecution, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import { buildSyntheticExternalEventMessage } from '../../../../src/lib/external-events/deferred-event-digest';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import type { DeliveryFailure } from '../../../../src/lib/external-events/types';
import type { ExternalEventTaskDecision } from '../../../../src/lib/space/runtime/external-event-admission-gates';
import {
  buildImmediateEventMessageUuid,
  deliverImmediateEvent,
  IMMEDIATE_EVENT_MESSAGE_UUID_PREFIX,
  type ImmediateEventDeliveryDeps,
  type ImmediateEventDeliveryInput,
  pickMechanics,
} from '../../../../src/lib/space/runtime/immediate-event-delivery-pipeline';

const SPACE_ID = 'space-1';
const RUN_ID = 'run-1';
const TASK_ID = 'task-1';
const NODE_ID = 'node-1';
const AGENT_NAME = 'coder';
const SESSION_ID = 'session-1';
const EVENT_ID = 'event-1';
const DELIVERY_KEY = '["github","dk-1"]';
const RENDER = '- Review comment by lsm: "needs work"';

function payload(): ExternalEventPublishedPayload {
  return {
    namespaceId: SPACE_ID,
    spaceId: SPACE_ID,
    eventId: EVENT_ID,
    source: 'github',
    topic: 'github/lsm/HyperNeo/pull_request/3018.review_submitted',
    dedupeKey: 'dk-1',
    summary: 'review submitted',
    payload: {},
    occurredAt: 1,
    ingestedAt: 2,
  };
}

function input(overrides: Partial<ImmediateEventDeliveryInput> = {}): ImmediateEventDeliveryInput {
  return {
    event: payload(),
    render: RENDER,
    target: { workflowRunId: RUN_ID, taskId: TASK_ID, nodeId: NODE_ID, agentName: AGENT_NAME },
    deliveryKey: DELIVERY_KEY,
    ...overrides,
  };
}

function task(status: SpaceTask['status'] = 'in_progress'): SpaceTask {
  return { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, status } as SpaceTask;
}

function run(): SpaceWorkflowRun {
  return { id: RUN_ID, spaceId: SPACE_ID } as SpaceWorkflowRun;
}

function execution(): NodeExecution {
  return {
    workflowRunId: RUN_ID,
    workflowNodeId: NODE_ID,
    agentName: AGENT_NAME,
    agentSessionId: SESSION_ID,
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
  } as unknown as NodeExecution;
}

interface Recording {
  queuedIfIdle: string[];
  delivered: Array<[string, string]>;
  failed: Array<{ eventId: string; deliveryKey: string; failure: DeliveryFailure }>;
  eventRollups: string[];
  eventFailureRollups: string[];
}

function setupDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      send_status TEXT,
      origin TEXT,
      is_renderable INTEGER NOT NULL DEFAULT 1,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      conversation_turn_index INTEGER,
      parent_tool_use_id TEXT,
      task_id TEXT,
      sdk_uuid TEXT,
      consumed_seq INTEGER,
      replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sdk_message_replacements (
      source_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      target_uuid TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (source_message_id, target_uuid, kind)
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, visible_message_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id);

    CREATE TABLE job_queue (
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
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_delivery_session_active
      ON job_queue (json_extract(payload, '$.sessionId'))
      WHERE queue = 'message_delivery' AND status IN ('pending', 'processing');
  `);
  return db;
}

function makeDeps(overrides: Partial<ImmediateEventDeliveryDeps> = {}): {
  deps: ImmediateEventDeliveryDeps;
  rec: Recording;
  db: Database;
  messages: SDKMessageRepository;
  jobQueue: JobQueueRepository;
} {
  const db = setupDb();
  const messages = new SDKMessageRepository(db);
  const jobQueue = new JobQueueRepository(db);
  const rec: Recording = {
    queuedIfIdle: [],
    delivered: [],
    failed: [],
    eventRollups: [],
    eventFailureRollups: [],
  };
  const deps: ImmediateEventDeliveryDeps = {
    getTask: () => task(),
    getRun: () => run(),
    listExecutions: () => [execution()],
    isDeliveryInFlight: () => false,
    isSubscriptionActive: () => true,
    isTargetSpacePaused: () => false,
    isTargetSessionLive: () => true,
    isSessionInterruptInProgress: () => false,
    getSessionStatus: () => 'idle',
    withinRateBudget: () => true,
    setQueuedIfIdle: (_sessionId, messageUuid) => {
      rec.queuedIfIdle.push(messageUuid);
      return Promise.resolve(true);
    },
    db,
    messages,
    jobQueue,
    eventStore: {
      isDeliveryTerminal: () => false,
      markDeliveryMailboxAccepted: (eventId, deliveryKey) =>
        rec.delivered.push([eventId, deliveryKey]),
      markDeliveryFailed: (eventId, deliveryKey, failure) =>
        rec.failed.push({ eventId, deliveryKey, failure }),
      markEventDeliveredIfAllDeliveriesDelivered: (eventId) => rec.eventRollups.push(eventId),
      markEventFailedIfAllDeliveriesTerminal: (eventId) => rec.eventFailureRollups.push(eventId),
    },
    ...overrides,
  };
  return { deps, rec, db, messages, jobQueue };
}

async function deliver(
  depsOverrides: Partial<ImmediateEventDeliveryDeps> = {},
  inputOverrides: Partial<ImmediateEventDeliveryInput> = {}
) {
  const harness = makeDeps(depsOverrides);
  return {
    outcome: await deliverImmediateEvent(harness.deps, input(inputOverrides)),
    ...harness,
  };
}

interface DeliveryJobRow {
  sessionId: string;
  messageUuid: string;
  origin: string;
  injectedMidTurn?: boolean;
}

function deliveryJobs(db: Database): DeliveryJobRow[] {
  return (
    db.prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`).all() as Array<{
      payload: string;
    }>
  ).map((row) => {
    const payload = JSON.parse(row.payload) as DeliveryJobRow;
    return {
      sessionId: payload.sessionId,
      messageUuid: payload.messageUuid,
      origin: payload.origin,
      ...(payload.injectedMidTurn === true ? { injectedMidTurn: true } : {}),
    };
  });
}

function messageRow(
  db: Database,
  uuid: string
): { sendStatus: string | null; origin: string | null } {
  return db
    .prepare(`SELECT send_status AS sendStatus, origin FROM sdk_messages WHERE sdk_uuid = ?`)
    .get(uuid) as { sendStatus: string | null; origin: string | null };
}

describe('deliver-immediate-event pipeline', () => {
  it('delivers to an idle session as a turn with system origin and render text', async () => {
    const uuid = buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY);
    const { outcome, rec, db } = await deliver();
    expect(outcome).toEqual({
      action: 'delivered',
      mechanics: 'turn',
      messageUuid: uuid,
    });
    expect(messageRow(db, uuid)).toEqual({ sendStatus: 'enqueued', origin: 'system' });
    expect(deliveryJobs(db)).toEqual([
      { sessionId: SESSION_ID, messageUuid: uuid, origin: 'space_inject' },
    ]);
    expect(rec.queuedIfIdle).toEqual([uuid]);
    expect(rec.delivered).toEqual([[EVENT_ID, DELIVERY_KEY]]);
    expect(rec.eventRollups).toEqual([EVENT_ID]);
    expect(rec.eventFailureRollups).toEqual([EVENT_ID]);
  });

  it('steers into a session whose status is exactly processing', async () => {
    const uuid = buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY);
    const harness = makeDeps({ getSessionStatus: () => 'processing' });
    harness.jobQueue.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: {
        sessionId: SESSION_ID,
        messageUuid: 'seed-active-turn',
        origin: 'chat',
        parentToolUseId: null,
      },
      maxRetries: 8,
    });
    const outcome = await deliverImmediateEvent(harness.deps, input());
    expect(outcome).toEqual({
      action: 'delivered',
      mechanics: 'steer',
      messageUuid: uuid,
    });
    expect(
      deliveryJobs(harness.db).filter((job) => job.messageUuid !== 'seed-active-turn')
    ).toEqual([
      { sessionId: SESSION_ID, messageUuid: uuid, origin: 'space_inject', injectedMidTurn: true },
    ]);
    expect(harness.rec.queuedIfIdle).toEqual([uuid]);
  });

  it('keeps the first routing decision when later gate inputs also hold', async () => {
    const { outcome, rec, db } = await deliver({
      isDeliveryInFlight: () => true,
      isSubscriptionActive: () => false,
      getTask: () => task('done'),
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'claim_conflict' });
    expect(rec.failed).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages`).get()).toEqual({ n: 0 });
  });

  it('skips when the delivery is already terminal but still reconciles the event', async () => {
    const { deps, rec, db } = makeDeps();
    deps.eventStore.isDeliveryTerminal = () => true;
    const outcome = await deliverImmediateEvent(deps, input());
    expect(outcome).toEqual({ action: 'skip', reason: 'delivery_terminal' });
    expect(rec.eventRollups).toEqual([EVENT_ID]);
    expect(rec.eventFailureRollups).toEqual([EVENT_ID]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages`).get()).toEqual({ n: 0 });
    expect(deliveryJobs(db)).toEqual([]);
    expect(rec.delivered).toEqual([]);
    expect(rec.failed).toEqual([]);
  });

  it('fails the ledger and rolls the failure up to the event when the subscription is gone', async () => {
    const { outcome, rec, db } = await deliver({ isSubscriptionActive: () => false });
    expect(outcome).toEqual({ action: 'failed', reason: 'subscription_no_longer_active' });
    expect(rec.failed).toEqual([
      {
        eventId: EVENT_ID,
        deliveryKey: DELIVERY_KEY,
        failure: { terminal: true, reason: 'subscription_no_longer_active' },
      },
    ]);
    expect(rec.eventFailureRollups).toEqual([EVENT_ID]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages`).get()).toEqual({ n: 0 });
    expect(deliveryJobs(db)).toEqual([]);
  });

  it('fails the ledger when the target task is terminal', async () => {
    const { outcome, rec, db } = await deliver({ getTask: () => task('done') });
    expect(outcome).toEqual({ action: 'failed', reason: 'target_task_terminal' });
    expect(rec.failed[0].failure).toEqual({ terminal: true, reason: 'target_task_terminal' });
    expect(rec.eventFailureRollups).toEqual([EVENT_ID]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages`).get()).toEqual({ n: 0 });
  });

  it('defers a stopped task leaving the ledger pending', async () => {
    const { outcome, rec } = await deliver({ getTask: () => task('stopped') });
    expect(outcome).toEqual({ action: 'deferred', reason: 'task_stopped' });
    expect(rec.failed).toEqual([]);
    expect(rec.delivered).toEqual([]);
  });

  it('defers while the target space is paused leaving the ledger pending', async () => {
    const { outcome, rec, db } = await deliver({ isTargetSpacePaused: () => true });
    expect(outcome).toEqual({ action: 'deferred', reason: 'space_paused' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages`).get()).toEqual({ n: 0 });
    expect(deliveryJobs(db)).toEqual([]);
    expect(rec.failed).toEqual([]);
    expect(rec.delivered).toEqual([]);
  });

  it('defers when the target has no active session', async () => {
    const { outcome, rec } = await deliver({ listExecutions: () => [] });
    expect(outcome).toEqual({ action: 'deferred', reason: 'no_active_session' });
    expect(rec.delivered).toEqual([]);
  });

  it('defers when the resolved session is no longer live', async () => {
    const { outcome } = await deliver({ isTargetSessionLive: () => false });
    expect(outcome).toEqual({ action: 'deferred', reason: 'stale_session' });
  });

  it('defers while the target session has an interrupt still in progress', async () => {
    const { outcome } = await deliver({ isSessionInterruptInProgress: () => true });
    expect(outcome).toEqual({ action: 'deferred', reason: 'session_interrupted' });
  });

  it('treats rate budget overflow as a deferral, not a failure', async () => {
    const { outcome, rec } = await deliver({ withinRateBudget: () => false });
    expect(outcome).toEqual({ action: 'deferred', reason: 'rate_budget' });
    expect(rec.failed).toEqual([]);
    expect(rec.delivered).toEqual([]);
  });

  it('defers when the row carries no render block', async () => {
    const { outcome } = await deliver({}, { render: null });
    expect(outcome).toEqual({ action: 'deferred', reason: 'render_missing' });
  });

  it('replaying the same input reuses the same row and job without duplicates', async () => {
    const { deps, db } = makeDeps();
    const first = await deliverImmediateEvent(deps, input());
    const second = await deliverImmediateEvent(deps, input());
    expect(first.action).toBe('delivered');
    expect(second.action).toBe('delivered');
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_uuid IS NOT NULL`)
      .get() as { n: number };
    expect(rows.n).toBe(1);
    expect(deliveryJobs(db)).toHaveLength(1);
  });

  it('retries a previously failed row instead of skipping it silently', async () => {
    const uuid = buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY);
    const { deps, rec, messages, db } = makeDeps();
    messages.saveUserMessage(
      SESSION_ID,
      buildSyntheticExternalEventMessage(SESSION_ID, RENDER, uuid),
      'failed',
      'system'
    );
    const outcome = await deliverImmediateEvent(deps, input());
    expect(outcome).toEqual({
      action: 'delivered',
      mechanics: 'turn',
      messageUuid: uuid,
    });
    expect(messageRow(db, uuid).sendStatus).toBe('enqueued');
    expect(deliveryJobs(db)).toEqual([
      { sessionId: SESSION_ID, messageUuid: uuid, origin: 'space_inject' },
    ]);
    expect(rec.delivered).toEqual([[EVENT_ID, DELIVERY_KEY]]);
  });

  it('treats an already consumed row as mailbox-accepted without enqueuing a new job', async () => {
    const uuid = buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY);
    const { deps, rec, messages, db } = makeDeps();
    messages.saveUserMessage(
      SESSION_ID,
      buildSyntheticExternalEventMessage(SESSION_ID, RENDER, uuid),
      'consumed',
      'system'
    );
    const outcome = await deliverImmediateEvent(deps, input());
    expect(outcome).toEqual({
      action: 'delivered',
      mechanics: 'turn',
      messageUuid: uuid,
    });
    expect(messageRow(db, uuid).sendStatus).toBe('consumed');
    expect(deliveryJobs(db)).toEqual([]);
    expect(rec.delivered).toEqual([[EVENT_ID, DELIVERY_KEY]]);
  });

  it('reports an outbox failure without persisting a half-open row', async () => {
    const harness = makeDeps();
    harness.db.exec('DROP TABLE job_queue');
    const outcome = await deliverImmediateEvent(harness.deps, input());
    expect(outcome.action).toBe('error');
    if (outcome.action !== 'error') return;
    expect(outcome.stage).toBe('persistAndEnqueue');
    expect(harness.db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages`).get()).toEqual({ n: 0 });
    expect(harness.rec.delivered).toEqual([]);
    expect(harness.rec.failed).toEqual([]);
  });

  it('leaves a pre-existing enqueued row untouched when the outbox enqueue fails', async () => {
    const uuid = buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY);
    const harness = makeDeps();
    harness.messages.saveUserMessage(
      SESSION_ID,
      buildSyntheticExternalEventMessage(SESSION_ID, RENDER, uuid),
      'enqueued',
      'system'
    );
    harness.db.exec('DROP TABLE job_queue');
    const outcome = await deliverImmediateEvent(harness.deps, input());
    expect(outcome.action).toBe('error');
    expect(messageRow(harness.db, uuid).sendStatus).toBe('enqueued');
  });

  it('reports a ledger-marking error after the mailbox accepted the row and job', async () => {
    const base = makeDeps();
    const { outcome, db } = await deliver({
      eventStore: {
        ...base.deps.eventStore,
        markDeliveryMailboxAccepted: () => {
          throw new Error('sqlite busy');
        },
      },
    });
    expect(outcome.action).toBe('error');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages`).get()).toEqual({ n: 1 });
    expect(deliveryJobs(db)).toHaveLength(1);
  });

  it('derives the message uuid deterministically from event id and delivery key', () => {
    const a = buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY);
    expect(a).toBe(buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY));
    expect(a.startsWith(IMMEDIATE_EVENT_MESSAGE_UUID_PREFIX)).toBe(true);
    expect(a).not.toBe(buildImmediateEventMessageUuid(EVENT_ID, 'other-key'));
    expect(a).not.toBe(buildImmediateEventMessageUuid('other-event', DELIVERY_KEY));
  });

  it('pickMechanics switches mechanically on exact session status', () => {
    const ctx = (status: string, sessionId?: string, sessionLive = true) => ({
      ...input(),
      deps: makeDeps({ getSessionStatus: () => status }).deps,
      sessionId,
      deliveryTerminal: false,
      deliveryInFlight: false,
      subscriptionActive: true,
      taskDecision: { action: 'deliver' } as ExternalEventTaskDecision,
      targetHasSession: sessionId !== undefined,
      targetSessionLive: sessionId !== undefined && sessionLive,
      targetSpacePaused: false,
      executionPendingActivation: false,
      decision: null,
    });
    expect(pickMechanics(ctx('processing', SESSION_ID)).mechanics).toBe('steer');
    expect(pickMechanics(ctx('idle', SESSION_ID)).mechanics).toBe('turn');
    expect(pickMechanics(ctx('queued', SESSION_ID)).mechanics).toBe('turn');
    expect(pickMechanics(ctx('processing')).outcome).toEqual({
      action: 'deferred',
      reason: 'no_active_session',
    });
    expect(pickMechanics(ctx('idle', SESSION_ID, false)).outcome).toEqual({
      action: 'deferred',
      reason: 'stale_session',
    });
  });
});
