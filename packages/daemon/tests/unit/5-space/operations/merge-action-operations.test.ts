import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import { mergeActionOperations } from '../../../../src/lib/space/actions/action-operations.ts';
import { createActionRegistry, defineAction } from '../../../../src/lib/space/actions/registry.ts';

const rpcCaller = { source: 'rpc' as const };

function legacyAction(name: string, result: string) {
  return defineAction({
    name,
    family: 'node',
    safetyClass: 'read',
    description: `legacy ${name}`,
    paramsDoc: 'none',
    paramsSchema: z.object({}),
    handler: async () => result,
  });
}

function bootOperation(name: string, result: string) {
  return defineOperation({
    name,
    description: `ported ${name}`,
    inputSchema: z.object({}),
    resultSchema: z.string(),
    execute: async () => result,
  });
}

describe('mergeActionOperations', () => {
  test('a boot-time operation shadows a legacy action with the same name', async () => {
    const actions = createActionRegistry([
      legacyAction('subscribe_pr_events', 'legacy'),
      legacyAction('list_peers', 'legacy peers'),
    ]);
    const merged = mergeActionOperations([bootOperation('subscribe_pr_events', 'ported')], actions);
    const registry = createOperationRegistry(merged);
    expect(merged.map((operation) => operation.name)).toEqual([
      'subscribe_pr_events',
      'list_peers',
    ]);
    await expect(registry.get('subscribe_pr_events')?.execute({}, rpcCaller)).resolves.toBe(
      'ported'
    );
    await expect(registry.get('list_peers')?.execute({}, rpcCaller)).resolves.toBe('legacy peers');
  });

  test('folds every legacy action when no name is taken', () => {
    const actions = createActionRegistry([legacyAction('a', 'x'), legacyAction('b', 'y')]);
    const merged = mergeActionOperations([bootOperation('task.get', 'z')], actions);
    expect(merged.map((operation) => operation.name)).toEqual(['task.get', 'a', 'b']);
  });
});
