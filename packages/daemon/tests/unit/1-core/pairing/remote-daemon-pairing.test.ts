import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MessageHub, MessageHubRouter } from '@hyperneo/shared';
import { z } from 'zod';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter.ts';
import { createPairRoute } from '../../../../src/lib/pairing/pair-route.ts';
import {
  announceDeviceRevoked,
  createUpgradeAuthenticator,
} from '../../../../src/lib/pairing/upgrade-auth.ts';
import { createAttachDaemonOperation } from '../../../../src/lib/remote-daemons/attach-operation.ts';
import { createDetachDaemonOperation } from '../../../../src/lib/remote-daemons/manage-operations.ts';
import { RemoteDaemonRegistry } from '../../../../src/lib/remote-daemons/registry.ts';
import { setupOperationHandlers } from '../../../../src/lib/rpc-handlers/operation-handlers.ts';
import { createHttpWsServer, type ServerHandle } from '../../../../src/lib/runtime-server/index.ts';
import type { SessionManager } from '../../../../src/lib/session-manager.ts';
import { WebSocketServerTransport } from '../../../../src/lib/websocket-server-transport.ts';
import { createWebSocketHandlers } from '../../../../src/routes/setup-websocket.ts';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository.ts';
import { RemoteDaemonSecretRepository } from '../../../../src/storage/repositories/remote-daemon-secret-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

function migratedDb() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  return db;
}

async function startPairableDaemon() {
  const db = migratedDb();
  const devices = new DevicePairingRepository(db);
  const registry = createOperationRegistry([
    defineOperation({
      name: 'work.status',
      description: 'Echo the caller device',
      inputSchema: z.object({}),
      resultSchema: z.object({ kind: z.string().nullable() }),
      execute: async (_input, caller: OperationCaller) => ({ kind: caller.device?.kind ?? null }),
    }),
  ]);
  const router = new MessageHubRouter({
    logger: { error: () => {}, warn: () => {}, log: () => {} },
  });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  hub.registerRouter(router);
  const transport = new WebSocketServerTransport({ name: 'daemon-b', router });
  hub.registerTransport(transport);
  setupOperationHandlers(hub, registry, (clientId) => transport.deviceOf(clientId));
  const pair = createPairRoute({ repo: devices, limiter: createPairingLimiter(), now: Date.now });
  const gateway = new DbGateway(':memory:', db);
  const authenticate = createUpgradeAuthenticator({ db: () => gateway, now: Date.now });
  const server: ServerHandle = await createHttpWsServer({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request, upgrade, client) => {
      const path = new URL(request.url).pathname;
      if (path === '/pair') return pair(request);
      const device = await authenticate(request, client?.remoteAddress ?? null);
      return (
        upgrade(request, { connectionSessionId: 'global', device }) ??
        new Response('upgrade failed', { status: 500 })
      );
    },
    websocket: createWebSocketHandlers(transport, {} as unknown as SessionManager),
  });
  return {
    db,
    devices,
    url: `ws://127.0.0.1:${server.port}/ws`,
    clientCount: () => transport.getClientCount(),
    stop: async () => {
      await transport.close();
      server.stop(true);
      db.close();
    },
  };
}

const human: OperationCaller = { source: 'rpc', principal: 'local' };

describe('attaching a daemon with a pairing code', () => {
  let remote: Awaited<ReturnType<typeof startPairableDaemon>>;
  let localDb: Database;
  let secrets: RemoteDaemonSecretRepository;
  let daemons: RemoteDaemonRegistry;
  let operations: ReturnType<typeof createOperationRegistry>;

  beforeEach(async () => {
    remote = await startPairableDaemon();
    localDb = migratedDb();
    secrets = new RemoteDaemonSecretRepository(localDb);
    daemons = new RemoteDaemonRegistry();
    daemons.restore([], () => {}, secrets);
    operations = createOperationRegistry([
      createAttachDaemonOperation(daemons),
      createDetachDaemonOperation(daemons),
    ]);
  });

  afterEach(async () => {
    daemons.forget('b');
    await remote.stop();
    localDb.close();
  });

  const attach = (input: Record<string, unknown>) =>
    invokeOperation(
      operations,
      'daemon.attach',
      { daemonId: 'b', url: remote.url, ...input },
      human
    );

  test('the remote pairs this daemon and recognises it on every connection; the credential is never returned', async () => {
    const made = remote.devices.createCode('daemon', null, true, Date.now());
    const attached = await attach({ code: made.code });
    expect(attached).toMatchObject({
      kind: 'completed',
      value: { kind: 'attached', daemonId: 'b' },
    });
    const stored = localDb.prepare('SELECT credential FROM remote_daemon_secrets').get() as {
      credential: string;
    };
    expect(JSON.stringify(attached)).not.toContain(stored.credential);
    expect(await daemons.invoke('b', 'work.status', {})).toEqual({ kind: 'daemon' });
    expect(remote.devices.listDevices()).toEqual([
      expect.objectContaining({
        kind: 'daemon',
        lastSeenHost: expect.stringContaining('127.0.0.1'),
      }),
    ]);
  });

  test('revoking the paired daemon closes its connection, and reconnecting is still served unpaired', async () => {
    const made = remote.devices.createCode('daemon', null, true, Date.now());
    await attach({ code: made.code });
    expect(await daemons.invoke('b', 'work.status', {})).toEqual({ kind: 'daemon' });
    const [device] = remote.devices.listDevices();
    remote.devices.revokeDevice(device.id, Date.now());
    announceDeviceRevoked(device.id);
    const deadline = Date.now() + 2000;
    while (remote.clientCount() > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(remote.clientCount()).toBe(0);
    expect(await daemons.invoke('b', 'work.status', {})).toEqual({ kind: null });
  });

  test('a wrong code is refused and leaves nothing attached or stored', async () => {
    expect(await attach({ code: 'AAAAAAAAAA' })).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected', reason: expect.stringContaining('invalid_code') },
    });
    expect(daemons.list()).toEqual([]);
    expect(localDb.prepare('SELECT COUNT(*) AS n FROM remote_daemon_secrets').get()).toEqual({
      n: 0,
    });
  });

  test('without a code the daemon attaches unpaired as before, and detaching forgets a credential', async () => {
    await attach({});
    expect(await daemons.invoke('b', 'work.status', {})).toEqual({ kind: null });
    const made = remote.devices.createCode('daemon', null, true, Date.now());
    await attach({ code: made.code });
    await invokeOperation(operations, 'daemon.detach', { daemonId: 'b' }, human);
    expect(localDb.prepare('SELECT COUNT(*) AS n FROM remote_daemon_secrets').get()).toEqual({
      n: 0,
    });
  });
});
