import type { Space } from '@hyperneo/shared';
import { describe, expect, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { createSpaceReadOperations } from '../../../../src/lib/space/space-read-operations.ts';
import type { FamilyOperationContext } from '../../../../src/lib/rpc-handlers/family-operations/context.ts';
import { registerSpaceOperations } from '../../../../src/lib/rpc-handlers/family-operations/spaces.ts';

function makeSpace(overrides: Partial<Space> & Pick<Space, 'id'>): Space {
  return {
    slug: `${overrides.id}-slug`,
    workspacePath: `/repos/${overrides.id}`,
    name: `Space ${overrides.id}`,
    description: 'secret description',
    backgroundContext: 'secret background',
    instructions: 'secret instructions',
    sessionIds: ['session-a', 'session-b'],
    status: 'active',
    paused: false,
    stopped: false,
    maxConcurrentTasks: 3,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

const ALPHA = makeSpace({ id: 'space-alpha' });
const BETA = makeSpace({ id: 'space-beta', paused: true, stopped: true });
const ARCHIVED = makeSpace({ id: 'space-old', status: 'archived' });

function makeRegistry(spaces: Space[] = [ALPHA, BETA]) {
  const calls: boolean[] = [];
  const registry = createOperationRegistry(
    createSpaceReadOperations({
      listSpaces: (includeArchived) => {
        calls.push(includeArchived);
        return includeArchived ? [...spaces, ARCHIVED] : spaces;
      },
      getSpace: (spaceId) => spaces.find((space) => space.id === spaceId) ?? null,
    })
  );
  return { registry, calls };
}

const UNSCOPED_MCP: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-without-space',
  role: 'universal_read',
};
const SCOPED_MCP: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-in-alpha',
  spaceId: ALPHA.id,
  role: 'ad_hoc_member',
};
const RPC: OperationCaller = { source: 'rpc', principal: 'local' };

async function list(caller: OperationCaller, input: unknown = {}) {
  const { registry, calls } = makeRegistry();
  const outcome = await invokeOperation(registry, 'space.list', input, caller);
  return { outcome, calls };
}

describe('space discovery operations', () => {
  test('space.list and space.get refuse an MCP caller outside any Space', async () => {
    const { outcome } = await list(UNSCOPED_MCP);
    expect(outcome).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'outside_space' },
    });
    const { registry } = makeRegistry();
    expect(
      await invokeOperation(registry, 'space.get', { spaceId: ALPHA.id }, UNSCOPED_MCP)
    ).toEqual({ kind: 'completed', value: { accepted: false, reason: 'outside_space' } });
  });

  test('space.list answers a Space-scoped MCP caller', async () => {
    const { outcome } = await list(SCOPED_MCP);
    expect(outcome).toEqual({
      kind: 'completed',
      value: {
        spaces: [
          {
            id: 'space-alpha',
            slug: 'space-alpha-slug',
            name: 'Space space-alpha',
            status: 'active',
            paused: false,
            stopped: false,
          },
          {
            id: 'space-beta',
            slug: 'space-beta-slug',
            name: 'Space space-beta',
            status: 'active',
            paused: true,
            stopped: true,
          },
        ],
      },
    });
  });

  test('space.list answers an RPC caller the same way', async () => {
    const fromRpc = await list(RPC);
    const fromMcp = await list(SCOPED_MCP);
    expect(fromRpc.outcome).toEqual(fromMcp.outcome);
    expect(fromRpc.outcome.kind).toBe('completed');
  });

  test('space.list shows a Space-scoped agent the Spaces it does not belong to', async () => {
    const { outcome } = await list(SCOPED_MCP);
    expect(outcome.kind).toBe('completed');
    const value = (outcome as { value: { spaces: Array<{ id: string }> } }).value;
    expect(value.spaces.map((space) => space.id)).toEqual(['space-alpha', 'space-beta']);
  });

  test('space.list excludes archived Spaces unless includeArchived is set', async () => {
    const byDefault = await list(SCOPED_MCP);
    expect(byDefault.calls).toEqual([false]);
    expect(
      (byDefault.outcome as { value: { spaces: Array<{ id: string }> } }).value.spaces.map(
        (space) => space.id
      )
    ).toEqual(['space-alpha', 'space-beta']);

    const withArchived = await list(SCOPED_MCP, { includeArchived: true });
    expect(withArchived.calls).toEqual([true]);
    expect(
      (withArchived.outcome as { value: { spaces: Array<{ id: string }> } }).value.spaces.map(
        (space) => space.id
      )
    ).toEqual(['space-alpha', 'space-beta', 'space-old']);
  });

  test('space.list returns only the bootstrap fields, never the Space payload', async () => {
    const { outcome } = await list(SCOPED_MCP);
    const [first] = (outcome as { value: { spaces: Record<string, unknown>[] } }).value.spaces;
    expect(Object.keys(first).sort()).toEqual([
      'id',
      'name',
      'paused',
      'slug',
      'status',
      'stopped',
    ]);
    expect(JSON.stringify(outcome)).not.toContain('secret');
  });

  test('space.get returns the same summary for a known id', async () => {
    const { registry } = makeRegistry();
    const outcome = await invokeOperation(registry, 'space.get', { spaceId: BETA.id }, SCOPED_MCP);
    expect(outcome).toEqual({
      kind: 'completed',
      value: {
        found: true,
        space: {
          id: 'space-beta',
          slug: 'space-beta-slug',
          name: 'Space space-beta',
          status: 'active',
          paused: true,
          stopped: true,
        },
      },
    });
  });

  test('space.get reports an unknown id instead of throwing', async () => {
    const { registry } = makeRegistry();
    const outcome = await invokeOperation(registry, 'space.get', { spaceId: 'nope' }, SCOPED_MCP);
    expect(outcome).toEqual({ kind: 'completed', value: { found: false, spaceId: 'nope' } });
  });
});

describe('registerSpaceOperations', () => {
  test('binds space.list and space.get to the daemon SpaceManager', async () => {
    const seen: boolean[] = [];
    const context = {
      deps: {
        spaceManager: {
          listSpaces: async (includeArchived: boolean) => {
            seen.push(includeArchived);
            return [ALPHA];
          },
          getSpace: async (spaceId: string) => (spaceId === ALPHA.id ? ALPHA : null),
        },
      },
    } as unknown as FamilyOperationContext;

    const registry = createOperationRegistry(registerSpaceOperations(context));
    expect(registry.entries.map((entry) => entry.name)).toEqual(['space.list', 'space.get']);

    const outcome = await invokeOperation(registry, 'space.list', {}, SCOPED_MCP);
    expect(seen).toEqual([false]);
    expect(outcome).toEqual({
      kind: 'completed',
      value: {
        spaces: [
          {
            id: 'space-alpha',
            slug: 'space-alpha-slug',
            name: 'Space space-alpha',
            status: 'active',
            paused: false,
            stopped: false,
          },
        ],
      },
    });
  });
});
