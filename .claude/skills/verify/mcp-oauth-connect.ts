import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport, type AppMcpServer } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { startFakeMcpOAuthServer } from '../../../packages/daemon/tests/helpers/fake-mcp-oauth-server.ts';

const run = resolve(process.argv.at(-1) ?? '');
const data = join(run, 'data');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, data);
assert(!existsSync(data));
mkdirSync(join(run, 'evidence'));
const config = getConfig({ host: '127.0.0.1', port: 0, dbPath: join(data, 'daemon.db') });
const evidence: Record<string, unknown> = { testedHead: process.argv[2], pass: false };

async function withDaemon<T>(drive: (hub: MessageHub, app: Awaited<ReturnType<typeof createDaemonApp>>) => Promise<T>) {
  const app = await createDaemonApp({ config, verbose: false });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  const transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
    createSocket: (url) => createLocalSocket(url, join(data, 'local-rpc.credential')),
  });
  try {
    await app.jobProcessor.stop();
    hub.registerTransport(transport);
    await transport.initialize();
    return await drive(hub, app);
  } finally {
    await transport.close();
    await app.cleanup();
  }
}

const invoke = <T>(hub: MessageHub, name: string, input: unknown) =>
  hub.request<T>('operation.invoke', { name, input });
const healthy = { health: 'healthy', scopes: ['read', 'search'] };
const disconnected = { health: 'disconnected', scopes: [] };
const reconnectNeeded = { health: 'reconnect_needed', scopes: [] };
const tokenStarted = Promise.withResolvers<void>();
const tokenRelease = Promise.withResolvers<void>();
let holdCodeReply = { started: tokenStarted, release: tokenRelease };
const fake = await startFakeMcpOAuthServer({
  port: 18347,
  advertiseAllScopes: true,
  beforeCodeReply: () => {
    holdCodeReply.started.resolve();
    return holdCodeReply.release.promise;
  },
});
const other = await startFakeMcpOAuthServer();
const lifecycle = process.argv[3] === 'lifecycle';
const rowWrites = process.argv[3] === 'row-writes';
const proofName = lifecycle ? 'mcp-oauth-lifecycle' : rowWrites ? 'mcp-oauth-row-writes' : 'mcp-oauth-connect';
const readStatus = (hub: MessageHub, id: string) =>
  invoke(hub, 'mcp.registry.status', { id });
const reopen = (hub: MessageHub, id: string) =>
  invoke<{ authorizeUrl: string }>(hub, 'mcp.registry.reconnect', { id });
const disconnect = (hub: MessageHub, id: string) =>
  invoke(hub, 'mcp.registry.disconnect', { id });
const grantCount = (app: Awaited<ReturnType<typeof createDaemonApp>>) =>
  app.db.getDatabase().query<{ count: number }, []>(
    "SELECT count(*) AS count FROM provider_credentials WHERE provider_id LIKE 'hyperneo.connection.%.mcp.%'"
  ).get()?.count;
