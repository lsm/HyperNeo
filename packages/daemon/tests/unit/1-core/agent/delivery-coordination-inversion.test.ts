import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  SessionCoordinationStallError,
  sessionResetCoordinationLocks,
  withSessionLock,
  withSessionResetCoordination,
} from '../../../../src/lib/agent/message-delivery';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('delivery coordination vs session lock inversion', () => {
  beforeEach(() => {
    process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '50';
  });

  afterEach(() => {
    delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
    sessionResetCoordinationLocks.clear();
  });

  it('documents the hazard: a holder parked on the inner session lock keeps the coordination slot', async () => {
    void withSessionResetCoordination('s-hold-chain', () =>
      withSessionLock('s-hold-chain', () => new Promise<never>(() => {}))
    );
    await tick();

    await expect(
      withSessionResetCoordination('s-hold-chain', async () => 'sent')
    ).rejects.toBeInstanceOf(SessionCoordinationStallError);
  });
});
