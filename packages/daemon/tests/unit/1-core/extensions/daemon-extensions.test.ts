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
    expect(extensions.adapters()).toEqual([adapter]);
    expect(extensions.manifest()).toEqual({
      extensions: [
        { id: 'a', webRoutes: [] },
        { id: 'b', webRoutes: [{ path: '/b', label: 'B' }] },
      ],
    });
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
