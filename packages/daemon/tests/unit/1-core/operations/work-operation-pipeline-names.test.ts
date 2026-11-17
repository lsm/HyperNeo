import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import { createFindWorkOperation } from '../../../../src/lib/drivers/find-operation';
import { createReadWorkOperation } from '../../../../src/lib/drivers/read-operation';
import { createDriverHealthRuntime } from '../../../../src/lib/drivers/driver-health-runtime';
import { createProjectFolderOperation } from '../../../../src/lib/session/project-folder-operation';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const deps = {} as never;
const caller: OperationCaller = { source: 'rpc', principal: 'local' };
const health = createDriverHealthRuntime(
  { deps: { db: {}, jobQueue: {}, jobProcessor: { register: () => {} } } } as never,
  () => []
).operation;
const operations = [
  ...createWorkVerbOperations(deps).filter((operation) =>
    ['work.rename', 'work.start', 'work.send', 'work.status', 'work.turns', 'work.stop'].includes(
      operation.name
    )
  ),
  createFindWorkOperation(deps),
  createReadWorkOperation(deps),
  createProjectFolderOperation(deps),
  health,
];

describe('work operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve()
        .then(() => operation.execute({} as never, caller))
        .catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
