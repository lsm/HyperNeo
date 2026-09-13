import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  invokeOperation,
  resolveOperation,
  parseOperationInput,
  executeOperation,
  validateOperationResult,
} from '../../../../src/lib/operations/invoke';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';

const caller = { source: 'rpc' as const, sessionId: 'sender' };
function fixture() {
  const execute = mock(async (input: { content: string }) => ({ accepted: input.content }));
  const operation = defineOperation({
    name: 'message.send',
    description: 'Accept a message',
    inputSchema: z.object({ content: z.string().trim().min(1) }),
    resultSchema: z.object({ accepted: z.string() }),
    execute,
  });
  return { execute, operation, registry: createOperationRegistry([operation]) };
}

describe('operation invocation gates', () => {
  test('lookup rejects unknown names', () => {
    const { registry } = fixture();
    expect(resolveOperation(registry, 'missing')).toEqual({
      reason: { kind: 'failed', code: 'unknown_operation', message: 'Unknown operation: missing' },
    });
  });
  test('input parsing preserves transformations and rejects invalid content', async () => {
    const { operation } = fixture();
    expect(await parseOperationInput(operation, { content: ' hello ' })).toEqual({
      value: { operation, input: { content: 'hello' } },
    });
    expect(await parseOperationInput(operation, { content: '' })).toMatchObject({
      reason: { kind: 'failed', code: 'invalid_input' },
    });
  });
  test('execution passes caller context and maps rejection', async () => {
    const { operation, execute } = fixture();
    await executeOperation({ operation, input: { content: 'hello' } }, caller);
    expect(execute).toHaveBeenCalledWith({ content: 'hello' }, caller);
    execute.mockRejectedValue(new Error('unavailable'));
    expect(await executeOperation({ operation, input: {} }, caller)).toEqual({
      reason: { kind: 'failed', code: 'execution_failed', message: 'unavailable' },
    });
  });
  test('result validation rejects unexpected data', async () => {
    const { operation } = fixture();
    expect(await validateOperationResult({ operation, result: { accepted: 12 } })).toMatchObject({
      reason: { kind: 'failed', code: 'invalid_result' },
    });
  });
});