const callbackUrl = async (authorizeUrl: string) => {
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(consent.status, 302);
  return new URL(consent.headers.get('location') ?? '');
};
try {
  const id = await withDaemon(async (hub, app) => {
    const create = async (name: string, url: string) =>
      (await hub.request<{ server: AppMcpServer }>('mcp.registry.create', {
        name, url, sourceType: 'http', enabled: false,
      })).server.id;
    const id = await create('oauth-proof', fake.url);
    const input = { id, preset: 'test' };
    const { authorizeUrl } = await invoke<{ authorizeUrl: string }>(hub, 'mcp.registry.connect', input);
    assert.deepEqual(await invoke(hub, 'mcp.registry.connect', input), { reason: 'connect_pending' });
    const agent = createOperationMcpHandler(
      () => app.sessionManager.getOperationRegistry(),
      () => ({ sessionId: 'synthetic-worker', role: 'neo' })
    );
    const denied = await agent({ name: 'mcp.registry.connect', input });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).code, 'forbidden');
    const mismatch = await create('oauth-mismatched', other.url);
    assert.deepEqual(
      await invoke(hub, 'mcp.registry.connect', { ...input, id: mismatch }),
      { reason: 'invalid_preset' }
    );
    assert.equal(other.requests.length, 0);
    const callback = await callbackUrl(authorizeUrl);
    const wrong = new URL(callback);
    wrong.searchParams.set('state', 'incorrect');
    const wrongState = (await fetch(wrong)).status;
    assert.equal(wrongState, 400);
    assert.equal(fake.requests.filter(({ path }) => path === '/token').length, 0);
    const completion = fetch(callback);
    try {
      await Promise.race([tokenStarted.promise, completion.then(() => { throw new Error('Callback ended before code exchange'); })]);
      const replay = (await fetch(callback)).status;
      assert.equal(replay, 400);
      assert.deepEqual(await invoke(hub, 'mcp.registry.status', { id }), {
        health: 'disconnected', scopes: [],
      });
      evidence.callback = { wrongState, replay };
    } finally {
      tokenRelease.resolve();
    }
    assert.equal((await completion).status, 200);
    assert.equal(fake.requests.filter(({ path }) => path === '/token').length, 1);
    assert.deepEqual(fake.authorizeScopes, ['read search']);
    const health = await invoke(hub, 'mcp.registry.status', { id });
    assert.deepEqual(health, healthy);
    const { servers } = await hub.request<{ servers: AppMcpServer[] }>('mcp.registry.list', {});
    assert.deepEqual(servers.find((server) => server.id === id)?.auth, {
      kind: 'oauth', preset: 'test', generation: 1, active: true,
    });
    Object.assign(evidence, { health, agentRefused: true, requestsToMismatchedServer: 0, codeExchanges: 1 });
    return id;
  });
  await withDaemon(async (hub) => {
    const health = await invoke(hub, 'mcp.registry.status', { id });
    assert.deepEqual(health, healthy);
    evidence.afterRestart = health;
  });
  if (lifecycle) {
    await withDaemon(async (hub, app) => {
      const { authorizeUrl } = await reopen(hub, id);
      assert.equal(new URL(authorizeUrl).pathname, '/authorize');
      assert.deepEqual(await readStatus(hub, id), healthy);
      assert.equal(grantCount(app), 1);
      const cancel = await callbackUrl(authorizeUrl);
      cancel.searchParams.delete('code');
      cancel.searchParams.set('error', 'access_denied');
      assert.equal((await fetch(cancel)).status, 400);
      assert.deepEqual(await readStatus(hub, id), healthy);

      const agent = createOperationMcpHandler(
        () => app.sessionManager.getOperationRegistry(),
        () => ({ sessionId: 'synthetic-worker', role: 'neo' })
      );
      for (const name of ['mcp.registry.reconnect', 'mcp.registry.disconnect']) {
        const denied = await agent({ name, input: { id } });
        assert.equal(denied.isError, true);
        assert.equal(JSON.parse(denied.content[0].text).code, 'forbidden');
      }

      const reconnect = await reopen(hub, id);
      assert.equal((await fetch(await callbackUrl(reconnect.authorizeUrl))).status, 200);
      assert.deepEqual(await readStatus(hub, id), healthy);
      assert.equal(app.db.appMcpServers.get(id)?.auth?.generation, 2);

      const delayed = await reopen(hub, id);
      const callback = await callbackUrl(delayed.authorizeUrl);
      const hold = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      holdCodeReply = hold;
      const reply = fetch(callback).then((response) => response.status, () => 'closed');
      try {
        await Promise.race([hold.started.promise, reply.then(() => { throw new Error('Callback ended before code exchange'); })]);
        assert.deepEqual(await readStatus(hub, id), healthy);
        assert.deepEqual(await disconnect(hub, id), { ok: true });
      } finally {
        hold.release.resolve();
        holdCodeReply = { started: tokenStarted, release: tokenRelease };
      }
      assert.notEqual(await reply, 200);
      assert.deepEqual(await readStatus(hub, id), disconnected);
      assert.equal(grantCount(app), 0);
      evidence.delayedConsent = { health: disconnected.health, grants: 0 };

      const fresh = await invoke<{ authorizeUrl: string }>(hub, 'mcp.registry.connect', { id, preset: 'test' });
      assert.equal((await fetch(await callbackUrl(fresh.authorizeUrl))).status, 200);
      app.db.getDatabase().exec(`
        CREATE TRIGGER proof_fail_grant_erase BEFORE DELETE ON provider_credentials
        BEGIN SELECT RAISE(ABORT, 'synthetic erase failure'); END
      `);
      assert.deepEqual(await disconnect(hub, id), { ok: false, reason: 'request_failed' });
      assert.deepEqual(await readStatus(hub, id), disconnected);
      assert.equal(grantCount(app), 1);
    });
    await withDaemon(async (hub, app) => {
      assert.deepEqual(await readStatus(hub, id), disconnected);
      assert.equal(grantCount(app), 1);
      evidence.eraseFailureAfterRestart = { health: disconnected.health, grants: 1 };
      app.db.getDatabase().exec('DROP TRIGGER proof_fail_grant_erase');
      const fresh = await invoke<{ authorizeUrl: string }>(hub, 'mcp.registry.connect', { id, preset: 'test' });
      assert.equal((await fetch(await callbackUrl(fresh.authorizeUrl))).status, 200);
      const reconnect = await reopen(hub, id);
      app.db.getDatabase().exec(`
        CREATE TRIGGER proof_stop_before_activation BEFORE UPDATE OF auth ON app_mcp_servers
        BEGIN SELECT RAISE(ABORT, 'synthetic interrupted activation'); END
      `);
      assert.equal((await fetch(await callbackUrl(reconnect.authorizeUrl))).status, 400);
      assert.deepEqual(await readStatus(hub, id), reconnectNeeded);
    });
    await withDaemon(async (hub) => {
      assert.deepEqual(await readStatus(hub, id), reconnectNeeded);
      evidence.interruptedActivationAfterRestart = reconnectNeeded.health;
    });
    const refreshRequests = fake.requests.filter(({ params }) => params.get('grant_type') === 'refresh_token').length;
    assert.equal(refreshRequests, 0);
    evidence.reconnectRefreshRequests = refreshRequests;
  }
  if (rowWrites) {
    const readRow = async (hub: MessageHub) =>
      (await hub.request<{ servers: AppMcpServer[] }>('mcp.registry.list', {}))
        .servers.find((server) => server.id === id);
    await withDaemon(async (hub, app) => {
      const callback = await callbackUrl((await reopen(hub, id)).authorizeUrl);
      const hold = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      holdCodeReply = hold;
      const reply = fetch(callback).then((response) => response.status, () => 'closed');
      try {
        await Promise.race([hold.started.promise, reply.then(() => { throw new Error('Callback ended before code exchange'); })]);
        evidence.step = 'reject conflicting name before replacing URL';
        await assert.rejects(hub.request('mcp.registry.update', {
          id, url: other.url, name: 'oauth-mismatched',
        }), /already exists/);
        assert.deepEqual(await readStatus(hub, id), healthy);
        assert.equal((await readRow(hub))?.url, fake.url);
        assert.equal(grantCount(app), 1);
        evidence.rejectedUpdatePreservedGrant = true;
        evidence.step = 'replace URL during consent';
        const { server } = await hub.request<{ server: AppMcpServer }>('mcp.registry.update', {
          id, url: other.url, sourceType: 'http', name: 'oauth-retargeted',
        });
        assert.equal(server.url, other.url);
        assert.equal(server.name, 'oauth-retargeted');
        assert.equal(server.auth?.active, false);
      } finally {
        hold.release.resolve();
        holdCodeReply = { started: tokenStarted, release: tokenRelease };
        await reply;
      }
      assert.notEqual(await reply, 200);
      assert.deepEqual(await readStatus(hub, id), disconnected);
      assert.deepEqual(await invoke(hub, 'mcp.registry.connect', { id, preset: 'test' }), {
        reason: 'invalid_preset',
      });
      assert.equal(other.requests.length, 0);
      assert.equal(grantCount(app), 0);
      const agent = createOperationMcpHandler(
        () => app.sessionManager.getOperationRegistry(),
        () => ({ sessionId: 'synthetic-worker', role: 'neo' })
      );
      const denied = await agent({ name: 'mcp.registry.replace', input: { id, url: fake.url } });
      assert.equal(denied.isError, true);
      assert.equal(JSON.parse(denied.content[0].text).code, 'forbidden');
      assert.equal((await readRow(hub))?.url, other.url);

      evidence.rowWrites = {
        agentRefused: true, delayedCallbacksRefused: 1, grantsAfterReplacement: 0,
        requestsToReplacementUrl: 0,
      };
    });
    await withDaemon(async (hub, app) => {
      assert.equal((await readRow(hub))?.url, other.url);
      assert.deepEqual(await readStatus(hub, id), disconnected);
      assert.equal(grantCount(app), 0);
      evidence.replacementAfterRestart = 'disconnected';
    });
  }
  evidence.pass = true;
} finally {
  tokenRelease.resolve();
  fake.stop();
  other.stop();
  writeFileSync(join(run, `evidence/${proofName}.json`), JSON.stringify(evidence, null, 2));
}
console.log(lifecycle
  ? 'PASS: human reconnect and disconnect, cancelled consent, delayed callback, failed erase and interrupted activation'
  : rowWrites
    ? 'PASS: registry URL replacement denied the agent, fenced delayed consent and stayed disconnected after restart'
    : 'PASS: human connected through RPC and one-use callback; agent and URL mismatch refused; one exchange; read scopes and healthy after restart');
