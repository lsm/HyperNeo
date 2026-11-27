import assert from 'node:assert/strict';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport, type AppMcpServer } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
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

type App = Awaited<ReturnType<typeof createDaemonApp>>;
type SessionProxy = (id: string, name: string) => Promise<{ instance: { connect: (t: unknown) => Promise<void> } } | undefined>;
async function withDaemon<T>(drive: (hub: MessageHub, app: App) => Promise<T>) {
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

let expired: string | null = null;
let refreshHold: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
const fake = await startFakeMcpOAuthServer({
  port: 18347,
  beforeRefreshReply: async () => {
    if (!refreshHold) return undefined;
    refreshHold.started.resolve();
    await refreshHold.release.promise;
    return undefined;
  },
  mcpReply: async (request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const { id, method } = await request.json();
    if (request.headers.get('authorization') === expired)
      return Response.json({ error: 'invalid_token' }, { status: 401 });
    if (id === undefined) return new Response(null, { status: 202 });
    const result =
      method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'loopback', version: '1' } }
        : method === 'tools/list'
          ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'read completed' }] };
    return Response.json({ jsonrpc: '2.0', id, result });
  },
});
const other = await startFakeMcpOAuthServer();

const invoke = <T>(hub: MessageHub, name: string, input: unknown) =>
  hub.request<T>('operation.invoke', { name, input });
const status = (hub: MessageHub, id: string) => invoke(hub, 'mcp.registry.status', { id });
const update = (hub: MessageHub, input: Record<string, unknown>) =>
  hub.request<{ server: AppMcpServer }>('mcp.registry.update', input);
const healthy = { health: 'healthy', scopes: ['read', 'search'] };
const disconnected = { health: 'disconnected', scopes: [] };
const grants = (app: App) =>
  app.db.getDatabase().query<{ count: number }, []>(
    "SELECT count(*) AS count FROM provider_credentials WHERE provider_id LIKE 'hyperneo.connection.%.mcp.%'"
  ).get()?.count;
const readRow = async (hub: MessageHub, id: string) =>
  (await hub.request<{ servers: AppMcpServer[] }>('mcp.registry.list', {})).servers.find((row) => row.id === id);

async function connected(hub: MessageHub, name: string) {
  const { server } = await hub.request<{ server: AppMcpServer }>('mcp.registry.create', {
    name, url: fake.url, sourceType: 'http', enabled: false,
  });
  const { authorizeUrl } = await invoke<{ authorizeUrl: string }>(hub, 'mcp.registry.connect', { id: server.id, preset: 'test' });
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal((await fetch(consent.headers.get('location') ?? '')).status, 200);
  assert.deepEqual(await status(hub, server.id), healthy);
  return server.id;
}

async function retained(app: App, id: string, name: string) {
  const sessionProxy = (app.sessionManager as unknown as { mcpOAuthProxy: SessionProxy }).mcpOAuthProxy;
  const proxy = await sessionProxy(id, name);
  assert(proxy, 'An admitted row must give a session proxy');
  const client = new Client({ name: 'retained-session', version: '1' });
  const [session, server] = InMemoryTransport.createLinkedPair();
  await proxy.instance.connect(server);
  await client.connect(session);
  const call = () => client.callTool({ name: 'read', arguments: {} });
  assert.deepEqual((await call()).content, [{ type: 'text', text: 'read completed' }]);
  return call;
}

async function silent(call: () => Promise<{ isError?: boolean; content: unknown }>) {
  const before = fake.requests.length + other.requests.length;
  const result = await call();
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'reconnect_needed' }]);
  assert.equal(fake.requests.length + other.requests.length, before);
  return 0;
}

