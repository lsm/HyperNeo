import { expect, test } from 'bun:test';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';

function recoveryRuntime(input: { restarted: boolean; adopted: boolean }) {
  const cancelled: string[] = [];
  const runtime = Object.create(SpaceRuntime.prototype) as SpaceRuntime;
  const internals = runtime as unknown as {
    runtimeGeneration: number;
    isStopped: boolean;
    pausedSpaceIds: Set<string>;
    config: Record<string, unknown>;
    restoreIdleSessionsOwningPendingDeliveries: () => Promise<
      Array<{ action: 'restored'; sessionId: string }>
    >;
    requeuePersistedPendingDeliveries: () => void;
    recoverPendingDeliveriesStrict: () => Promise<void>;
  };
  internals.runtimeGeneration = 1;
  internals.isStopped = false;
  internals.pausedSpaceIds = new Set();
  internals.config = {
    taskAgentManager: {
      cancelBySessionId: (sessionId: string) => cancelled.push(sessionId),
      isSessionAlive: () => input.adopted,
    },
    nodeExecutionRepo: {
      getByAgentSessionId: () =>
        input.adopted ? { status: 'in_progress', agentSessionId: 'session-1' } : null,
    },
  };
  internals.restoreIdleSessionsOwningPendingDeliveries = async () => {
    internals.runtimeGeneration += 1;
    internals.isStopped = !input.restarted;
    return [{ action: 'restored', sessionId: 'session-1' }];
  };
  internals.requeuePersistedPendingDeliveries = () => {};
  return { internals, cancelled };
}

test('a restarted runtime preserves a restored session it has adopted', async () => {
  const { internals, cancelled } = recoveryRuntime({ restarted: true, adopted: true });
  await internals.recoverPendingDeliveriesStrict();
  expect(cancelled).toEqual([]);
});

test('a stopped runtime still cancels restoration from the obsolete generation', async () => {
  const { internals, cancelled } = recoveryRuntime({ restarted: false, adopted: true });
  await internals.recoverPendingDeliveriesStrict();
  expect(cancelled).toEqual(['session-1']);
});

test('a restarted runtime cancels restoration it did not adopt', async () => {
  const { internals, cancelled } = recoveryRuntime({ restarted: true, adopted: false });
  await internals.recoverPendingDeliveriesStrict();
  expect(cancelled).toEqual(['session-1']);
});
