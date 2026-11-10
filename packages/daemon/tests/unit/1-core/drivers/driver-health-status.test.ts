import { expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

test('adapter discovery exposes unavailable local drivers with their concrete reason', async () => {
  const health = {
    'codex-desktop': {
      status: 'unavailable',
      reason: 'Codex state database is missing.',
      clientVersions: { desktop: '2.0.0' },
      checkedAt: 1,
      unverifiedVersion: true,
    },
  };
  const deps = {
    adapters: () => [],
    daemonName: 'synthetic',
    remote: { list: () => [], invoke: async () => ({}) },
    health: () => health,
  };
  const registry = createOperationRegistry(createWorkVerbOperations(deps));
  const result = await invokeOperation(registry, 'work.adapters', {}, { source: 'rpc' });
  expect(result).toMatchObject({
    kind: 'completed',
    value: {
      ok: true,
      value: [{ id: 'codex-desktop', capabilities: [], health: health['codex-desktop'] }],
    },
  });
});
