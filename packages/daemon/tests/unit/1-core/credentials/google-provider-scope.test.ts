import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createTestDb } from '../../../helpers/database.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';
import { createGoogleConnectionOperations } from '../../../../src/lib/connections/operations.ts';
import { createGoogleConnectionRefreshLoop } from '../../../../src/lib/connections/refresh-loop.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { startGoogleLogin } from '../../../../src/lib/connections/google-login.ts';
import { artifactIdentityWrites } from '../../../../src/storage/repositories/artifact-file-identity-write.ts';
import {
  googleConnectionReads,
  googleConnectionWrites,
} from '../../../../src/storage/repositories/google-connections-worker.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let store: DatabaseCredentialStore;
let vault: ConnectionVault;
let requests: string[];
const fetchImpl = (async (url) => {
  requests.push(String(url));
  return Response.json({});
}) as typeof fetch;
const startLogin = vi.fn<typeof startGoogleLogin>(async () => {
  throw new Error('No consent is expected');
});
let registry: ReturnType<typeof createOperationRegistry>;
const microsoft = {
  id: 'microsoft-one',
  provider: 'microsoft' as const,
  accountId: 'synthetic-tenant.synthetic-object',
  email: 'one@example.test',
  health: 'healthy' as const,
  scopes: ['Mail.ReadWrite', 'https://www.googleapis.com/auth/gmail.readonly'],
};
const bundle = {
  accessToken: 'synthetic-microsoft-access',
  refreshToken: 'synthetic-microsoft-refresh',
  expiresAt: Date.now() - 1000,
  scopes: microsoft.scopes,
  client: { clientId: 'synthetic-microsoft-client' },
};

beforeEach(async () => {
  db = await createTestDb();
  store = new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key');
  const identity = await db.gateway.call(artifactIdentityWrites, 'ensure', 'synthetic-identity');
  vault = new ConnectionVault(store, identity);
  await db.gateway.call(googleConnectionWrites, 'put', microsoft);
  await vault.replace(microsoft, bundle);
  requests = [];
  startLogin.mockClear();
  registry = createOperationRegistry(
    createGoogleConnectionOperations(() => db.getDatabase(), {
      createStore: () => store,
      fetchImpl,
      startLogin,
    })
  );
});
afterEach(() => db.close());

async function expectUntouched() {
  expect(requests).toEqual([]);
  expect(startLogin).not.toHaveBeenCalled();
  expect(await db.gateway.call(googleConnectionReads, 'list')).toEqual([microsoft]);
  expect(await vault.read(microsoft)).toEqual(bundle);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
async function local(name: string, input: unknown) {
  const outcome = await invokeOperation(registry, name, input, {
    source: 'rpc',
    principal: 'local',
  });
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome.value;
}
async function agent(name: string, input: unknown) {
  const handler = createOperationMcpHandler(registry, () => ({
    sessionId: 'synthetic-owned-session',
    role: 'neo',
  }));
  const reply = await handler({ name, input });
  return JSON.parse(reply.content[0].text);
}

test('Google account listing does not show a Microsoft connection', async () => {
  expect(await agent('google.accounts', {})).toEqual({ connections: [] });
});

test('Gmail search with a Microsoft connection ID is refused without any request', async () => {
  expect(
    await agent('gmail.search', { connectionId: microsoft.id, query: 'subject:fixture' })
  ).toEqual({ ok: false, reason: 'unknown_connection' });
  await expectUntouched();
});

test('Google reconnect with a Microsoft connection ID is refused before consent', async () => {
  expect(await local('connections.google.connect', { connectionId: microsoft.id })).toEqual({
    state: 'failed',
    reason: 'unknown_connection',
  });
  await expectUntouched();
});

test('Google disconnect with a Microsoft connection ID keeps its row and bundle', async () => {
  expect(await local('connections.google.disconnect', { connectionId: microsoft.id })).toEqual({
    ok: false,
    reason: 'unknown_connection',
  });
  await expectUntouched();
});

test('Google disconnect with a Microsoft connection ID leaves a waiting read of it alone', async () => {
  const consent =
    Promise.withResolvers<Awaited<Awaited<ReturnType<typeof startGoogleLogin>>['result']>>();
  const busy = Promise.withResolvers<void>();
  startLogin.mockImplementationOnce(async () => {
    await busy.promise;
    return {
      authorizeUrl: 'https://accounts.google.com/synthetic',
      result: consent.promise,
      cancel: () => {},
    };
  });
  const connecting = local('connections.google.connect', { clientId: 'synthetic-google-client' });
  await settle();
  expect(startLogin).toHaveBeenCalledTimes(1);
  const search = agent('gmail.search', { connectionId: microsoft.id, query: 'subject:fixture' });
  await settle();
  const disconnecting = local('connections.google.disconnect', { connectionId: microsoft.id });
  await settle();
  busy.resolve();
  await connecting;
  expect(await disconnecting).toEqual({ ok: false, reason: 'unknown_connection' });
  expect(await search).toEqual({ ok: false, reason: 'unknown_connection' });
  expect(requests).toEqual([]);
  expect(await db.gateway.call(googleConnectionReads, 'list')).toEqual([microsoft]);
  expect(await vault.read(microsoft)).toEqual(bundle);
});

test('the Google refresh loop never refreshes a Microsoft connection', async () => {
  let tick!: () => Promise<void>;
  const loop = createGoogleConnectionRefreshLoop(db.getDatabase(), {
    schedule: (run) => {
      tick = run;
      return () => {};
    },
  });
  loop.start();
  await tick();
  await loop.stop();
  await expectUntouched();
});