try {
  const ids = await withDaemon(async (hub, app) => {
    evidence.step = 'URL replacement while a token save is delayed';
    const moved = await connected(hub, 'oauth-moved');
    const movedCall = await retained(app, moved, 'oauth-moved');
    const lastBearer = fake.requests.filter(({ path }) => path === '/mcp').at(-1)?.auth;
    assert(lastBearer);
    expired = lastBearer;
    refreshHold = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const late = movedCall();
    void late.catch(() => {});
    await Promise.race([refreshHold.started.promise, late.then(() => { throw new Error('Call ended before the refresh'); })]);
    const { server } = await update(hub, { id: moved, url: other.url });
    assert.equal(server.auth?.active, false);
    refreshHold.release.resolve();
    refreshHold = undefined;
    assert.equal((await late).isError, true);
    assert.equal(grants(app), 0);
    assert.deepEqual(await status(hub, moved), disconnected);
    evidence.urlReplacement = { delayedSaveGrants: 0, retainedProxyRequests: await silent(movedCall) };

    evidence.step = 'refuse invalid targets before retiring the grant';
    const kept = await connected(hub, 'oauth-kept');
    const keptCall = await retained(app, kept, 'oauth-kept');
    const refusals = [
      { auth: { kind: 'oauth', preset: 'test', generation: 9, active: true } },
      { sourceType: 'websocket', command: 'mcp' },
      { sourceType: 'stdio', command: 'mcp', name: 'oauth-moved' },
    ];
    for (const refusal of refusals) {
      await assert.rejects(update(hub, { id: kept, ...refusal }));
      assert.deepEqual(await status(hub, kept), healthy);
      assert.equal(grants(app), 1);
      assert.equal((await readRow(hub, kept))?.sourceType, 'http');
    }
    assert.deepEqual((await keptCall()).content, [{ type: 'text', text: 'read completed' }]);
    evidence.invalidTargetsRefused = refusals.length;

    evidence.step = 'source type change retires the grant and clears auth';
    const local = await connected(hub, 'oauth-local');
    const localCall = await retained(app, local, 'oauth-local');
    assert.equal(grants(app), 2);
    const { server: stdio } = await update(hub, { id: local, sourceType: 'stdio', command: 'mcp-local', url: null });
    assert.equal(stdio.sourceType, 'stdio');
    assert.equal(stdio.auth, undefined);
    assert.equal(grants(app), 1);
    assert.deepEqual(await status(hub, local), disconnected);
    evidence.sourceType = { auth: null, grants: 0, retainedProxyRequests: await silent(localCall) };

    evidence.step = 'clearing auth retires the grant';
    const plain = await connected(hub, 'oauth-plain');
    const plainCall = await retained(app, plain, 'oauth-plain');
    assert.equal(grants(app), 2);
    const { server: cleared } = await update(hub, { id: plain, auth: null, name: 'oauth-plain-cleared' });
    assert.equal(cleared.auth, undefined);
    assert.equal(cleared.url, fake.url);
    assert.equal(cleared.name, 'oauth-plain-cleared');
    assert.equal(grants(app), 1);
    evidence.authCleared = { grants: 0, retainedProxyRequests: await silent(plainCall) };
    return { moved, local, plain };
  });
  await withDaemon(async (hub, app) => {
    for (const id of Object.values(ids)) {
      assert.deepEqual(await status(hub, id), disconnected);
    }
    assert.equal(grants(app), 1);
    assert.equal((await readRow(hub, ids.local))?.auth, undefined);
    assert.equal((await readRow(hub, ids.plain))?.auth, undefined);
    assert.equal(other.requests.length, 0);
    evidence.afterRestart = { disconnected: 3, requestsToReplacementUrl: 0 };
  });
  evidence.pass = true;
  delete evidence.step;
} finally {
  refreshHold?.release.resolve();
  fake.stop();
  other.stop();
  writeFileSync(join(run, 'evidence/mcp-oauth-retarget.json'), JSON.stringify(evidence, null, 2));
}
console.log('PASS: OAuth row retargets retired the grant first, invalid targets kept it, and retained proxies sent zero requests');
