import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createArtifactReadOperations } from '../../../../src/lib/artifacts/read-operations';
import { createArtifactReferenceResolve } from '../../../../src/lib/artifacts/resolve-operation';

const entered = vi.hoisted(() => [] as string[]);

vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const noDatabase = () => {
  throw new Error('no database in this test');
};
const agent: OperationCaller = { source: 'mcp', role: 'long_term_agent' };

const operations = [
  ...createArtifactReadOperations(noDatabase, '/nonexistent'),
  createArtifactReferenceResolve(noDatabase, '/nonexistent', '/nonexistent'),
];

describe('artifact operations', () => {
  test('covers every artifact operation', () => {
    expect(operations.map((operation) => operation.name).sort()).toEqual([
      'artifact.file.get',
      'artifact.file.html',
      'artifact.file.list',
      'artifact.file.read',
      'artifact.reference.resolve',
    ]);
  });

  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(operation.execute({ artifactId: 'artifact-1' } as never, agent)).catch(
        () => undefined
      );
      expect(entered[0]).toBe(operation.name);
      for (const helper of entered.slice(1)) {
        expect(helper.startsWith(`${operation.name}.`)).toBe(true);
      }
    }
  );
});
