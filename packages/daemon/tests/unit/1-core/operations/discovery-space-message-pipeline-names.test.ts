import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createDiscoveryOperations } from '../../../../src/lib/operations/discovery';
import { createSendMessageOperation } from '../../../../src/lib/messaging/message-send';
import { createMessageStatusOperation } from '../../../../src/lib/messaging/message-status';
import { createNodeSendMessageOperation } from '../../../../src/lib/messaging/node-send-message';
import { createSpaceReadOperations } from '../../../../../space/src/space-read-operations';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const caller: OperationCaller = { source: 'rpc' };
const operations = [
  ...createDiscoveryOperations(() => ({}) as never),
  ...createSpaceReadOperations({} as never),
  createSendMessageOperation({} as never, () => null),
  createMessageStatusOperation({} as never),
  createNodeSendMessageOperation({} as never),
];

describe('discovery, space and message operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(
        operation.execute(
          {
            name: 'missing',
            spaceId: 'missing',
            to: 'missing',
            text: 'proof',
            sessionId: 'missing',
            messageId: 'missing',
          } as never,
          caller
        )
      ).catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
