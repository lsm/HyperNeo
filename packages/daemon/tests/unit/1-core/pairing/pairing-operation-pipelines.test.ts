import { describe, expect, test } from 'bun:test';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createPairWaits } from '../../../../src/lib/pairing/pair-waits';
import type { PairingLimiter } from '../../../../src/lib/pairing/pairing-limiter';
import { createDevicePairingOperations } from '../../../../src/lib/pairing/pairing-operations';
import type { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';

const inputs: Record<string, unknown> = {
  'device.pair.create': { kind: 'human' },
  'device.pair.pending': {},
  'device.pair.approve': { codeId: 'code-1' },
  'device.pair.terminal_approval.get': {},
  'device.pair.terminal_approval.set': { enabled: false },
  'device.pair.deny': { codeId: 'code-1' },
  'device.list': {},
  'device.unpaired.list': {},
  'device.would_refuse.list': {},
  'device.revoke': { deviceId: 'device-2' },
  'device.pair.reset_lockout': {},
};

const caller: OperationCaller = {
  source: 'rpc',
  principal: 'local',
  device: { deviceId: 'device-1', kind: 'human' },
};

const brokenStore = {
  repo: (): DevicePairingRepository => {
    throw new Error('store unavailable');
  },
  limiter: {
    reset: () => {
      throw new Error('store unavailable');
    },
  } as unknown as PairingLimiter,
  now: () => 1_000,
  revoked: () => {},
  waits: createPairWaits(),
};

describe('createDevicePairingOperations', () => {
  test('covers every device operation', () => {
    const operations = createDevicePairingOperations(brokenStore);
    expect(operations.map((operation) => operation.name).sort()).toEqual(
      Object.keys(inputs).sort()
    );
  });

  for (const [name, input] of Object.entries(inputs)) {
    test(`${name} reaches the store through a superpipe pipeline`, async () => {
      const operation = createDevicePairingOperations(brokenStore).find(
        (candidate) => candidate.name === name
      );
      const failure = await Promise.resolve()
        .then(() => operation?.execute(input as never, caller))
        .then(
          () => null,
          (error: Error) => error
        );
      expect(failure?.message).toBe('store unavailable');
      expect(failure?.stack).toContain('superpipe');
    });
  }
});
