import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import {
  createDiscoveryOperations,
  findDescribedOperation,
} from '../../../../src/lib/operations/discovery';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry';

const caller = { source: 'internal' as const };
function policyFixture() {
  let registry: OperationRegistry;
  const entries = [
    defineOperation({
      name: 'family.read',
      description: 'Readable by every agent',
      inputSchema: z.object({}).default({}),
      resultSchema: z.object({}),
      policy: { safetyClass: 'read' },
      execute: async () => ({}),
    }),
    defineOperation({
      name: 'family.mutate',
      description: 'Mutating, worker only',
      inputSchema: z.object({}).default({}),
      resultSchema: z.object({}),
      policy: { safetyClass: 'mutate', roles: ['workflow_worker'] },
      execute: async () => ({}),
    }),
    defineOperation({
      name: 'family.human',
      description: 'Humans only',
      inputSchema: z.object({}).default({}),
      resultSchema: z.object({}),
      policy: { safetyClass: 'human_only' },
      execute: async () => ({}),
    }),
    defineOperation({
      name: 'family.unpoliced',
      description: 'No policy declared',
      inputSchema: z.object({}).default({}),
      resultSchema: z.object({}),
      execute: async () => ({}),
    }),
  ];
  registry = createOperationRegistry([...entries, ...createDiscoveryOperations(() => registry)]);
  return registry;
}

async function listedNames(registry: OperationRegistry, listCaller: OperationCaller) {
  const outcome = await invokeOperation(registry, 'operations.list', {}, listCaller);
  if (outcome.kind !== 'completed') throw new Error(`operations.list failed: ${outcome.message}`);
  return (outcome.value as { name: string }[]).map((summary) => summary.name);
}

function fixture() {
  let registry: OperationRegistry;
  const execute = mock(async (input: string) => ({ value: input }));
  const discovery = createDiscoveryOperations(() => registry);
  registry = createOperationRegistry([
    defineOperation({
      name: 'example',
      description: 'An example',
      inputSchema: z.string().min(1),
      resultSchema: z.object({ value: z.string() }),
      execute,
    }),
    ...discovery,
  ]);
  return { registry, execute };
}

