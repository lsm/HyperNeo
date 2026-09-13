import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';

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
  const handler = createOperationMcpHandler(createOperationRegistry([definition]), caller);
  return { execute, definition, caller, handler };
}

describe('generic operation MCP adapter', () => {
  test('formats the shared result and ignores caller metadata in arguments', async () => {
    const { handler, caller, execute } = fixture();
    expect(
      await handler({ name: 'example', input: 'hello', caller: { sessionId: 'spoofed' } })
    ).toEqual({ content: [{ type: 'text', text: '{"text":"hello"}' }] });
    expect(caller).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('hello', { source: 'mcp', sessionId: 'trusted-sender' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('rejects malformed invocations before resolving the caller', async () => {
    const { handler, caller, execute } = fixture();
    const result = await handler({ input: 'hello' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('invalid_input');
    expect(caller).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  test.each([
    { name: 'missing', input: 'hello', code: 'unknown_operation' },
    { name: 'example', input: 42, code: 'invalid_input' },
  ])('formats $code as an MCP tool error without executing', async ({ name, input, code }) => {
    const { handler, execute } = fixture();
    const result = await handler({ name, input });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe(code);
    expect(execute).not.toHaveBeenCalled();
  });
  test('formats execution failures without retrying', async () => {
    const { handler, execute } = fixture();
    execute.mockRejectedValue(new Error('unavailable'));
    const result = await handler({ name: 'example', input: 'hello' });
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
    const result = await handler({ name: 'example', input: 'hello' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: 'invocation_failed',
      message: 'caller unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });
  test('forwards audit hooks into the shared invocation pipeline', async () => {
    const { definition, caller } = fixture();
    const before = mock(() => {});
    const after = mock(() => {});
    const handler = createOperationMcpHandler(createOperationRegistry([definition]), caller, {
      before,
      after,
    });
    await handler({ name: 'example', input: 'hello' });
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after.mock.calls[0][2]).toEqual({ kind: 'completed', value: { text: 'hello' } });
  });
});
