import { expect, test } from 'bun:test';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';

test('busy worker follow-up is kept for delivery after the turn', async () => {
  const reached: string[] = [];
  const saved: string[] = [];
  const ref = { adapter: 'codex-desktop', id: 'synthetic-worker' };
  const adapter = {
    id: ref.adapter,
    capabilities: ['send', 'status'],
    find: () => [],
    send: async (_ref: unknown, message: string) => {
      reached.push(message);
      return { ok: true, value: { delivered: true } };
    },
    status: async () => ({ ok: true, value: { ref, status: 'running', lastActivityAt: 1 } }),
  } as unknown as WorkAdapter;
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'synthetic',
      queueInput: async (input: { message: string }) => {
        saved.push(input.message);
        return 'synthetic-input';
      },
    })
  );
  const result = await invokeOperation(
    registry,
    'work.send',
    { ref, notice: true, message: 'Keep my follow-up' },
    { source: 'internal', role: 'neo', sessionId: 'synthetic-neo' }
  );
  expect(reached).toEqual([]);
  expect(saved).toEqual(['Keep my follow-up']);
  expect(result).toMatchObject({
    kind: 'completed',
    value: { ok: true, value: { delivered: false, inputId: 'synthetic-input' } },
  });
});
