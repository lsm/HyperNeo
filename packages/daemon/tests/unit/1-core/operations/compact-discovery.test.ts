import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createDiscoveryOperations,
  listOperationSummaries,
} from '../../../../src/lib/operations/discovery';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
  type OperationPolicy,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry';

const neo: OperationCaller = { source: 'mcp', role: 'neo', sessionId: 'neo-session' };
function entry(
  name: string,
  policy: OperationPolicy = { safetyClass: 'read' },
  pack?: OperationDefinition['pack']
) {
  return defineOperation({
    name,
    description: `Description of ${name}`,
    inputSchema: z.object({}),
    resultSchema: z.object({}),
    policy,
    pack,
    execute: async () => ({}),
  });
}
function registryFor(entries: OperationDefinition[]) {
  const registry: OperationRegistry = createOperationRegistry([
    ...entries,
    ...createDiscoveryOperations(() => registry),
  ]);
  return registry;
}
async function list(
  registry: OperationRegistry,
  input: Record<string, unknown> = {},
  caller = neo
) {
  const result = await invokeOperation(registry, 'operations.list', input, caller);
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value;
}
function fixture() {
  let enabled: string[] = [];
  const registry = registryFor([
    entry('goal.journal.list'),
    entry('goal.journal.append'),
    entry('neo.snapshot'),
    entry(
      'neo.coding.pr.file',
      { safetyClass: 'read' },
      { id: 'coding', enabledIds: () => enabled }
    ),
    entry('neo.rule.ask', { safetyClass: 'human_only' }),
    entry('work.send'),
    entry('task.list'),
    entry('neo.future.unreviewed'),
    entry('workflow.run.peer.list', { safetyClass: 'read', roles: ['workflow_worker'] }),
  ]);
  return {
    registry,
    enable: () => {
      enabled = ['coding'];
    },
    disable: () => {
      enabled = [];
    },
  };
}

