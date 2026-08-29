import { describe, expect, test } from 'bun:test';
import {
  runRequeuePendingDelivery,
  type RequeuePendingDeliveryDeps,
} from '../../../../src/lib/space/runtime/requeue-pending-delivery-pipeline.ts';
import type {
  ExternalEventDeliveryRecord,
  ExternalEventRecord,
} from '../../../../src/lib/external-events/types.ts';

const TARGET = {
  workflowRunId: 'run-1',
  taskId: 'task-1',
  nodeId: 'node-1',
  agentName: 'coder',
};

function makeDelivery(
  overrides: Partial<ExternalEventDeliveryRecord> = {}
): ExternalEventDeliveryRecord {
  return {
    eventId: 'evt-1',
    deliveryKey: 'key-1',
    workflowRunId: TARGET.workflowRunId,
    taskId: TARGET.taskId,
    nodeId: TARGET.nodeId,
    agentName: TARGET.agentName,
    state: 'pending',
    failureReason: null,
    deliveredAt: null,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeEventRecord(overrides: Partial<ExternalEventRecord> = {}): ExternalEventRecord {
  return {
    eventId: 'evt-1',
    state: 'published',
    createdAt: 1_700_000_000_000,
    event: {
      id: 'evt-1',
      spaceId: 'space-1',
      source: 'github',
      topic: 'github/owner/repo/pull_request/1.opened',
      occurredAt: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_000,
      dedupeKey: 'dedupe-1',
      summary: 'opened',
      payload: {},
    },
    ...overrides,
  } as ExternalEventRecord;
}

interface DepsState {
  inFlight: Set<string>;
  expired: boolean;
  paused: boolean;
  subscribed: boolean;
  sessionId: string | undefined;
  live: boolean;
  interrupted: boolean;
  failures: Array<{ deliveryKey: string; reason: string }>;
  digestPulls: Array<{ sessionId: string; taskId: string }>;
  probes: Array<{ sessionId: string; taskId: string }>;
}

function makeDeps(state: Partial<DepsState> = {}): RequeuePendingDeliveryDeps {
  const full: DepsState = {
    inFlight: new Set(),
    expired: false,
    paused: false,
    subscribed: true,
    sessionId: 'session-1',
    live: true,
    interrupted: false,
    failures: [],
    digestPulls: [],
    probes: [],
    ...state,
  };
  return {
    isDeliveryInFlight: (key) => full.inFlight.has(key),
    isDeliveryExpired: () => full.expired,
    failDeliveryTerminal: (delivery, reason) => {
      full.failures.push({ deliveryKey: delivery.deliveryKey, reason });
    },
    isTargetSpacePaused: () => full.paused,
    isTargetStillSubscribed: () => full.subscribed,
    resolveTargetSession: () => full.sessionId,
    isSessionLive: () => full.live,
    isSessionInterrupted: () => full.interrupted,
    scheduleDigestPull: (sessionId, taskId) => {
      full.digestPulls.push({ sessionId, taskId });
    },
    scheduleInterruptProbe: (sessionId, taskId) => {
      full.probes.push({ sessionId, taskId });
    },
  };
}

describe('runRequeuePendingDelivery', () => {
  test('schedules a digest pull for a live, subscribed, uninterrupted target', () => {
    const deps = makeDeps();
    const outcome = runRequeuePendingDelivery(deps, {
      delivery: makeDelivery(),
      eventRecord: makeEventRecord(),
    });
    expect(outcome).toEqual({ action: 'schedule', sessionId: 'session-1' });
  });

  test('skips a delivery whose key is already claimed in flight', () => {
    const deps = makeDeps({ inFlight: new Set(['key-1']) });
    const outcome = runRequeuePendingDelivery(deps, {
      delivery: makeDelivery(),
      eventRecord: makeEventRecord(),
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'delivery_in_flight' });
  });

  test('terminally fails an expired delivery instead of re-arming it', () => {
    const deps = makeDeps({ expired: true });
    const outcome = runRequeuePendingDelivery(deps, {
      delivery: makeDelivery(),
      eventRecord: makeEventRecord(),
    });
    expect(outcome).toEqual({ action: 'fail', reason: 'ttl_expired' });
  });

  test('skips a delivery whose target space is paused or run is missing', () => {
    const deps = makeDeps({ paused: true });
    const outcome = runRequeuePendingDelivery(deps, {
      delivery: makeDelivery(),
      eventRecord: makeEventRecord(),
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'space_paused_or_missing' });
  });

  test('terminally fails a delivery whose subscription is no longer active', () => {
    const deps = makeDeps({ subscribed: false });
    const outcome = runRequeuePendingDelivery(deps, {
      delivery: makeDelivery(),
      eventRecord: makeEventRecord(),
    });
    expect(outcome).toEqual({ action: 'fail', reason: 'subscription_no_longer_active' });
  });

  test('skips a delivery whose target session is missing or not live', () => {
    const missing = runRequeuePendingDelivery(makeDeps({ sessionId: undefined }), {
      delivery: makeDelivery(),
      eventRecord: makeEventRecord(),
    });
    expect(missing).toEqual({ action: 'skip', reason: 'session_unavailable' });

    const dead = runRequeuePendingDelivery(makeDeps({ live: false }), {
      delivery: makeDelivery(),
      eventRecord: makeEventRecord(),
    });
    expect(dead).toEqual({ action: 'skip', reason: 'session_unavailable' });
  });

  test('probes an interrupted target session instead of scheduling a pull', () => {
    const deps = makeDeps({ interrupted: true });
    const outcome = runRequeuePendingDelivery(deps, {
      delivery: makeDelivery(),
      eventRecord: makeEventRecord(),
    });
    expect(outcome).toEqual({ action: 'probe', sessionId: 'session-1' });
  });
});
