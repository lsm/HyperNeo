import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createClientOperations,
  requireClientData,
} from '../../../../src/lib/clients/client-operations.ts';
import { requireLocalUser } from '../../../../src/lib/operations/caller.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { ClientRegistrationRepository } from '../../../../src/storage/repositories/client-registration-repository.ts';
import { runMigration315 } from '../../../../src/storage/schema/m315-client-registrations.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const user: OperationCaller = { source: 'rpc', principal: 'local' };
const phone = {
  clientId: 'iphone-1',
  kind: 'neo-ios-push',
  data: { apnsToken: 'ab12', environment: 'sandbox', activities: [] },
};

describe('requireLocalUser', () => {
  test.each<[string, OperationCaller, boolean]>([
    ['the local user over RPC', user, true],
    ['Neo over MCP', { source: 'mcp', sessionId: 'neo:root', role: 'neo' }, false],
    ['an RPC caller without the local principal', { source: 'rpc' }, false],
    ['an internal caller', { source: 'internal', principal: 'local' }, false],
  ])('%s', (_label, caller, admitted) => {
    expect('value' in requireLocalUser(caller)).toBe(admitted);
  });
});

describe('requireClientData', () => {
  test.each<[string, Record<string, unknown>, boolean]>([
    ['small data', { token: 'ab' }, true],
    ['data at the limit', { blob: 'x'.repeat(8192 - '{"blob":""}'.length) }, true],
    ['data over the limit', { blob: 'x'.repeat(8192) }, false],
  ])('%s', (_label, data, admitted) => {
    const gate = requireClientData({ ...phone, data }, 42);
    expect('value' in gate ? gate.value.updatedAt : gate.reason.reason).toEqual(
      admitted ? 42 : expect.stringContaining('data_too_large')
    );
  });
});

describe('client registry over RPC', () => {
  let clients: ClientRegistrationRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigration315(db);
    clients = new ClientRegistrationRepository(db);
  });

  const invoke = (name: string, input: unknown, caller = user) =>
    invokeOperation(createOperationRegistry(createClientOperations(clients)), name, input, caller);

  test('registers, replaces, lists by kind and unregisters', async () => {
    expect(await invoke('client.register', phone)).toMatchObject({ value: { ok: true } });
    await invoke('client.register', { ...phone, data: { apnsToken: 'cd34' } });
    await invoke('client.register', { ...phone, kind: 'widget', data: {} });
    await invoke('client.register', { ...phone, clientId: 'ipad-1' });

    const listed = (await invoke('client.list', { kind: 'neo-ios-push' })) as {
      value: { ok: true; clients: { clientId: string; data: unknown }[] };
    };
    expect(listed.value.clients.map(({ clientId, data }) => ({ clientId, data }))).toEqual([
      { clientId: 'ipad-1', data: phone.data },
      { clientId: 'iphone-1', data: { apnsToken: 'cd34' } },
    ]);
    expect(await invoke('client.unregister', { clientId: 'iphone-1' })).toMatchObject({
      value: { ok: true, removed: 2 },
    });
    expect(await invoke('client.list', {})).toMatchObject({
      value: { clients: [expect.objectContaining({ clientId: 'ipad-1' })] },
    });
  });

  test('refuses anyone but the local user, and kinds that are not short names', async () => {
    const neo: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };
    expect(await invoke('client.list', {}, neo)).toMatchObject({
      value: { ok: false, reason: 'This action needs the user.' },
    });
    expect(await invoke('client.register', phone, neo)).toMatchObject({ value: { ok: false } });
    expect(clients.list()).toEqual([]);
    expect(await invoke('client.register', { ...phone, kind: 'x'.repeat(41) })).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
  });
});
