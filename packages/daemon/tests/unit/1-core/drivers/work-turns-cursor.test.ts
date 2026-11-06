import { describe, expect, test } from 'bun:test';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';

const ref = { adapter: 'hyperneo', id: 'worker' };
const adapter = {
  id: 'hyperneo',
  capabilities: ['find', 'turns'],
  find: () => [],
  turns: async () => ({ ok: true, value: { turns: [] } }),
} as unknown as WorkAdapter;
const registry = createOperationRegistry(
  createWorkVerbOperations({
    adapters: () => [adapter],
    remote: { list: () => [], invoke: async () => ({}) },
    daemonName: 'fixture',
  } as never)
);
const read = (cursor: string) =>
  invokeOperation(registry, 'work.turns', { ref, cursor }, { source: 'internal', role: 'neo' });

describe('work.turns cursor', () => {
  test('work.adapters lists the turns capability', async () => {
    expect(
      await invokeOperation(registry, 'work.adapters', {}, { source: 'internal', role: 'neo' })
    ).toMatchObject({ value: { value: [{ capabilities: ['find', 'turns'] }] } });
  });

  test('a cursor a reader wrote is accepted', async () => {
    expect(await read('{"seq":1,"consumed":1,"at":null}')).toMatchObject({
      kind: 'completed',
      value: { ok: true },
    });
  });

  test.each([
    'not json',
    'null',
    '7',
    '{}',
    '[1,2]',
    '{"seq":-1,"consumed":0}',
    '{"seq":1.5,"consumed":0}',
  ])('%s is refused as invalid input', async (cursor) => {
    expect(await read(cursor)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  });
});
