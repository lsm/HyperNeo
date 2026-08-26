import { describe, expect, it } from 'bun:test';
import type { NodeExecution, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import type { DeliveryFailure } from '../../../../src/lib/external-events/types';
import {
  buildImmediateEventMessageUuid,
  deliverImmediateEvent,
  IMMEDIATE_EVENT_MESSAGE_UUID_PREFIX,
  type ImmediateEventDeliveryDeps,
  type ImmediateEventDeliveryInput,
  pickMechanics,
} from '../../../../src/lib/space/runtime/immediate-event-delivery-pipeline';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';

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
  saved: Array<{ sessionId: string; uuid: string; sendStatus: string; text: string }>;
  jobs: Array<{ sessionId: string; messageUuid: string; role: string; origin: string }>;
  delivered: Array<[string, string]>;
  failed: Array<{ eventId: string; deliveryKey: string; failure: DeliveryFailure }>;
  rollups: string[];
}

function makeDeps(overrides: Partial<ImmediateEventDeliveryDeps> = {}): {
  deps: ImmediateEventDeliveryDeps;
  rec: Recording;
} {
  const rec: Recording = { saved: [], jobs: [], delivered: [], failed: [], rollups: [] };
  const savedUuids = new Set<string>();
  const activeRoles = new Map<string, 'turn' | 'steer'>();
  const deps: ImmediateEventDeliveryDeps = {
    getTask: () => task(),
    getRun: () => run(),
    listExecutions: () => [execution()],
    isDeliveryInFlight: () => false,
    isSubscriptionActive: () => true,
    getSessionStatus: () => 'idle',
    withinRateBudget: () => true,
    messages: {
      getUserMessageByUuid: (_sessionId, uuid) =>
        savedUuids.has(uuid) ? { uuid, timestamp: 1, content: RENDER } : undefined,
      saveUserMessage: (sessionId, message, sendStatus = 'enqueued') => {
        const uuid = String(message.uuid);
        savedUuids.add(uuid);
        const content = (message as { message: { content: Array<{ text: string }> } }).message
          .content;
        rec.saved.push({ sessionId, uuid, sendStatus, text: content.map((b) => b.text).join('') });
        return `db-${rec.saved.length}`;
      },
    },
    jobQueue: {
      getActiveDeliveryRole: (_sessionId, messageUuid) => activeRoles.get(messageUuid) ?? null,
      enqueue: (params) => {
        const p = params.payload as unknown as {
          sessionId: string;
          messageUuid: string;
          role: 'turn' | 'steer';
          origin: string;
        };
        activeRoles.set(p.messageUuid, p.role);
        rec.jobs.push({
          sessionId: p.sessionId,
          messageUuid: p.messageUuid,
          role: p.role,
          origin: p.origin,
        });
        return {} as Job;
      },
    },
    eventStore: {
      isDeliveryTerminal: () => false,
      markDeliveryDelivered: (eventId, deliveryKey) => rec.delivered.push([eventId, deliveryKey]),
      markDeliveryFailed: (eventId, deliveryKey, failure) =>
        rec.failed.push({ eventId, deliveryKey, failure }),
      markEventDeliveredIfAllDeliveriesDelivered: (eventId) => rec.rollups.push(eventId),
    },
    ...overrides,
  };
  return { deps, rec };
}

function deliver(
  depsOverrides: Partial<ImmediateEventDeliveryDeps> = {},
  inputOverrides: Partial<ImmediateEventDeliveryInput> = {}
) {
  const { deps, rec } = makeDeps(depsOverrides);
  return { outcome: deliverImmediateEvent(deps, input(inputOverrides)), rec };
}

