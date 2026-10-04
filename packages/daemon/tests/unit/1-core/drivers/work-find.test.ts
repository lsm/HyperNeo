import { describe, expect, test } from 'bun:test';
import { mergePlaceGroups } from '../../../../src/lib/drivers/places';
import { createFindWorkOperation } from '../../../../src/lib/drivers/find-operation';
import type { PlaceGroup, WorkAdapter } from '../../../../src/lib/drivers/types';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

function group(machine: string, folder: string, adapter: string, at: number): PlaceGroup {
  return {
    place: { machine, folder, name: folder.split('/').pop() ?? folder },
    lastActivityAt: at,
    openCount: 1,
    archivedCount: 0,
    adapters: [adapter],
    work: [
      {
        ref: { adapter, id: `${adapter}-${at}` },
        title: `${adapter} work`,
        place: { machine, folder, name: folder.split('/').pop() ?? folder },
        status: 'running',
        lastActivityAt: at,
      },
    ],
  };
}

describe('mergePlaceGroups', () => {
  test('merges one folder on one machine across adapters, newest first', () => {
    const merged = mergePlaceGroups(
      [
        group('laptop', '/focus/dolmen', 'codex-desktop', 10),
        group('laptop', '/focus/dolmen', 'claude-desktop', 30),
        group('imac', '/focus/dolmen', 'hyperneo', 20),
      ],
      10
    );
    expect(merged.map((g) => [g.place.machine, g.adapters, g.openCount])).toEqual([
      ['laptop', ['claude-desktop', 'codex-desktop'], 2],
      ['imac', ['hyperneo'], 1],
    ]);
    expect(merged[0].work.map((w) => w.lastActivityAt)).toEqual([30, 10]);
  });
});

describe('work.find operation', () => {
  const local: WorkAdapter = {
    id: 'hyperneo',
    capabilities: ['find'],
    find: () => [group('imac', '/focus/dolmen', 'hyperneo', 20)],
  };
  const broken: WorkAdapter = {
    id: 'broken',
    capabilities: ['find'],
    find: () => {
      throw new Error('store unavailable');
    },
  };

  function registry(invoke: (daemonId: string, name: string, input: unknown) => Promise<unknown>) {
    return createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [local, broken],
        remote: { list: () => [{ daemonId: 'laptop' }, { daemonId: 'gone' }], invoke },
      }),
    ]);
  }

  test('merges local and attached daemons, stamps remote refs and reports what could not answer', async () => {
    const calls: unknown[] = [];
    const outcome = await invokeOperation(
      registry(async (daemonId, name, input) => {
        calls.push({ daemonId, name, input });
        if (daemonId === 'gone') throw new Error('unreachable');
        return { places: [group('laptop', '/focus/dolmen', 'codex-desktop', 30)], unreachable: [] };
      }),
      'work.find',
      {},
      { source: 'mcp', sessionId: 'neo:root' }
    );
    expect(outcome.kind).toBe('completed');
    const value =
      outcome.kind === 'completed'
        ? (outcome.value as { places: PlaceGroup[]; unreachable: unknown[] })
        : null;
    expect(value?.places.map((g) => [g.place.machine, g.work[0].ref])).toEqual([
      ['laptop', { adapter: 'codex-desktop', id: 'codex-desktop-30', daemon: 'laptop' }],
      ['imac', { adapter: 'hyperneo', id: 'hyperneo-20' }],
    ]);
    expect(value?.unreachable).toEqual([
      { source: 'broken', reason: 'store unavailable' },
      { source: 'gone', reason: 'unreachable' },
    ]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        daemonId: 'laptop',
        name: 'work.find',
        input: expect.objectContaining({ localOnly: true }),
      })
    );
  });

  test('does not ask other daemons when called with localOnly', async () => {
    let asked = false;
    await invokeOperation(
      registry(async () => {
        asked = true;
        return { places: [], unreachable: [] };
      }),
      'work.find',
      { localOnly: true },
      { source: 'rpc' }
    );
    expect(asked).toBe(false);
  });
});
