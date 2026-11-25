import { describe, expect, test, vi } from 'vitest';
import { createNeoPublicationOperation } from '../../../../src/lib/neo/publication-operation';
import {
  createNeoPublicationReadOperation,
  readNeoPublicationPage,
} from '../../../../src/lib/neo/publication-read-operation';
import type { OperationCaller } from '../../../../src/lib/operations/registry';

const entered = vi.hoisted(() => [] as string[]);

vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const caller: OperationCaller = { source: 'rpc', principal: 'local' };
const ledger = {
  readPageCurrent: (page: never, reader: OperationCaller) =>
    readNeoPublicationPage(page, reader, { conversationId: () => null } as never, {} as never),
};
const operations = [
  createNeoPublicationReadOperation(ledger as never),
  createNeoPublicationOperation({} as never).operation,
];

describe('publication operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(operation.execute({} as never, caller)).catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
