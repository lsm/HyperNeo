import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createOperationMcpServer } from '../../../../src/lib/operations/mcp-server';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';
import { neoReadTools } from '../../../../src/lib/neo/session-config';

const families = {
  neo_work: ['work', ['send', 'find', 'status', 'rename', 'adapters', 'read']],
  neo_todo: [
    'neo.todo',
    ['add', 'continue', 'edit', 'remove', 'hold', 'close', 'bind', 'retry', 'proceed'],
  ],
  neo_publish: ['neo.publication', ['publish']],
  neo_ask: ['neo.ask', ['read', 'settle', 'open', 'topic', 'search', 'outcome']],
  neo_question: ['neo.question', ['ask', 'get', 'retire', 'relay']],
  neo_session: ['neo.session', ['archive']],
  neo_speech: ['neo.speech', ['say']],
} as const;

describe('resident family tools', () => {
  test('maps every resident action through operation validation and the bound caller', async () => {
    const calls: unknown[] = [];
    const registry = createOperationRegistry(
      Object.values(families).flatMap(([prefix, actions]) =>
        actions.map((action) =>
          defineOperation({
            name: `${prefix}.${action}`,
            description: action,
            inputSchema: z.object({ text: z.string().min(1) }),
            resultSchema: z.unknown(),
            execute: async (input, caller) => {
              calls.push({ name: `${prefix}.${action}`, input, caller });
              return input;
            },
          })
        )
      )
    );
    const server = createOperationMcpServer(
      registry,
      () => ({ role: 'neo', sessionId: 'bound' }),
      undefined,
      'neo'
    );
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown) => Promise<{ isError?: boolean }> }
        >;
      }
    )._registeredTools;
    expect(Object.keys(tools).sort()).toEqual(['invoke', ...Object.keys(families)].sort());
    for (const [name, [prefix, actions]] of Object.entries(families)) {
      for (const action of actions) {
        const args = { ...(actions.length > 1 ? { action } : {}), input: { text: 'hello' } };
        expect((await tools[name].handler(args)).isError).not.toBe(true);
        expect(calls.at(-1)).toEqual({
          name: `${prefix}.${action}`,
          input: { text: 'hello' },
          caller: { role: 'neo', sessionId: 'bound', source: 'mcp' },
        });
        expect((await tools[name].handler({ ...args, input: { text: '' } })).isError).toBe(true);
      }
      expect(neoReadTools().allowedTools).toContain(`mcp__hyperneo-operations__${name}`);
    }
    expect(calls).toHaveLength(28);
    await server.instance.close();
  });

  test('keeps non-Neo sessions on the invoke tool', async () => {
    const server = createOperationMcpServer(createOperationRegistry([]), () => ({
      role: 'workflow_worker',
    }));
    expect(
      Object.keys((server.instance as unknown as { _registeredTools: object })._registeredTools)
    ).toEqual(['invoke']);
    await server.instance.close();
  });
});
