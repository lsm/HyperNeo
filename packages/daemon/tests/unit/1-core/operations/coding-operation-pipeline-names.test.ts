import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createCodingAssignmentOperation } from '../../../../src/lib/neo/packs/coding/assign-operation';
import { createCodingMergeOperation } from '../../../../src/lib/neo/packs/coding/merge-operation';
import { createCodingPrFileOperation } from '../../../../src/lib/neo/packs/coding/pr-file-operation';
import { createCodingResultOperation } from '../../../../src/lib/neo/packs/coding/result-operation';
import { createCodingRetryMergeOperation } from '../../../../src/lib/neo/packs/coding/retry-merge-operation';
import { createCodingSmokeOperation } from '../../../../src/lib/neo/packs/coding/smoke-operation';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const deps = {} as never;
const caller: OperationCaller = { source: 'mcp', role: 'neo' };
const operations = [
  createCodingAssignmentOperation({ db: deps } as never),
  createCodingMergeOperation({ db: deps, todos: deps } as never),
  createCodingPrFileOperation(() => deps, '/tmp', '/tmp'),
  createCodingResultOperation(deps, deps),
  createCodingRetryMergeOperation(() => deps, deps),
  createCodingSmokeOperation(deps, deps, vi.fn()),
];

describe('coding operations', () => {
  test('preserves the smoke runner description while recording entries', () => {
    const operation = createCodingSmokeOperation(deps, deps, vi.fn());
    expect(operation.pipelineRunner.pipeline.name).toBe(operation.name);
  });

  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve()
        .then(() => operation.execute({ todoId: 'missing' } as never, caller))
        .catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
