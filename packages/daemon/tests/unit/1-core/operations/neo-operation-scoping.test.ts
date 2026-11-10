import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  listOperationSummaries,
  createDiscoveryOperations,
} from '../../../../src/lib/operations/discovery';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';

const neo: OperationCaller = { source: 'mcp', role: 'neo', sessionId: 'neo-session' };

function fixture() {
  let enabled: string[] = [];
  const execute = mock(async () => ({ ok: true }));
  const operation = defineOperation({
    name: 'task.scoped',
    description: 'Scoped task operation',
    inputSchema: z.object({ required: z.string() }),
    resultSchema: z.object({ ok: z.boolean() }),
    policy: { safetyClass: 'mutate', roles: ['workflow_worker'] },
    execute,
  });
  const owned = {
    ...operation,
    name: 'neo.pack.scoped',
    policy: { safetyClass: 'read' as const },
    pack: { id: 'example', enabledIds: () => enabled },
  };
  const registry = createOperationRegistry([operation, owned]);
  return {
    registry,
    execute,
    enable: () => {
      enabled = ['example'];
    },
  };
}

describe('Neo operation scoping', () => {
  test('a role-gated operation hidden from Neo cannot be invoked, but its legitimate caller can invoke it', async () => {
    const { registry, execute } = fixture();
    expect(listOperationSummaries(registry, neo).some(({ name }) => name === 'task.scoped')).toBe(
      false
    );
    expect(await invokeOperation(registry, 'task.scoped', {}, neo)).toMatchObject({
      code: 'forbidden',
    });
    expect(await invokeOperation(registry, 'task.scoped', { required: 'yes' }, neo)).toMatchObject({
      code: 'forbidden',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(
      await invokeOperation(
        registry,
        'task.scoped',
        { required: 'yes' },
        { source: 'mcp', role: 'workflow_worker' }
      )
    ).toEqual({ kind: 'completed', value: { ok: true } });
  });

  test('a pack-owned operation is refused while disabled and works when enabled in the same session', async () => {
    const { registry, enable } = fixture();
    expect(await invokeOperation(registry, 'neo.pack.scoped', {}, neo)).toMatchObject({
      code: 'forbidden',
    });
    expect(
      listOperationSummaries(registry, neo, true).some(({ name }) => name === 'neo.pack.scoped')
    ).toBe(false);
    const describe = createDiscoveryOperations(() => registry).find(
      ({ name }) => name === 'operations.describe'
    )!;
    expect(await describe.execute({ name: 'neo.pack.scoped' }, neo)).toEqual({
      found: false,
      name: 'neo.pack.scoped',
    });
    enable();
    expect(await invokeOperation(registry, 'neo.pack.scoped', { required: 'yes' }, neo)).toEqual({
      kind: 'completed',
      value: { ok: true },
    });
    expect(
      listOperationSummaries(registry, neo).some(({ name }) => name === 'neo.pack.scoped')
    ).toBe(true);
    expect(await describe.execute({ name: 'neo.pack.scoped' }, neo)).toMatchObject({ found: true });
  });

  test('disabled packs preserve non-Neo access', async () => {
    const { registry } = fixture();
    for (const caller of [
      { source: 'rpc' },
      { source: 'internal' },
      { source: 'mcp', role: 'workflow_worker' },
    ] as OperationCaller[]) {
      expect(
        await invokeOperation(registry, 'neo.pack.scoped', { required: 'yes' }, caller)
      ).toMatchObject({ kind: 'completed' });
    }
  });
});
