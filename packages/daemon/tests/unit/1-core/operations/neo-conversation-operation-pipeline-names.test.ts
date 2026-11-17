import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createNeoCardSearchOperation } from '../../../../src/lib/neo/card-search-operation';
import { createNeoConversationReadOperation } from '../../../../src/lib/neo/conversation-read-operation';
import {
  createNeoConversationAskReadOperation,
  createNeoConversationImageReadOperation,
} from '../../../../src/lib/neo/conversation-ask-read-operation';
import { createNeoDraftRecoveryOperation } from '../../../../src/lib/neo/draft-recovery-operation';
import { createNeoIntakeOperation } from '../../../../src/lib/neo/intake';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const deps = {} as never;
const caller: OperationCaller = { source: 'rpc', principal: 'local' };
const operations = [
  createNeoCardSearchOperation(vi.fn(), vi.fn() as never),
  createNeoConversationReadOperation(deps, deps),
  createNeoConversationAskReadOperation(deps, deps),
  createNeoConversationImageReadOperation(deps, deps),
  createNeoDraftRecoveryOperation(deps),
  createNeoIntakeOperation(deps, deps, deps, deps),
];

describe('Neo conversation operations', () => {
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
