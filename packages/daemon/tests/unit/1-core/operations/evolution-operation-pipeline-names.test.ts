import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createEvolutionEpisodeOperations } from '../../../../../space/src/evolution/episode-operations';
import { createEvolutionEvidenceAttachOperation } from '../../../../../space/src/evolution/evidence-attach-operation';
import { createEvolutionScopeGetOperation } from '../../../../../space/src/evolution/scope-get-operation';
import { createEvolutionScopeOperations } from '../../../../../space/src/evolution/scope-operations';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const deps = {} as never;
const caller: OperationCaller = { source: 'rpc', principal: 'local' };
const operations = [
  ...createEvolutionEpisodeOperations(deps),
  createEvolutionEvidenceAttachOperation(deps),
  createEvolutionScopeGetOperation(deps),
  ...createEvolutionScopeOperations(deps),
];

describe('evolution operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(
        operation.execute({ spaceId: 'missing', scopeId: 'missing' } as never, caller)
      ).catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
