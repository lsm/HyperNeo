import { describe, expect, mock, test } from 'bun:test';
import { ErrorCode, MessageHubHandlerError, type CallContext } from '@hyperneo/shared';
import { z } from 'zod';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';

const context: CallContext = {
  messageId: 'request-1',
  sessionId: 'global',
  method: 'operation.invoke',
  timestamp: 'now',
};
function fixture() {
  const execute = mock(async (input: string) => ({ text: input }));
  const definition = defineOperation({
    name: 'example',
    description: 'Example',
    inputSchema: z.string(),
    resultSchema: z.object({ text: z.string() }),
    execute,
  });
  const caller = mock(async () => ({ sessionId: 'trusted-sender' }));
  const handler = createOperationRpcHandler(createOperationRegistry([definition]), caller);
  return { execute, definition, caller, handler };
}

async function expectCode(pending: unknown, code: ErrorCode) {
  try {
    await pending;
    throw new Error('Expected RPC failure');
  } catch (error) {
    expect(error).toBeInstanceOf(MessageHubHandlerError);
    expect((error as MessageHubHandlerError).code).toBe(code);
  }
}

describe('generic operation RPC adapter', () => {
  test('returns the shared result and derives caller context outside the request', async () => {
    const { handler, caller, execute } = fixture();
    expect(
      await handler({ name: 'example', input: 'hello', caller: { sessionId: 'spoofed' } }, context)
    ).toEqual({ text: 'hello' });
    expect(caller).toHaveBeenCalledWith(context);
    expect(execute).toHaveBeenCalledWith('hello', { source: 'rpc', sessionId: 'trusted-sender' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('rejects a malformed invocation before resolving caller or executing', async () => {
    const { handler, caller, execute } = fixture();
    await expectCode(handler({ input: 'hello' }, context), ErrorCode.INVALID_PARAMS);
    expect(caller).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test.each([
    { name: 'missing', input: 'hello', code: ErrorCode.METHOD_NOT_FOUND },
    { name: 'example', input: 42, code: ErrorCode.INVALID_PARAMS },
  ])('maps $code without executing', async ({ name, input, code }) => {
    const { handler, execute } = fixture();
    await expectCode(handler({ name, input }, context), code);
    expect(execute).not.toHaveBeenCalled();
  });

  test('maps execution and output validation failures to handler errors', async () => {
    const { handler, execute, definition } = fixture();
    execute.mockRejectedValue(new Error('failed'));
    await expectCode(
      handler({ name: 'example', input: 'hello' }, context),
      ErrorCode.HANDLER_ERROR
    );
    const invalid = createOperationRpcHandler(
      createOperationRegistry([{ ...definition, execute: async () => null }]),
      () => ({})
    );
    await expectCode(
      invalid({ name: 'example', input: 'hello' }, context),
      ErrorCode.HANDLER_ERROR
    );
  });

  test('does not execute if caller resolution rejects', async () => {
    const { definition, execute } = fixture();
    const handler = createOperationRpcHandler(createOperationRegistry([definition]), async () => {
      throw new Error('caller unavailable');
    });
    await expect(handler({ name: 'example', input: 'hello' }, context)).rejects.toThrow(
      'caller unavailable'
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
