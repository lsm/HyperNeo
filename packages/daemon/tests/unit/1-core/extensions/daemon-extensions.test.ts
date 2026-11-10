import { describe, expect, it } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import type { OperationDefinition } from '../../../../src/lib/operations/registry.ts';
import {
  createDaemonExtensionsOperation,
  DaemonExtensions,
} from '../../../../src/lib/extensions/contract.ts';

const db = { name: 'db' } as unknown as Database;
const hub = { name: 'hub' } as unknown as MessageHub;

describe('DaemonExtensions', () => {
  it('runs each slot of a registered extension in registration order', async () => {
    const calls: string[] = [];
    const extensions = new DaemonExtensions(db, hub);
    const operation = { name: 'a.read' } as unknown as OperationDefinition;
    const adapter = { id: 'b-adapter' } as unknown as WorkAdapter;
    extensions.register({
      id: 'a',
      schema: (database) => calls.push(`schema a ${database === db}`),
      rpc: (messageHub) => calls.push(`rpc a ${messageHub === hub}`),
      operations: () => [operation],
      start: () => void calls.push('start a'),
      stop: () => void calls.push('stop a'),
    });
    extensions.register({
      id: 'b',
      adapters: () => [adapter],
      webRoutes: [{ path: '/b', label: 'B' }],
      start: () => void calls.push('start b'),
      stop: () => void calls.push('stop b'),
    });
    await extensions.start();
    await extensions.stop();
    expect(calls).toEqual([
      'schema a true',
      'rpc a true',
      'start a',
      'start b',
      'stop b',
      'stop a',
    ]);
    expect(extensions.operations()).toEqual([operation]);
    expect(extensions.adapters({ searchChats: async () => [] })).toEqual([adapter]);
    expect(extensions.manifest()).toEqual({
      extensions: [
        { id: 'a', webRoutes: [] },
        { id: 'b', webRoutes: [{ path: '/b', label: 'B' }] },
      ],
    });
  });
});

describe('DaemonExtensions.stop', () => {
  it('stops every extension and reports the ones that failed', async () => {
    const stopped: string[] = [];
    const failure = new Error('stop failed');
    const extensions = new DaemonExtensions(db, hub);
    extensions.register({ id: 'a', stop: () => void stopped.push('a') });
    extensions.register({
      id: 'b',
      stop: () => {
        throw failure;
      },
    });
    extensions.register({ id: 'c', stop: () => void stopped.push('c') });
    expect(await extensions.stop()).toEqual([{ id: 'b', error: failure }]);
    expect(stopped).toEqual(['c', 'a']);
  });
});

describe('DaemonExtensions.stop timing', () => {
  it('runs the last extension stop hook up to its first await before stop returns', async () => {
    let flagged = false;
    const extensions = new DaemonExtensions(db, hub);
    extensions.register({ id: 'core' });
    extensions.register({
      id: 'space',
      stop: async () => {
        flagged = true;
        await Promise.resolve();
      },
    });
    const stopping = extensions.stop();
    expect(flagged).toBe(true);
    expect(await stopping).toEqual([]);
  });
});

describe('DaemonExtensions.adapters', () => {
  it('builds each extension adapter once with the host search and reuses it', () => {
    const searchChats = async () => [];
    const hosts: unknown[] = [];
    const extensions = new DaemonExtensions(db, hub);
    extensions.register({
      id: 'space',
      adapters: (host) => {
        hosts.push(host.searchChats);
        return [{ id: 'space' } as unknown as WorkAdapter];
      },
    });
    const first = extensions.adapters({ searchChats });
    const second = extensions.adapters({ searchChats });
    expect(first.map((adapter) => adapter.id)).toEqual(['space']);
    expect(second[0]).toBe(first[0]);
    expect(hosts).toEqual([searchChats]);
  });
});

describe('createDaemonExtensionsOperation', () => {
  it('lists only the extensions loaded in this daemon', async () => {
    const extensions = new DaemonExtensions(db, hub);
    extensions.register({ id: 'space' });
    const operation = createDaemonExtensionsOperation(extensions);
    expect(operation.name).toBe('daemon.extensions');
    expect(await operation.execute({}, { source: 'rpc' } as never)).toEqual({
      extensions: [{ id: 'space', webRoutes: [] }],
    });
    expect(operation.inputSchema.parse(undefined)).toEqual({});
  });
});