describe('Neo compact prefix discovery', () => {
  test('bare discovery returns admitted rare namespace counts without descriptions', async () => {
    const { registry } = fixture();
    expect(await list(registry)).toEqual({
      prefixes: [
        { prefix: 'goal', count: 2 },
        { prefix: 'neo', count: 1 },
      ],
    });
  });
  test('all and keyword query cannot restore a full catalog for Neo', async () => {
    const { registry } = fixture();
    const result = await list(registry, { all: true });
    expect(result).toEqual(await list(registry));
    expect(await list(registry, { all: true, query: 'journal' })).toEqual({
      prefixes: [{ prefix: 'goal', count: 2 }],
    });
    expect(JSON.stringify(result)).not.toContain('Description');
  });
  test('a prefix follows segment boundaries and excludes resident and denied names', async () => {
    const { registry } = fixture();
    expect(await list(registry, { prefix: 'goal.journal' })).toEqual({
      total: 2,
      names: ['goal.journal.append', 'goal.journal.list'],
      next: null,
    });
    expect(await list(registry, { prefix: 'goal.j' })).toEqual({ total: 0, names: [], next: null });
    expect(await list(registry, { prefix: 'work', all: true })).toEqual({
      total: 0,
      names: [],
      next: null,
    });
    expect(await list(registry, { prefix: 'task' })).toEqual({ total: 0, names: [], next: null });
    expect(await list(registry, { prefix: 'neo.future' })).toEqual({
      total: 0,
      names: [],
      next: null,
    });
  });
  test('a cursor without a prefix returns the index and documents that fallback', async () => {
    const { registry } = fixture();
    expect(await list(registry, { cursor: 'goal.journal.append' })).toEqual(await list(registry));
    const description = await invokeOperation(
      registry,
      'operations.describe',
      { name: 'operations.list' },
      neo
    );
    expect(description).toMatchObject({
      kind: 'completed',
      value: {
        inputSchema: {
          properties: {
            cursor: {
              description: expect.stringContaining(
                'Without prefix, Neo returns namespace counts and ignores cursor.'
              ),
            },
          },
        },
      },
    });
  });
  test('the same session discovers a pack only while it is enabled', async () => {
    const { registry, enable, disable } = fixture();
    expect(await list(registry, { prefix: 'neo.coding.pr' })).toEqual({
      total: 0,
      names: [],
      next: null,
    });
    enable();
    expect(await list(registry, { prefix: 'neo.coding.pr' })).toEqual({
      total: 1,
      names: ['neo.coding.pr.file'],
      next: null,
    });
    disable();
    expect(await list(registry, { prefix: 'neo.coding.pr' })).toEqual({
      total: 0,
      names: [],
      next: null,
    });
  });
  test('prefix pages contain at most twenty stable names and a continuation cursor', async () => {
    const names = [
      'neo.ask.doneTodos',
      'neo.ask.history',
      'neo.coding.assign',
      'neo.coding.merge.human',
      'neo.coding.merge.prepare',
      'neo.coding.merge.retry',
      'neo.coding.pr.file',
      'neo.coding.result',
      'neo.coding.smoke',
      'neo.conversation.asks.read',
      'neo.conversation.image.read',
      'neo.conversation.read',
      'neo.home.github',
      'neo.home.init',
      'neo.home.read',
      'neo.home.save',
      'neo.pack.read',
      'neo.peer.accept',
      'neo.peer.invite',
      'neo.peer.list',
      'neo.peer.remove',
    ];
    const registry = registryFor(names.map((name) => entry(name)).reverse());
    const first = (await list(registry, { prefix: 'neo' })) as {
      names: string[];
      next: string;
      total: number;
    };
    expect(first).toEqual({ total: 21, names: names.slice(0, 20), next: 'neo.peer.list' });
    expect(await list(registry, { prefix: 'neo', cursor: first.next })).toEqual({
      total: 21,
      names: names.slice(20),
      next: null,
    });
    expect(await list(registry, { prefix: 'neo', cursor: names.at(-1) })).toEqual({
      total: 21,
      names: [],
      next: null,
    });
  });
  test('resident operations still have exact schemas', async () => {
    const { registry } = fixture();
    expect(
      await invokeOperation(registry, 'operations.describe', { name: 'work.send' }, neo)
    ).toMatchObject({
      kind: 'completed',
      value: { found: true, name: 'work.send', inputSchema: { type: 'object' } },
    });
  });
  test('approved profile exclusions retain raw APIs for non-Neo callers', async () => {
    const names = [
      'settings.model.get',
      'settings.model.set',
      'session.runtimeSettings.read',
      'session.runtimeSettings.update',
      'session.list',
      'session.get',
      'session.message.list',
    ];
    const registry = registryFor(
      names.map((name) => entry(name, { safetyClass: 'read', roles: ['neo'] }))
    );
    expect(await list(registry)).toEqual({ prefixes: [] });
    for (const prefix of ['session', 'settings']) {
      expect(await list(registry, { prefix, all: true })).toEqual({
        total: 0,
        names: [],
        next: null,
      });
    }
    const human = (await list(registry, { all: true }, { source: 'rpc' })) as { name: string }[];
    expect(human.map(({ name }) => name)).toEqual(expect.arrayContaining(names));
  });
  test('the list description explains compact discovery to Neo and preserves other callers', async () => {
    const { registry } = fixture();
    const description = await invokeOperation(
      registry,
      'operations.describe',
      { name: 'operations.list' },
      neo
    );
    expect(description.kind).toBe('completed');
    if (description.kind !== 'completed') throw new Error(description.message);
    const text = (description.value as { description: string }).description;
    expect(text).toContain('all: true stays compact');
    expect(text).toContain('at most 20 names');
    for (const caller of [
      { source: 'rpc' },
      { source: 'internal' },
      { source: 'mcp', role: 'workflow_worker' },
      { source: 'mcp', role: 'long_term_agent' },
    ] as OperationCaller[]) {
      expect(
        await invokeOperation(registry, 'operations.describe', { name: 'operations.list' }, caller)
      ).toMatchObject({
        kind: 'completed',
        value: { description: registry.get('operations.list')!.description },
      });
    }
  });
  test('the published paging fields explain Neo-only behavior', async () => {
    const { registry } = fixture();
    const result = await invokeOperation(
      registry,
      'operations.describe',
      { name: 'operations.list' },
      { source: 'rpc' }
    );
    expect(result).toMatchObject({
      kind: 'completed',
      value: {
        inputSchema: {
          properties: {
            prefix: { description: expect.stringContaining('Neo MCP only') },
            cursor: { description: expect.stringContaining('Neo MCP only') },
          },
        },
      },
    });
  });

  test('existing non-Neo list replies remain byte-identical', async () => {
    const { registry } = fixture();
    for (const caller of [
      { source: 'rpc' },
      { source: 'internal' },
      { source: 'mcp', role: 'workflow_worker' },
      { source: 'mcp', role: 'long_term_agent' },
    ] as OperationCaller[]) {
      for (const input of [{}, { all: true }, { query: 'journal' }]) {
        expect(JSON.stringify(await list(registry, input, caller))).toBe(
          JSON.stringify(
            listOperationSummaries(
              registry,
              caller,
              'all' in input ? input.all : false,
              'query' in input ? input.query : undefined
            )
          )
        );
      }
    }
  });
});
