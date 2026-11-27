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
const tokenStarted = Promise.withResolvers<void>();
const tokenRelease = Promise.withResolvers<void>();
const fake = await startFakeMcpOAuthServer({
  port: 18347,
  advertiseAllScopes: true,
  beforeCodeReply: () => {
    tokenStarted.resolve();
    return tokenRelease.promise;
  },
});
const other = await startFakeMcpOAuthServer();
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
    const consent = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(consent.status, 302);
    const callback = new URL(consent.headers.get('location') ?? '');
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
  evidence.pass = true;
} finally {
  tokenRelease.resolve();
  fake.stop();
  other.stop();
  writeFileSync(join(run, 'evidence/mcp-oauth-connect.json'), JSON.stringify(evidence, null, 2));
}
console.log('PASS: human connected through RPC and one-use callback; agent and URL mismatch refused; one exchange; read scopes and healthy after restart');