describe('shared operation invocation', () => {
  test('returns the result after parsing input and executes once', async () => {
    const { registry, execute } = fixture();
    expect(await invokeOperation(registry, 'message.send', { content: ' hello ' }, caller)).toEqual(
      {
        kind: 'completed',
        value: { accepted: 'hello' },
      }
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ content: 'hello' }, caller);
  });
  test.each([
    { name: 'missing', input: {}, code: 'unknown_operation' },
    { name: 'message.send', input: { content: '' }, code: 'invalid_input' },
  ])('halts before execution for $code', async ({ name, input, code }) => {
    const { registry, execute } = fixture();
    expect(await invokeOperation(registry, name, input, caller)).toMatchObject({
      kind: 'failed',
      code,
    });
    expect(execute).not.toHaveBeenCalled();
  });
  test('does not retry a failed execution', async () => {
    const { registry, execute } = fixture();
    execute.mockRejectedValue(new Error('unavailable'));
    expect(await invokeOperation(registry, 'message.send', { content: 'hello' }, caller)).toEqual({
      kind: 'failed',
      code: 'execution_failed',
      message: 'unavailable',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('awaits asynchronous schemas and applies result transformations', async () => {
    const operation = defineOperation({
      name: 'example',
      description: 'Async schemas',
      inputSchema: z.string().refine(async (value) => value === 'valid'),
      resultSchema: z.string().transform(async (value) => value.toUpperCase()),
      execute: async (input) => input,
    });
    const registry = createOperationRegistry([operation]);
    expect(await invokeOperation(registry, 'example', 'valid', caller)).toEqual({
      kind: 'completed',
      value: 'VALID',
    });
    expect(await invokeOperation(registry, 'example', 'invalid', caller)).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
  });
  test('invalid output is a failure after execution, not a completed result', async () => {
    const { operation } = fixture();
    const registry = createOperationRegistry([{ ...operation, execute: async () => null }]);
    expect(
      await invokeOperation(registry, 'message.send', { content: 'hello' }, caller)
    ).toMatchObject({
      kind: 'failed',
      code: 'invalid_result',
    });
  });
  test.each(['input', 'result'] as const)(
    'normalizes throwing and rejecting %s schema callbacks',
    async (phase) => {
      for (const asynchronous of [false, true]) {
        const broken = z.string().transform(() => {
          if (asynchronous) return Promise.reject(new Error('schema callback failed'));
          throw new Error('schema callback failed');
        });
        const execute = mock(async () => 'value');
        const registry = createOperationRegistry([
          defineOperation({
            name: 'example',
            description: 'Broken schema',
            inputSchema: phase === 'input' ? broken : z.string(),
            resultSchema: phase === 'result' ? broken : z.string(),
            execute,
          }),
        ]);
        expect(await invokeOperation(registry, 'example', 'value', caller)).toEqual({
          kind: 'failed',
          code: phase === 'input' ? 'invalid_input' : 'invalid_result',
          message: 'schema callback failed',
        });
        expect(execute).toHaveBeenCalledTimes(phase === 'input' ? 0 : 1);
      }
    }
  );
});

describe('shared operation invocation audit hooks', () => {
  test('before sees the parsed input before execute, after sees the outcome after validation', async () => {
    const { registry, execute } = fixture();
    const order: string[] = [];
    execute.mockImplementation(async (input: { content: string }) => {
      order.push('execute');
      return { accepted: input.content };
    });
    const before = mock((prepared: { input: unknown }) => {
      order.push('before');
      expect(prepared.input).toEqual({ content: 'hello' });
    });
    const after = mock(() => order.push('after'));
    expect(
      await invokeOperation(registry, 'message.send', { content: ' hello ' }, caller, {
        before,
        after,
      })
    ).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(order).toEqual(['before', 'execute', 'after']);
    expect(after.mock.calls[0][2]).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
  });
  test('absent audit is a no-op', async () => {
    const { registry } = fixture();
    expect(await invokeOperation(registry, 'message.send', { content: 'hello' }, caller)).toEqual({
      kind: 'completed',
      value: { accepted: 'hello' },
    });
  });
  test.each([
    { name: 'missing', input: {}, code: 'unknown_operation' },
    { name: 'message.send', input: { content: '' }, code: 'invalid_input' },
  ])('before is skipped when resolve or parse rejects ($code)', async ({ name, input }) => {
    const { registry } = fixture();
    const before = mock(() => {});
    await invokeOperation(registry, name, input, caller, { before });
    expect(before).not.toHaveBeenCalled();
  });
  test('after still runs for an execution_failed outcome', async () => {
    const { registry, execute } = fixture();
    execute.mockRejectedValue(new Error('unavailable'));
    const after = mock(() => {});
    const outcome = await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, {
      after,
    });
    expect(outcome).toEqual({ kind: 'failed', code: 'execution_failed', message: 'unavailable' });
    expect(after).toHaveBeenCalledTimes(1);
    const [prepared, callerArg, outcomeArg] = after.mock.calls[0];
    expect(prepared.input).toEqual({ content: 'hello' });
    expect(callerArg).toEqual(caller);
    expect(outcomeArg).toEqual(outcome);
  });
  test('a hook that throws leaves the invocation result unchanged', async () => {
    const { registry } = fixture();
    const audit = {
      before: () => {
        throw new Error('before boom');
      },
      after: () => {
        throw new Error('after boom');
      },
    };
    expect(
      await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, audit)
    ).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
  });
  test('a mutating before hook cannot change what executeOperation runs', async () => {
    const { registry, execute } = fixture();
    const audit = {
      before: (
        prepared: { input: { content: string } },
        callerArg: { source: string; sessionId?: string }
      ) => {
        prepared.input.content = 'tampered';
        callerArg.source = 'internal';
        callerArg.sessionId = 'hijacked';
      },
    };
    await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, audit);
    expect(execute).toHaveBeenCalledWith({ content: 'hello' }, caller);
  });
  test('a mutating after hook cannot change the returned outcome', async () => {
    const { registry } = fixture();
    const audit = {
      after: (
        _prepared: unknown,
        _caller: unknown,
        outcome: { kind: string; value: { accepted: string } }
      ) => {
        outcome.kind = 'failed';
        outcome.value.accepted = 'tampered';
      },
    };
    expect(
      await invokeOperation(registry, 'message.send', { content: 'hello' }, caller, audit)
    ).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
  });
  test('a handler that mutates its input during execution does not change what after reports', async () => {
    const { operation } = fixture();
    const mutatingExecute = async (input: { content: string }) => {
      input.content = 'mutated-during-execution';
      return { accepted: 'ok' };
    };
    const registry = createOperationRegistry([{ ...operation, execute: mutatingExecute }]);
    const after = mock(() => {});
    await invokeOperation(registry, 'message.send', { content: 'original' }, caller, { after });
    expect(after.mock.calls[0][0].input).toEqual({ content: 'original' });
  });
  test('an async hook that rejects leaves the outcome unchanged and produces no unhandled rejection', async () => {
    let unhandled: unknown = null;
    const onUnhandled = (error: unknown) => {
      unhandled = error;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { registry } = fixture();
      const audit = {
        before: async () => {
          throw new Error('before rejected');
        },
        after: async () => {
          throw new Error('after rejected');
        },
      };
      const outcome = await invokeOperation(
        registry,
        'message.send',
        { content: 'hello' },
        caller,
        audit
      );
      expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
