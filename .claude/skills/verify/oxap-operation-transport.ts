import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
const counts = { catalog: 0, neoCatalog: 0, desktopCatalog: 0, calls: 0, refusals: 0, detach: 0, shutdown: 0 };
const clients: Client[] = [];
let stopped = false;
try {
  await app.spaceRuntimeService.ready();
  const manager = app.sessionManager;
  const first = await manager.createSession({ title: 'First tool chat' });
  const second = await manager.createSession({ title: 'Second tool chat' });
  const firstSession = await manager.getSessionForControl(first);
  assert(firstSession);
  assert.equal(typeof manager.grantOperationMcp, 'function', 'loopback MCP grant entry point');
  const firstGrant = await manager.grantOperationMcp(first);
  const secondGrant = await manager.grantOperationMcp(second);
  const endpoint = new URL(firstGrant.endpoint);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(endpoint.pathname, '/mcp');
  assert.equal(endpoint.search, '');
  assert.equal(secondGrant.endpoint, firstGrant.endpoint);
  assert(firstGrant.bearer !== secondGrant.bearer, 'separate chat grants');
  const connect = async (bearer: string) => {
    const client = new Client({ name: 'operations-proof', version: '1' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    });
    await client.connect(transport);
    return { client, transport };
  };
  const a = await connect(firstGrant.bearer);
  const b = await connect(secondGrant.bearer);
  const connectClaude = async (session: typeof firstSession) => {
    const client = new Client({ name: 'operations-proof', version: '1' });
    clients.push(client);
    const [left, right] = InMemoryTransport.createLinkedPair();
    await session.getOperationMcpServer().instance.connect(right);
    await client.connect(left);
    return client;
  };
  const claude = await connectClaude(firstSession);
  const wire = (result: unknown) => JSON.parse(JSON.stringify(result));
  const claudeTools = await claude.listTools();
  assert.deepEqual((await a.client.listTools()).tools, wire(claudeTools.tools));
  assert.deepEqual(claudeTools.tools.map(({ name }) => name), ['invoke']);
  counts.catalog = claudeTools.tools.length;
  const neoId = await manager.createSession({ sessionId: 'neo:transport-proof', title: 'Neo' });
  app.db.getDatabase().prepare("INSERT INTO neo_session_bindings (session_id, kind) VALUES (?, 'neo')").run(neoId);
  const neoSession = await manager.getSessionForControl(neoId);
  assert(neoSession);
  const neoGrant = await manager.grantOperationMcp(neoId);
  const neoTools = (await (await connect(neoGrant.bearer)).client.listTools()).tools;
  assert.deepEqual(neoTools, wire((await (await connectClaude(neoSession)).listTools()).tools));
  assert(neoTools.length > 1, 'Neo sees resident tools');
  counts.neoCatalog = neoTools.length;
  const desktopId = await manager.createSession({ title: 'Desktop catalog', toolProfile: 'desktop' });
  const desktopSession = await manager.getSessionForControl(desktopId);
  assert(desktopSession);
  const desktopGrant = await manager.grantOperationMcp(desktopId);
  const desktopTools = (await (await connect(desktopGrant.bearer)).client.listTools()).tools;
  assert.deepEqual(desktopTools, wire((await (await connectClaude(desktopSession)).listTools()).tools));
  assert(desktopTools.some(({ name }) => name === 'get_window_state'));
  counts.desktopCatalog = desktopTools.length;

  const invoke = (name: string, input = {}) => ({ name: 'invoke', arguments: { name, input } });
  for (const call of [
    invoke('operations.list'),
    invoke('operations.describe', { name: 'message.send' }),
    invoke('operations.proof_missing'),
  ]) {
    assert.deepEqual(await a.client.callTool(call), wire(await claude.callTool(call)));
    counts.calls++;
  }
  const { count } = app.db.getDatabase().query<{ count: number }, [string, string]>(
    'SELECT count(*) AS count FROM operation_refusals WHERE operation = ? AND session_id = ?'
  ).get('operations.proof_missing', first)!;
  assert.equal(count, 2);

  const status = async (bearer: string, id: string | undefined, headers = {}, body?: string) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(id ? { 'mcp-session-id': id } : {}),
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...headers,
      },
      body: body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: invoke('operations.list') }),
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return response.status;
  };
  assert(a.transport.sessionId && b.transport.sessionId);
  assert.equal(await status(secondGrant.bearer, a.transport.sessionId), 401);
  assert.equal(await status(firstGrant.bearer, b.transport.sessionId), 401);
  assert.equal(await status(firstGrant.bearer, a.transport.sessionId, { origin: endpoint.origin }), 403);
  assert.equal(await status(firstGrant.bearer, a.transport.sessionId, { host: 'example.invalid' }), 403);
  assert.equal(await status(firstGrant.bearer, a.transport.sessionId, { 'content-type': 'text/plain' }), 415);
  assert.equal(await status(firstGrant.bearer, a.transport.sessionId, {}, 'x'.repeat(4 * 1024 * 1024 + 1)), 413);
  counts.refusals += 6;

  await a.transport.terminateSession();
  await a.client.close();
  const detached = await connect(firstGrant.bearer);
  counts.detach += (await detached.client.listTools()).tools.length;
  const oldMcpId = detached.transport.sessionId;
  await detached.client.close();
  const reconnected = await connect(firstGrant.bearer);
  counts.detach += (await reconnected.client.listTools()).tools.length;
  assert.equal(await status(firstGrant.bearer, oldMcpId), 401);
  counts.refusals++;
  await manager.archiveSessionResources(first, 'ui_session_archive');
  assert.equal(await status(firstGrant.bearer, reconnected.transport.sessionId), 401);
  counts.refusals++;
  assert.equal((await b.client.listTools()).tools.length, 1);
  assert.equal((await manager.getSessionLifecycle().unarchive(first)).success, true);
  const renewed = await manager.grantOperationMcp(first);
  assert(renewed.bearer !== firstGrant.bearer, 'reopened chat has a new bearer');
  const reopened = await connect(renewed.bearer);
  assert.equal((await reopened.client.listTools()).tools.length, 1);
  await manager.deleteSessionResources(first, 'ui_session_delete');
  assert.equal(await status(renewed.bearer, reopened.transport.sessionId), 401);
  counts.refusals++;

  await app.cleanup();
  stopped = true;
  await assert.rejects(status(secondGrant.bearer, b.transport.sessionId), (error: Error) => error.name !== 'TimeoutError');
  counts.shutdown++;
  console.log(`PASS ${JSON.stringify(counts)} refusalAuditRows=${count}`);
} finally {
  await Promise.all(clients.map((client) => client.close()));
  if (!stopped) await app.cleanup();
  writeFileSync(join(run, 'evidence/operations-transport.json'), JSON.stringify(counts, null, 2));
}
