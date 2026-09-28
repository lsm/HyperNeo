import { describe, expect, mock, test } from 'bun:test';
import type { DaemonInventoryPage } from '@hyperneo/shared/types/daemon-snapshot';
import {
  createDaemonSnapshotOperation,
  presentDaemonSnapshot,
} from '../../../../src/lib/inventory/snapshot-operation';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';

const caller = { source: 'rpc' as const, principal: 'local' };
const entry = {
  id: 'chat-a',
  name: 'Project A',
  status: 'active',
  updatedAt: 100,
  workspacePath: '/projects/a',
  links: [{ kind: 'space', id: 'space-a' }],
};
const pages: readonly DaemonInventoryPage[] = [{ kind: 'session', total: 2, entries: [entry] }];

describe('presentDaemonSnapshot', () => {
  test('projects metadata without mutating or retaining the reader objects', () => {
    const resource = Object.freeze({
      ...entry,
      name: 'x'.repeat(200),
      instructions: 'secret prompt',
      links: Object.freeze([Object.freeze({ ...entry.links[0], config: 'secret config' })]),
    });
    const resources = Object.freeze([
      Object.freeze({ kind: 'custom-kind', total: 3, entries: Object.freeze([resource]) }),
    ]);
    const capabilities = Object.freeze(['workflow.start', 'task.create', 'task.create']);
    const result = presentDaemonSnapshot(resources, capabilities, 123);
    expect(result).toEqual({
      capturedAt: 123,
      capabilities: ['task.create', 'workflow.start'],
      resources: [
        {
          kind: 'custom-kind',
          total: 3,
          truncated: true,
          entries: [{ ...entry, name: 'x'.repeat(160) }],
        },
      ],
    });
    expect(resource.name).toHaveLength(200);
    expect(result.resources[0].entries[0]).not.toBe(resource);
    expect(result.resources[0].entries[0].links[0]).not.toBe(resource.links[0]);
  });

  test('bounds each kind independently and sorts newest first with stable ties', () => {
    const entries = [
      { ...entry, id: 'old', updatedAt: 1 },
      { ...entry, id: 'b', updatedAt: 200 },
      { ...entry, id: 'a', updatedAt: 200 },
    ];
    const result = presentDaemonSnapshot(
      [
        { kind: 'session', total: 3, entries },
        { kind: 'goal', total: 1, entries: [entry] },
      ],
      [],
      1,
      1
    );
    expect(result.resources.map((page) => [page.kind, page.truncated, page.entries[0].id])).toEqual(
      [
        ['session', true, 'a'],
        ['goal', false, 'chat-a'],
      ]
    );
    expect(entries.map(({ id }) => id)).toEqual(['old', 'b', 'a']);
  });

  test('represents empty resource kinds and missing lifecycle state honestly', () => {
    expect(presentDaemonSnapshot([{ kind: 'agent', total: 0, entries: [] }], [], 1)).toEqual({
      capturedAt: 1,
      resources: [{ kind: 'agent', total: 0, entries: [], truncated: false }],
      capabilities: [],
    });
    const result = presentDaemonSnapshot(
      [{ kind: 'evolution_scope', total: 1, entries: [{ ...entry, status: null }] }],
      [],
      1
    );
    expect(result.resources[0].entries[0].status).toBeNull();
  });
});

describe('createDaemonSnapshotOperation', () => {
  test.each([false, true])('composes sync or async ports: async=%s', async (asynchronous) => {
    const readResources = mock((input: { limit: number; includeArchived: boolean }) => {
      expect(input).toEqual({ limit: 20, includeArchived: false });
      return asynchronous ? Promise.resolve(pages) : pages;
    });
    const readCapabilities = mock(() =>
      asynchronous ? Promise.resolve(['task.create']) : ['task.create']
    );
    const now = mock(() => 500);
    const registry = createOperationRegistry([
      createDaemonSnapshotOperation({ readResources, readCapabilities, now }),
    ]);
    expect(readResources).not.toHaveBeenCalled();
    expect(readCapabilities).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(await invokeOperation(registry, 'daemon.snapshot', undefined, caller)).toEqual({
      kind: 'completed',
      value: presentDaemonSnapshot(pages, ['task.create'], 500),
    });
    expect(readResources).toHaveBeenCalledTimes(1);
    expect(readCapabilities).toHaveBeenCalledWith(caller);
    expect(now).toHaveBeenCalledTimes(1);
  });

  test('forwards validated options and the original caller to separate read ports', async () => {
    const readResources = mock(() => pages);
    const readCapabilities = mock(() => ['session.list']);
    const registry = createOperationRegistry([
      createDaemonSnapshotOperation({ readResources, readCapabilities, now: () => 1 }),
    ]);
    const principal = {
      source: 'mcp' as const,
      role: 'outside_space' as const,
      sessionId: 'source',
    };
    await invokeOperation(
      registry,
      'daemon.snapshot',
      { limit: 1, includeArchived: true },
      principal
    );
    expect(readResources).toHaveBeenCalledWith({ limit: 1, includeArchived: true });
    expect(readCapabilities).toHaveBeenCalledWith(principal);
  });

  test.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { includeArchived: 'yes' },
    { mode: 'epic' },
  ])('rejects invalid options before reading: %j', async (input) => {
    const readResources = mock(() => pages);
    const readCapabilities = mock(() => []);
    const registry = createOperationRegistry([
      createDaemonSnapshotOperation({ readResources, readCapabilities }),
    ]);
    expect(await invokeOperation(registry, 'daemon.snapshot', input, caller)).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
    expect(readResources).not.toHaveBeenCalled();
    expect(readCapabilities).not.toHaveBeenCalled();
  });

  test.each(['resources', 'capabilities'] as const)(
    'surfaces a failed %s read without retry',
    async (port) => {
      const readResources = mock(async () => {
        if (port === 'resources') throw new Error('read failed');
        return pages;
      });
      const readCapabilities = mock(async () => {
        throw new Error('read failed');
      });
      const registry = createOperationRegistry([
        createDaemonSnapshotOperation({ readResources, readCapabilities }),
      ]);
      expect(await invokeOperation(registry, 'daemon.snapshot', {}, caller)).toEqual({
        kind: 'failed',
        code: 'execution_failed',
        message: 'read failed',
      });
      expect(readResources).toHaveBeenCalledTimes(1);
      expect(readCapabilities).toHaveBeenCalledTimes(port === 'resources' ? 0 : 1);
    }
  );

  test('rejects impossible source counts instead of reporting an empty or successful snapshot', async () => {
    const registry = createOperationRegistry([
      createDaemonSnapshotOperation({
        readResources: () => [{ kind: 'session', total: 0, entries: [entry] }],
        readCapabilities: () => [],
      }),
    ]);
    expect(await invokeOperation(registry, 'daemon.snapshot', {}, caller)).toMatchObject({
      kind: 'failed',
      code: 'invalid_result',
    });
  });
});
