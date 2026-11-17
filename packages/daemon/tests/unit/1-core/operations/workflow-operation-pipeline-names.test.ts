import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createWorkflowReadOperations } from '../../../../src/lib/workflows/workflow-read-operations';
import { createWorkflowRunOperations } from '../../../../src/lib/workflows/workflow-run-operations';
import { createListNodeChannelsOperation } from '../../../../src/lib/messaging/node-channels-list';
import { createListNodePeersOperation } from '../../../../src/lib/messaging/node-peers-list';
import { createListNodeReachableAgentsOperation } from '../../../../src/lib/messaging/node-reachable-agents-list';
import {
  createArtifactListOperation,
  createArtifactSaveOperation,
} from '../../../../src/lib/artifacts/artifact-operations';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const deps = {} as never;
const caller: OperationCaller = { source: 'mcp', role: 'long_term_agent' };
const operations = [
  ...createWorkflowReadOperations(deps),
  ...createWorkflowRunOperations(deps),
  createListNodeChannelsOperation(deps),
  createListNodePeersOperation(deps),
  createListNodeReachableAgentsOperation(deps),
  createArtifactListOperation(deps),
  createArtifactSaveOperation(deps),
];

describe('workflow operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(
        operation.execute({ spaceId: 'missing', runId: 'missing' } as never, caller)
      ).catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
