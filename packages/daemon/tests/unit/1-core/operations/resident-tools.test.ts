import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import {
  NEO_RESIDENT_FAMILIES,
  residentOperation,
} from '../../../../src/lib/operations/resident-tools';
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
  test('every production family action exists in the checked daemon catalog', () => {
    const surface = JSON.parse(
      readFileSync(new URL('../../../../../../api-surface.json', import.meta.url), 'utf8')
    ) as { operations: { name: string }[] };
    const names = new Set(surface.operations.map(({ name }) => name));
    for (const family of NEO_RESIDENT_FAMILIES) {
      for (const action of family.actions)
        expect(names.has(residentOperation(family, action))).toBe(true);
    }
  });

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
      () => ({ role: 'neo', sessionId: 'bound', consumedInputId: 'human-input' }),
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
          caller: {
            role: 'neo',
            sessionId: 'bound',
            consumedInputId: 'human-input',
            source: 'mcp',
          },
        });
        expect((await tools[name].handler({ ...args, input: { text: '' } })).isError).toBe(true);
      }
      expect(neoReadTools().allowedTools).toContain(`mcp__hyperneo-operations__${name}`);
    }
    expect(calls).toHaveLength(28);
  });

  test('single-action tools reject an action before dispatch', async () => {
    let executions = 0;
    const names = ['neo.publication.publish', 'neo.session.archive', 'neo.speech.say'];
    const registry = createOperationRegistry(
      names.map((name) =>
        defineOperation({
          name,
          description: name,
          inputSchema: z.object({ text: z.string() }),
          resultSchema: z.unknown(),
          execute: async () => {
            executions++;
            return {};
          },
        })
      )
    );
    const server = createOperationMcpServer(registry, () => ({ role: 'neo' }), undefined, 'neo');
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;
    for (const name of ['neo_publish', 'neo_session', 'neo_speech']) {
      await expect(
        tools[name].handler({ action: 'wrong', input: { text: 'valid' } })
      ).rejects.toThrow();
    }
    expect(executions).toBe(0);
  });

  test('checks live pack admission and records dispatcher refusals', async () => {
    let enabled: string[] = [];
    const records: unknown[] = [];
    let executions = 0;
    const registry = createOperationRegistry([
      defineOperation({
        name: 'neo.todo.add',
        description: 'Add a todo',
        pack: { id: 'coding', enabledIds: () => enabled },
        inputSchema: z.object({ text: z.string() }),
        resultSchema: z.unknown(),
        execute: async () => {
          executions++;
          return { accepted: false, reason: 'not_allowed' };
        },
      }),
    ]);
    const server = createOperationMcpServer(
      registry,
      () => ({ role: 'neo' }),
      (refusal) => {
        records.push(refusal);
      },
      'neo'
    );
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown) => Promise<{ content: { text: string }[] }> }
        >;
      }
    )._registeredTools;
    const call = async (input: unknown) =>
      JSON.parse((await tools.neo_todo.handler({ action: 'add', input })).content[0].text);
    expect((await call({})).code).toBe('forbidden');
    enabled = ['coding'];
    expect((await call({})).code).toBe('invalid_input');
    await call({ text: 'hello' });
    expect(records).toEqual([
      { operation: 'neo.todo.add', reason: 'forbidden' },
      { operation: 'neo.todo.add', reason: 'invalid_input' },
      { operation: 'neo.todo.add', reason: 'not_allowed' },
    ]);
    expect(executions).toBe(1);
  });

  test('keeps non-Neo sessions on the invoke tool', async () => {
    const server = createOperationMcpServer(createOperationRegistry([]), () => ({
      role: 'workflow_worker',
    }));
    expect(
      Object.keys((server.instance as unknown as { _registeredTools: object })._registeredTools)
    ).toEqual(['invoke']);
  });
});

test('a dual-mode Back tool surface omits publication and speech while single mode keeps them', () => {
  const registry = createOperationRegistry([]);
  const names = (speaking: boolean) => {
    const server = createOperationMcpServer(
      registry,
      () => ({ role: 'neo' }),
      undefined,
      'neo',
      speaking
    );
    return Object.keys(
      (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    );
  };
  expect(names(false)).not.toContain('neo_publish');
  expect(names(false)).not.toContain('neo_speech');
  expect(names(false)).toContain('neo_work');
  expect(names(false)).toContain('invoke');
  expect(names(true)).toContain('neo_publish');
  expect(names(true)).toContain('neo_speech');
});
