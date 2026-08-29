import { describe, expect, test } from 'bun:test';
import {
  runRestoreIdleSessions,
  type RestoreIdleSessionsDeps,
} from '../../../../src/lib/space/runtime/restore-idle-sessions-pipeline.ts';
import type {
  ExternalEventDeliveryRecord,
  ExternalEventRecord,
} from '../../../../src/lib/external-events/types.ts';

const DELIVERY: ExternalEventDeliveryRecord = {
  eventId: 'evt-1',
  deliveryKey: 'key-1',
  workflowRunId: 'run-1',
  taskId: 'task-1',
  nodeId: 'node-1',
  agentName: 'coder',
  state: 'pending',
  failureReason: null,
  deliveredAt: null,
  updatedAt: 1_700_000_000_000,
};

function makeEventRecord(): ExternalEventRecord {
  return {
    eventId: 'evt-1',
    state: 'published',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
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
  } as ExternalEventRecord;
}

interface DepsState {
  inFlight: Set<string>;
  expired: boolean;
  paused: boolean;
  spaceState: { paused: boolean; stopped: boolean } | null;
  spaceStateAfterRestore: { paused: boolean; stopped: boolean } | null;
  subscribed: boolean;
  taskStatus: string | null;
  hasIdleExecution: boolean;
  restores: string[];
  cancels: string[];
  failRestore: boolean;
}

function makeDeps(state: Partial<DepsState> = {}): RestoreIdleSessionsDeps {
  const full: DepsState = {
    inFlight: new Set(),
    expired: false,
    paused: false,
    spaceState: { paused: false, stopped: false },
    spaceStateAfterRestore: null,
    subscribed: true,
    taskStatus: 'in_progress',
    hasIdleExecution: true,
    restores: [],
    cancels: [],
    failRestore: false,
    ...state,
  };
  let spaceStateCalls = 0;
  return {
    listPendingDeliveries: () => [DELIVERY],
    getEventRecord: () => makeEventRecord(),
    isDeliveryInFlight: (key) => full.inFlight.has(key),
    isDeliveryExpired: () => full.expired,
    getRunSpaceId: () => (full.paused ? undefined : 'space-1'),
    isSpacePaused: () => full.paused,
    getSpaceState: async () => {
      spaceStateCalls += 1;
      if (spaceStateCalls <= 1) return full.spaceState ?? { paused: false, stopped: false };
      return full.spaceStateAfterRestore ?? full.spaceState ?? { paused: false, stopped: false };
    },
    isTargetStillSubscribed: () => full.subscribed,
    isTaskAdmissible: () =>
      !!full.taskStatus &&
      !['cancelled', 'archived', 'done', 'rate_limited', 'usage_limited'].includes(full.taskStatus),
    findIdleExecutionWithDeadSession: () =>
      full.hasIdleExecution ? { executionId: 'exec-1', agentSessionId: 'session-1' } : undefined,
    restoreSession: async (target) => {
      if (full.failRestore) throw new Error('restore exploded');
      full.restores.push(target.agentName);
    },
    cancelSession: (sessionId) => {
      full.cancels.push(sessionId);
    },
  };
}

describe('runRestoreIdleSessions', () => {
  test('restores an admissible idle session', async () => {
    const deps = makeDeps();
    const outcomes = await runRestoreIdleSessions(deps);
    expect(outcomes).toEqual([{ action: 'restored', sessionId: 'session-1' }]);
    expect(deps === undefined).toBe(false);
  });

  test('skips in-flight, expired, paused-run, stopped-space, unsubscribed, and terminal-task deliveries', async () => {
    expect(await runRestoreIdleSessions(makeDeps({ inFlight: new Set(['key-1']) }))).toEqual([]);
    expect(await runRestoreIdleSessions(makeDeps({ expired: true }))).toEqual([]);
    expect(await runRestoreIdleSessions(makeDeps({ paused: true }))).toEqual([]);
    expect(
      await runRestoreIdleSessions(makeDeps({ spaceState: { paused: false, stopped: true } }))
    ).toEqual([]);
    expect(await runRestoreIdleSessions(makeDeps({ subscribed: false }))).toEqual([]);
    expect(await runRestoreIdleSessions(makeDeps({ taskStatus: 'cancelled' }))).toEqual([]);
    expect(await runRestoreIdleSessions(makeDeps({ taskStatus: null }))).toEqual([]);
  });

  test('defers restoration for rate-limited and usage-limited tasks', async () => {
    expect(await runRestoreIdleSessions(makeDeps({ taskStatus: 'rate_limited' }))).toEqual([]);
    expect(await runRestoreIdleSessions(makeDeps({ taskStatus: 'usage_limited' }))).toEqual([]);
  });

  test('skips when no idle execution with a dead session exists', async () => {
    expect(await runRestoreIdleSessions(makeDeps({ hasIdleExecution: false }))).toEqual([]);
  });

  test('tears down a restored session whose space stopped during restoration', async () => {
    const deps = makeDeps({
      spaceStateAfterRestore: { paused: false, stopped: true },
    });
    const outcomes = await runRestoreIdleSessions(deps);
    expect(outcomes).toEqual([{ action: 'skipped_stopped_space', sessionId: 'session-1' }]);
  });

  test('records a failed outcome when restoration throws', async () => {
    const outcomes = await runRestoreIdleSessions(makeDeps({ failRestore: true }));
    expect(outcomes).toEqual([{ action: 'failed' }]);
  });

  test('a rejected first delivery does not consume the target dedupe slot', async () => {
    const expiredRecord = makeEventRecord();
    expiredRecord.createdAt = 1;
    const validRecord = makeEventRecord();
    validRecord.createdAt = Date.now();
    const deps = makeDeps();
    const scopedDeps: RestoreIdleSessionsDeps = {
      ...deps,
      listPendingDeliveries: () => [
        { ...DELIVERY, eventId: 'evt-expired', deliveryKey: 'key-expired' },
        { ...DELIVERY, eventId: 'evt-valid', deliveryKey: 'key-valid' },
      ],
      getEventRecord: (eventId) => (eventId === 'evt-expired' ? expiredRecord : validRecord),
      isDeliveryExpired: (createdAt) => createdAt <= 1,
    };
    const outcomes = await runRestoreIdleSessions(scopedDeps);
    expect(outcomes).toEqual([{ action: 'restored', sessionId: 'session-1' }]);
  });
});
