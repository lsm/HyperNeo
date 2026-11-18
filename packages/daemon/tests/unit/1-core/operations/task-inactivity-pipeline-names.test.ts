import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createHandoffWorkerSessionOperation } from '../../../../src/lib/tasks/handoff-worker-session';
import { createListTaskMembersOperation } from '../../../../src/lib/tasks/list-task-members';
import { createRetryTaskOperation } from '../../../../src/lib/tasks/retry-task';
import { createSetPreferredWorkflowOperation } from '../../../../src/lib/tasks/set-preferred-workflow';
import { createStartTaskOperation } from '../../../../src/lib/tasks/start-task';
import { createInactivityOperations } from '../../../../../space/src/agents/inactivity-operations';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const caller: OperationCaller = { source: 'rpc' };
const operations = [
  createHandoffWorkerSessionOperation({} as never),
  createListTaskMembersOperation({ admitTask: () => true } as never),
  createRetryTaskOperation(() => {
    throw new Error('missing');
  }, {} as never),
  createSetPreferredWorkflowOperation({} as never),
  createStartTaskOperation(
    () => {
      throw new Error('missing');
    },
    {} as never,
    {} as never,
    {} as never
  ),
  ...createInactivityOperations({} as never),
];

describe('task and inactivity operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(operation.execute({ taskId: 'missing' } as never, caller)).catch(
        () => undefined
      );
      expect(entered[0]).toBe(operation.name);
    }
  );
});
