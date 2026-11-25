import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createSessionOperations } from '../../../../src/lib/session/operations';
import { createSpawnSessionCloneOperation } from '../../../../src/lib/session/clone-operations';
import { createReturnSessionCloneOperation } from '../../../../src/lib/session/clone-return-operation';
import { createSetSessionParentOperation } from '../../../../src/lib/session/parent-operation';
import { createSessionRuntimeSettingsOperations } from '../../../../src/lib/session/runtime-settings-operations';
import { createSessionToolActivationOperation } from '../../../../src/lib/tools/session-tool-activation';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const deps = { exclusive: (_id: string, run: () => Promise<unknown>) => run() } as never;
const caller: OperationCaller = { source: 'rpc', principal: 'local' };
const operations = [
  ...createSessionOperations(deps),
  createSpawnSessionCloneOperation(deps),
  createReturnSessionCloneOperation(deps),
  createSetSessionParentOperation(deps),
  ...createSessionRuntimeSettingsOperations(deps),
  createSessionToolActivationOperation(deps),
];

describe('session operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve()
        .then(() =>
          operation.execute({ spaceId: 'missing', sessionId: 'missing' } as never, caller)
        )
        .catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
