import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { LOCAL_RPC_PRINCIPAL } from '../../../../src/lib/operations/caller';
import { invokeOperationFromHandler } from '../../../../src/lib/operations/handler-invoker';
import {
  createOperationRegistry,
  defineOperation,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry';

const OPERATION = 'probe.run';

function registryReturning(result: unknown): {
  registry: OperationRegistry;
  execute: ReturnType<typeof mock>;
} {
  const execute = mock(async () => result);
  return {
    execute,
    registry: createOperationRegistry([
      defineOperation({
        name: OPERATION,
        description: 'Probe the handler seam',
        inputSchema: z.object({ goalId: z.string() }),
        resultSchema: z.unknown(),
        execute,
      }),
    ]),
  };
}

describe('invokeOperationFromHandler', () => {
  test('returns an acceptance and calls the operation as the local RPC principal', async () => {
    const { registry, execute } = registryReturning({ accepted: true, goal: { id: 'goal-1' } });
    const result = await invokeOperationFromHandler<{ accepted: true; goal: { id: string } }>(
      registry,
      OPERATION,
      { goalId: 'goal-1' }
    );
    expect(result).toEqual({ accepted: true, goal: { id: 'goal-1' } });
    expect(execute).toHaveBeenCalledWith(
      { goalId: 'goal-1' },
      { source: 'rpc', principal: LOCAL_RPC_PRINCIPAL }
    );
  });

  test('throws the carried message for an accepted:false rejection', async () => {
    const { registry } = registryReturning({
      accepted: false,
      reason: 'goal_not_found',
      message: 'Goal not found: goal-1',
    });
    await expect(
      invokeOperationFromHandler(registry, OPERATION, { goalId: 'goal-1' })
    ).rejects.toThrow('Goal not found: goal-1');
  });

  test('throws the carried message for a rejected:true rejection', async () => {
    const { registry } = registryReturning({
      rejected: true,
      reason: 'agent_denied',
      message: 'Agent agent-1 may not own goals in this space',
    });
    await expect(
      invokeOperationFromHandler(registry, OPERATION, { goalId: 'goal-1' })
    ).rejects.toThrow('Agent agent-1 may not own goals in this space');
  });

  test('names the operation when a rejection carries no message', async () => {
    const { registry } = registryReturning({ rejected: true, reason: 'agent_denied' });
    await expect(
      invokeOperationFromHandler(registry, OPERATION, { goalId: 'goal-1' })
    ).rejects.toThrow(`Operation ${OPERATION} was rejected without a message`);
  });

  test('throws instead of casting a result that is neither an acceptance nor a rejection', async () => {
    const { registry } = registryReturning({ goal: { id: 'goal-1' } });
    await expect(
      invokeOperationFromHandler(registry, OPERATION, { goalId: 'goal-1' })
    ).rejects.toThrow(
      `Operation ${OPERATION} returned a result the handler seam does not recognize`
    );
  });

  test('throws for a non-object result rather than returning it', async () => {
    const { registry } = registryReturning(null);
    await expect(
      invokeOperationFromHandler(registry, OPERATION, { goalId: 'goal-1' })
    ).rejects.toThrow(
      `Operation ${OPERATION} returned a result the handler seam does not recognize`
    );
  });

  test('surfaces an invocation failure message', async () => {
    const { registry } = registryReturning({ accepted: true });
    await expect(invokeOperationFromHandler(registry, 'probe.missing', {})).rejects.toThrow(
      'Unknown operation: probe.missing'
    );
  });
});
