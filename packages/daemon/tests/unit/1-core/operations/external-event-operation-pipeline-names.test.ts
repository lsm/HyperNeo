import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createSessionEventOperations } from '../../../../src/lib/external-events/session-event-operations';
import { createSubscriptionOperations } from '../../../../../space/src/external-events/subscription-operations';
import { createAgentSubscriptionOperations } from '../../../../../space/src/external-events/agent-subscription-operations';
import { createGetExternalEventOperation } from '../../../../../space/src/external-events/get-event-operation';
import { createListDeliveriesOperation } from '../../../../../space/src/external-events/list-deliveries-operation';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const deps = {} as never;
const caller: OperationCaller = { source: 'rpc', principal: 'local' };
const operations = [
  ...createSessionEventOperations(deps),
  ...createSubscriptionOperations(deps),
  ...createAgentSubscriptionOperations(deps),
  createGetExternalEventOperation(deps),
  createListDeliveriesOperation(deps),
];

describe('external event operations', () => {
  test('covers eleven entry paths', () => {
    expect(operations).toHaveLength(11);
  });
  test.each(operations.map((operation, index) => [index, operation] as const))(
    'entry path %s uses its operation name',
    async (_index, operation) => {
      entered.length = 0;
      await Promise.resolve()
        .then(() => operation.execute({ eventId: 'missing' } as never, caller))
        .catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
