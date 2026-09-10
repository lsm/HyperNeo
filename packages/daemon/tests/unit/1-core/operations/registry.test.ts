import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';

function example(name = 'message.send') {
  return defineOperation({
    name,
    description: 'Accept a message',
    inputSchema: z.object({ content: z.string() }),
    resultSchema: z.object({ accepted: z.boolean() }),
    execute: async () => ({ accepted: true }),
  });
}

describe('operation registry', () => {
  test('looks up shared definitions without invoking them', () => {
    const execute = mock(async () => ({ accepted: true }));
    const definition = { ...example(), execute };
    const registry = createOperationRegistry([definition]);
    expect(registry.get('message.send')).toBe(registry.entries[0]);
    expect(registry.get('message.send')?.inputSchema).toBe(definition.inputSchema);
    expect(registry.get('message.send')?.resultSchema).toBe(definition.resultSchema);
    expect(registry.get('missing')).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  test('snapshots definitions and catalog membership', () => {
    const definition = example();
    const definitions = [definition];
    const registry = createOperationRegistry(definitions);
    definitions.push(example('session.create'));
    Object.assign(definition, { name: 'changed', description: 'changed' });
    expect(registry.entries).toHaveLength(1);
    expect(registry.get('message.send')?.description).toBe('Accept a message');
    expect(registry.get('changed')).toBeUndefined();
    expect(Object.isFrozen(registry.entries)).toBe(true);
    expect(Object.isFrozen(registry.entries[0])).toBe(true);
  });

  test('rejects ambiguous duplicate registrations', () => {
    expect(() => createOperationRegistry([example(), example()])).toThrow('Duplicate operation');
  });

  test.each([
    '',
    ' message.send',
    'message..send',
    '.send',
    'message.send.',
    'message/send',
  ])('rejects malformed name %j', (name) => {
    expect(() => createOperationRegistry([example(name)])).toThrow('Invalid operation name');
  });

  test('preserves typed execution results and caller identity', async () => {
    const caller: OperationCaller = { source: 'mcp', sessionId: 'sender' };
    const execute = mock(async (input: { content: string }, actual: OperationCaller) => ({
      text: input.content,
      sender: actual.sessionId,
    }));
    const definition = defineOperation({
      name: 'message.inspect',
      description: 'Inspect input',
      inputSchema: z.object({ content: z.string() }),
      resultSchema: z.object({ text: z.string(), sender: z.string().optional() }),
      execute,
    });
    const input = { content: 'hello' };
    expect(await definition.execute(input, caller)).toEqual({ text: 'hello', sender: 'sender' });
    expect(execute).toHaveBeenCalledWith(input, caller);
  });
});
