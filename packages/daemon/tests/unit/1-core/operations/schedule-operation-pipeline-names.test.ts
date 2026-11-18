import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createScheduleOperations } from '../../../../src/lib/schedule/operations';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const caller: OperationCaller = { source: 'rpc' };
const operations = createScheduleOperations({} as never);

describe('schedule operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(
        operation.execute({ spaceId: 'missing', scheduleId: 'missing' } as never, caller)
      ).catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