describe('shared operation discovery', () => {
  test('lists the same catalog including discovery operations without executing business actions', async () => {
    const { registry, execute } = fixture();
    expect(await invokeOperation(registry, 'operations.list', {}, caller)).toEqual({
      kind: 'completed',
      value: [
        { name: 'example', description: 'An example' },
        { name: 'operations.list', description: 'List operations available in this catalog.' },
        {
          name: 'operations.describe',
          description: 'Describe an operation and its input and result schemas.',
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
  });
  test('describes input and result structure from the registered schemas', async () => {
    const { registry, execute } = fixture();
    expect(
      await invokeOperation(registry, 'operations.describe', { name: 'example' }, caller)
    ).toMatchObject({
      kind: 'completed',
      value: {
        found: true,
        name: 'example',
        description: 'An example',
        inputSchema: { type: 'string', minLength: 1 },
        resultSchema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });
  test('returns an explicit missing result without throwing', async () => {
    const { registry } = fixture();
    expect(findDescribedOperation(registry, 'missing', caller)).toEqual({
      reason: { found: false, name: 'missing' },
    });
    expect(
      await invokeOperation(registry, 'operations.describe', { name: 'missing' }, caller)
    ).toEqual({ kind: 'completed', value: { found: false, name: 'missing' } });
  });
  test('can describe its own operation without recursive expansion', async () => {
    const { registry } = fixture();
    expect(
      await invokeOperation(
        registry,
        'operations.describe',
        { name: 'operations.describe' },
        caller
      )
    ).toMatchObject({ kind: 'completed', value: { found: true, inputSchema: { type: 'object' } } });
  });
  test('schema conversion failure is normalized by invocation', async () => {
    let registry: OperationRegistry;
    registry = createOperationRegistry([
      defineOperation({
        name: 'unrepresentable',
        description: 'Transformed output',
        inputSchema: z.string(),
        resultSchema: z.string().transform((text) => text.length),
        execute: async () => 1,
      }),
      ...createDiscoveryOperations(() => registry),
    ]);
    expect(
      await invokeOperation(registry, 'operations.describe', { name: 'unrepresentable' }, caller)
    ).toMatchObject({ kind: 'failed', code: 'execution_failed' });
  });
  test('accepts no-input discovery requests through RPC and MCP', async () => {
    const { registry, execute } = fixture();
    const rpc = createOperationRpcHandler(registry, () => ({}));
    const mcp = createOperationMcpHandler(registry, () => ({}));
    const expected = registry.entries.map(({ name, description }) => ({ name, description }));
    expect(
      await rpc(
        { name: 'operations.list' },
        {
          messageId: 'request-1',
          sessionId: 'global',
          method: 'operation.invoke',
          timestamp: 'now',
        }
      )
    ).toEqual(expected);
    const result = await mcp({ name: 'operations.list' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(expected);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('discovery admission filtering', () => {
  test('rpc callers see every policed operation', async () => {
    expect(await listedNames(policyFixture(), { source: 'rpc' })).toEqual([
      'family.read',
      'family.mutate',
      'family.human',
      'family.unpoliced',
      'operations.list',
      'operations.describe',
    ]);
  });

  test('a workflow_worker sees its roles entry but never the human_only one', async () => {
    const names = await listedNames(policyFixture(), {
      source: 'mcp',
      sessionId: 'worker',
      role: 'workflow_worker',
    });
    expect(names).toEqual([
      'family.read',
      'family.mutate',
      'family.unpoliced',
      'operations.list',
      'operations.describe',
    ]);
  });

  test('a role outside the roles list loses that operation from the catalog', async () => {
    const names = await listedNames(policyFixture(), {
      source: 'mcp',
      sessionId: 'member',
      role: 'ad_hoc_member',
    });
    expect(names).not.toContain('family.mutate');
    expect(names).toContain('family.read');
    expect(names).toContain('family.unpoliced');
  });

  test('universal_read sees only read-class and unpoliced operations', async () => {
    expect(
      await listedNames(policyFixture(), {
        source: 'mcp',
        sessionId: 'reader',
        role: 'universal_read',
      })
    ).toEqual(['family.read', 'family.unpoliced', 'operations.list', 'operations.describe']);
  });

  test('an operation that exists but is not admitted describes as not found', async () => {
    const registry = policyFixture();
    const worker: OperationCaller = { source: 'mcp', sessionId: 'worker', role: 'workflow_worker' };
    expect(registry.get('family.human')).toBeDefined();
    expect(
      await invokeOperation(registry, 'operations.describe', { name: 'family.human' }, worker)
    ).toEqual({ kind: 'completed', value: { found: false, name: 'family.human' } });
    expect(
      await invokeOperation(registry, 'operations.describe', { name: 'family.mutate' }, worker)
    ).toMatchObject({ kind: 'completed', value: { found: true, name: 'family.mutate' } });
    expect(
      await invokeOperation(
        registry,
        'operations.describe',
        { name: 'family.human' },
        {
          source: 'rpc',
        }
      )
    ).toMatchObject({ kind: 'completed', value: { found: true, name: 'family.human' } });
  });

  test('findDescribedOperation hides an unadmitted operation from the caller', () => {
    const registry = policyFixture();
    expect(
      findDescribedOperation(registry, 'family.mutate', {
        source: 'mcp',
        role: 'ad_hoc_member',
      })
    ).toEqual({ reason: { found: false, name: 'family.mutate' } });
    expect(
      findDescribedOperation(registry, 'family.mutate', {
        source: 'mcp',
        role: 'workflow_worker',
      })
    ).toEqual({ value: registry.get('family.mutate')! });
  });
});