describe('deliver-immediate-event pipeline', () => {
  it('delivers to an idle session as a turn with the row render text', () => {
    const { outcome, rec } = deliver();
    expect(outcome).toEqual({
      action: 'delivered',
      mechanics: 'turn',
      deliveryRole: 'turn',
      messageUuid: buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY),
    });
    expect(rec.saved).toEqual([
      {
        sessionId: SESSION_ID,
        uuid: buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY),
        sendStatus: 'enqueued',
        text: RENDER,
      },
    ]);
    expect(rec.jobs).toEqual([
      {
        sessionId: SESSION_ID,
        messageUuid: buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY),
        role: 'turn',
        origin: 'space_inject',
      },
    ]);
    expect(rec.delivered).toEqual([[EVENT_ID, DELIVERY_KEY]]);
    expect(rec.rollups).toEqual([EVENT_ID]);
  });

  it('steers into a session whose status is exactly processing', () => {
    const { outcome, rec } = deliver({ getSessionStatus: () => 'processing' });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.mechanics).toBe('steer');
    expect(outcome.deliveryRole).toBe('steer');
    expect(rec.jobs[0].role).toBe('steer');
  });

  it('skips without effects when the delivery is already terminal', () => {
    const { outcome, rec } = deliver({
      eventStore: { ...makeDeps().deps.eventStore, isDeliveryTerminal: () => true },
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'delivery_terminal' });
    expect(rec.saved).toEqual([]);
    expect(rec.jobs).toEqual([]);
    expect(rec.delivered).toEqual([]);
    expect(rec.failed).toEqual([]);
  });

  it('skips when another delivery claim is in flight', () => {
    const { outcome, rec } = deliver({ isDeliveryInFlight: () => true });
    expect(outcome).toEqual({ action: 'skip', reason: 'claim_conflict' });
    expect(rec.saved).toEqual([]);
    expect(rec.jobs).toEqual([]);
  });

  it('fails the ledger when the subscription is no longer active', () => {
    const { outcome, rec } = deliver({ isSubscriptionActive: () => false });
    expect(outcome).toEqual({ action: 'failed', reason: 'subscription_no_longer_active' });
    expect(rec.failed).toEqual([
      {
        eventId: EVENT_ID,
        deliveryKey: DELIVERY_KEY,
        failure: { terminal: true, reason: 'subscription_no_longer_active' },
      },
    ]);
    expect(rec.saved).toEqual([]);
    expect(rec.jobs).toEqual([]);
  });

  it('fails the ledger when the target task is terminal', () => {
    const { outcome, rec } = deliver({ getTask: () => task('done') });
    expect(outcome).toEqual({ action: 'failed', reason: 'target_task_terminal' });
    expect(rec.failed[0].failure).toEqual({ terminal: true, reason: 'target_task_terminal' });
    expect(rec.saved).toEqual([]);
  });

  it('defers a stopped task leaving the ledger pending', () => {
    const { outcome, rec } = deliver({ getTask: () => task('stopped') });
    expect(outcome).toEqual({ action: 'deferred', reason: 'task_stopped' });
    expect(rec.failed).toEqual([]);
    expect(rec.delivered).toEqual([]);
    expect(rec.saved).toEqual([]);
  });

  it('defers when the target has no active session', () => {
    const { outcome, rec } = deliver({ listExecutions: () => [] });
    expect(outcome).toEqual({ action: 'deferred', reason: 'no_active_session' });
    expect(rec.saved).toEqual([]);
    expect(rec.jobs).toEqual([]);
    expect(rec.delivered).toEqual([]);
  });

  it('treats rate budget overflow as a deferral, not a failure', () => {
    const { outcome, rec } = deliver({ withinRateBudget: () => false });
    expect(outcome).toEqual({ action: 'deferred', reason: 'rate_budget' });
    expect(rec.failed).toEqual([]);
    expect(rec.saved).toEqual([]);
    expect(rec.jobs).toEqual([]);
    expect(rec.delivered).toEqual([]);
  });

  it('defers when the row carries no render block', () => {
    const { outcome, rec } = deliver({}, { render: null });
    expect(outcome).toEqual({ action: 'deferred', reason: 'render_missing' });
    expect(rec.saved).toEqual([]);
    expect(rec.jobs).toEqual([]);
  });

  it('replaying the same input reuses the same row and job without duplicates', () => {
    const { deps, rec } = makeDeps();
    const first = deliverImmediateEvent(deps, input());
    const second = deliverImmediateEvent(deps, input());
    expect(first.action).toBe('delivered');
    expect(second.action).toBe('delivered');
    if (second.action !== 'delivered' || first.action !== 'delivered') return;
    expect(second.messageUuid).toBe(first.messageUuid);
    expect(rec.saved.length).toBe(1);
    expect(rec.jobs.length).toBe(1);
    expect(rec.jobs[0].messageUuid).toBe(first.messageUuid);
  });

  it('reports a persist error and leaves the ledger pending', () => {
    const base = makeDeps();
    const { outcome, rec } = deliver({
      messages: {
        ...base.deps.messages,
        saveUserMessage: () => {
          throw new Error('db locked');
        },
      },
    });
    expect(outcome.action).toBe('error');
    if (outcome.action !== 'error') return;
    expect(outcome.stage).toBe('persistAndEnqueue');
    expect(rec.delivered).toEqual([]);
    expect(rec.failed).toEqual([]);
  });

  it('reports a ledger-marking error after the mailbox accepted the row and job', () => {
    const base = makeDeps();
    const { outcome, rec } = deliver({
      eventStore: {
        ...base.deps.eventStore,
        markDeliveryDelivered: () => {
          throw new Error('sqlite busy');
        },
      },
    });
    expect(outcome.action).toBe('error');
    expect(rec.saved.length).toBe(1);
    expect(rec.jobs.length).toBe(1);
  });

  it('derives the message uuid deterministically from event id and delivery key', () => {
    const a = buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY);
    expect(a).toBe(buildImmediateEventMessageUuid(EVENT_ID, DELIVERY_KEY));
    expect(a.startsWith(IMMEDIATE_EVENT_MESSAGE_UUID_PREFIX)).toBe(true);
    expect(a).not.toBe(buildImmediateEventMessageUuid(EVENT_ID, 'other-key'));
    expect(a).not.toBe(buildImmediateEventMessageUuid('other-event', DELIVERY_KEY));
  });

  it('pickMechanics switches mechanically on exact session status', () => {
    const ctx = (status: string, sessionId?: string) => ({
      ...input(),
      deps: makeDeps({ getSessionStatus: () => status }).deps,
      sessionId,
    });
    expect(pickMechanics(ctx('processing', SESSION_ID)).mechanics).toBe('steer');
    expect(pickMechanics(ctx('idle', SESSION_ID)).mechanics).toBe('turn');
    expect(pickMechanics(ctx('queued', SESSION_ID)).mechanics).toBe('turn');
    expect(pickMechanics(ctx('processing')).outcome).toEqual({
      action: 'deferred',
      reason: 'no_active_session',
    });
  });
});
