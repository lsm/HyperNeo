import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import {
  actionAsOperation,
  mergeActionOperations,
} from '../../../../src/lib/space/actions/action-operations.ts';
import { summarizeAuditInput } from '../../../../src/lib/operations/audit.ts';
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

describe('actionAsOperation audit policy', () => {
  test("carries an action's declared redaction keys so the door does not log them", () => {
    const action = defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'legacy send',
      paramsDoc: 'task_id, message',
      paramsSchema: z.object({ task_id: z.string(), message: z.string() }),
      auditRedactKeys: ['message'],
      handler: async () => 'sent',
    });
    const operation = actionAsOperation(createActionRegistry([action]).entries[0]);
    expect(operation.policy?.audit?.redactKeys).toEqual(['message']);
    expect(summarizeAuditInput(operation, { task_id: 't-1', message: 'private body' })).toBe(
      JSON.stringify({ task_id: 't-1', message: '[redacted]' })
    );
  });

  test("carries an action's audit exemption", () => {
    const action = defineAction({
      name: 'list_channels',
      family: 'node',
      safetyClass: 'read',
      description: 'legacy list',
      paramsDoc: 'none',
      paramsSchema: z.object({}),
      auditExempt: true,
      handler: async () => 'listed',
    });
    const operation = actionAsOperation(createActionRegistry([action]).entries[0]);
    expect(operation.policy?.audit?.exempt).toBe(true);
  });
});
