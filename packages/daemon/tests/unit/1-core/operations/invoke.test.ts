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
  test.each([
    'input',
    'result',
  ] as const)('normalizes throwing and rejecting %s schema callbacks', async (phase) => {
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
  });
});
