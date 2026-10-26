import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  createOperationMcpHandler,
  operationRefusal,
  type OperationRefusal,
} from '../../../../src/lib/operations/mcp-adapter';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';

function fixture() {
  const execute = mock(async (input: { text: string }) => ({ text: input.text }));
  const definition = defineOperation({
    name: 'example',
    description: 'Example',
    inputSchema: z.object({ text: z.string() }),
    resultSchema: z.object({ text: z.string() }),
    execute,
  });
  const caller = mock(async () => ({ sessionId: 'trusted-sender' }));
  const handler = createOperationMcpHandler(createOperationRegistry([definition]), caller);
  return { execute, definition, caller, handler };
}

describe('generic operation MCP adapter', () => {
  test('returns accepted bookkeeping records and sends them to the audit as accepted', async () => {
    const record = mock(async (_record: OperationRefusal) => {});
    const definition = defineOperation({
      name: 'example',
      description: 'Recorded success',
      inputSchema: z.object({}),
      resultSchema: z.object({ ok: z.literal(true), records: z.array(z.string()) }),
      execute: async () => ({ ok: true as const, records: ['pr_already_tracked: existing todo'] }),
    });
    const handler = createOperationMcpHandler(
      createOperationRegistry([definition]),
      () => ({ sessionId: 'trusted-sender' }),
      record
    );
    const result = await handler({ name: 'example', input: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      records: ['pr_already_tracked: existing todo'],
    });
    expect(record.mock.calls).toEqual([
      [{ operation: 'example', reason: 'pr_already_tracked: existing todo', accepted: true }],
    ]);
  });

  test('formats the shared result and ignores caller metadata in arguments', async () => {
    const { handler, caller, execute } = fixture();
    expect(
      await handler({ name: 'example', input: { text: 'hello' }, caller: { sessionId: 'spoofed' } })
    ).toEqual({ content: [{ type: 'text', text: '{"text":"hello"}' }] });
    expect(caller).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { text: 'hello' },
      { source: 'mcp', sessionId: 'trusted-sender' }
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('rejects malformed invocations before resolving the caller', async () => {
    const { handler, caller, execute } = fixture();
    const result = await handler({ input: { text: 'hello' } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('invalid_input');
    expect(caller).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  test.each([
    { name: 'missing', input: { text: 'hello' }, code: 'unknown_operation' },
    { name: 'example', input: 42, code: 'invalid_input' },
  ])('formats $code as an MCP tool error without executing', async ({ name, input, code }) => {
    const { handler, execute } = fixture();
    const result = await handler({ name, input });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe(code);
    expect(execute).not.toHaveBeenCalled();
  });
  test.each([
    { input: 'hello' },
    { input: '{"text":"hello"}' },
    { input: 42 },
    { input: null },
    { input: ['hello'] },
  ])(
    'rejects the coerced or primitive input $input before resolving the caller',
    async ({ input }) => {
      const { handler, caller, execute } = fixture();
      const result = await handler({ name: 'example', input });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('invalid_input');
      expect(caller).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    }
  );
  test('formats execution failures without retrying', async () => {
    const { handler, execute } = fixture();
    execute.mockRejectedValue(new Error('unavailable'));
    const result = await handler({ name: 'example', input: { text: 'hello' } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: 'execution_failed',
      message: 'unavailable',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('normalizes caller resolution failures without executing', async () => {
    const { definition, execute } = fixture();
    const handler = createOperationMcpHandler(createOperationRegistry([definition]), async () => {
      throw new Error('caller unavailable');
    });
    const result = await handler({ name: 'example', input: { text: 'hello' } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: 'invocation_failed',
      message: 'caller unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('operationRefusal', () => {
  test.each([
    [{ kind: 'failed', code: 'invalid_input', message: 'bad' }, 'invalid_input'],
    [{ kind: 'completed', value: { accepted: false, reason: 'busy' } }, 'busy'],
    [{ kind: 'completed', value: { ok: false, reason: 'not_found' } }, 'not_found'],
    [{ kind: 'completed', value: { accepted: true, jobId: 'j' } }, null],
    [{ kind: 'completed', value: { accepted: false } }, null],
    [{ kind: 'completed', value: null }, null],
  ] as const)('reads %j as refusal %s', (outcome, reason) => {
    expect(operationRefusal('op', outcome)).toEqual(reason ? { operation: 'op', reason } : null);
  });
});

describe('createOperationMcpHandler refusal recording', () => {
  test('the door records a refusal and not a success', async () => {
    const definition = defineOperation({
      name: 'example',
      description: 'Example',
      inputSchema: z.object({ text: z.string() }),
      resultSchema: z.object({ accepted: z.boolean(), reason: z.string().optional() }),
      execute: async ({ text }) =>
        text === 'no' ? { accepted: false, reason: 'refused' } : { accepted: true },
    });
    const record = mock((_refusal: OperationRefusal) => {});
    const handler = createOperationMcpHandler(
      createOperationRegistry([definition]),
      async () => ({ sessionId: 's' }),
      record
    );
    await handler({ name: 'example', input: { text: 'yes' } });
    await handler({ name: 'example', input: { text: 'no' } });
    expect(record.mock.calls).toEqual([[{ operation: 'example', reason: 'refused' }]]);
  });
});
