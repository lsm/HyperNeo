import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createMcpOAuthOperations } from '../../../packages/daemon/src/lib/connections/mcp-oauth-operations.ts';
import { createCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { startFakeMcpOAuthServer } from '../../../packages/daemon/tests/helpers/fake-mcp-oauth-server.ts';

const run = resolve(process.argv.at(-1) ?? '');
const data = join(run, 'data');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, data);
assert(!existsSync(data));

const tools = [{ name: 'read', inputSchema: { type: 'object' } }];
const toolResult = { content: [{ type: 'text', text: 'read completed' }] };
const delayed = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
const refreshStarted = Promise.withResolvers<void>();
const refreshRelease = Promise.withResolvers<void>();
let bearer: string | null = null;
let expired: string | null = null;
let holdCall = false;
let challengeScope = false;
let oversized = false;
let initializations = 0;
let expiredRequests = 0;
const fake = await startFakeMcpOAuthServer({
  port: 18347,
  beforeRefreshReply: () => {
    refreshStarted.resolve();
    return refreshRelease.promise;
  },
  mcpReply: async (request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const { id, method } = await request.json();
    bearer = request.headers.get('authorization');
    if (bearer === expired) {
      expiredRequests++;
      return Response.json({ error: 'invalid_token' }, { status: 401 });
    }
    if (challengeScope && method === 'tools/call')
      return Response.json({ error: 'insufficient_scope' }, {
        status: 403, headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="write"' },
      });
    if (id === undefined) return new Response(null, { status: 202 });
    if (oversized && method === 'tools/call')
      return new Response(`data: ${'x'.repeat(65536)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    let result: unknown = toolResult;
    if (method === 'initialize') {
      initializations++;
      result = {
        protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'loopback', version: '1' },
      };
    }
    if (method === 'tools/list') result = { tools };
    if (method === 'tools/call' && holdCall) {
      delayed.started.resolve();
      await delayed.release.promise;
    }
    return Response.json({ jsonrpc: '2.0', id, result });
  },
});
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(data, 'daemon.db') }),
  verbose: false,
});
try {
  await app.jobProcessor.stop();
  const { id } = app.db.appMcpServers.create({
    name: 'oauth-row-client-proof', sourceType: 'http', url: fake.url, enabled: false,
  });
  const service = createMcpOAuthOperations(app.db, createCredentialStore(app.db.getDatabase()), () => {});
  const operation = async (name: string, input: object) => {
    const entry = service.operations.find((candidate) => candidate.name === name);
    assert(entry);
    const result = await entry.execute(entry.inputSchema.parse({ id, ...input }), { source: 'rpc', principal: 'local' });
    return entry.resultSchema.parse(result);
  };
  const consent = async (name: string, input: object) => {
    const result = await operation(name, input);
    assert(result && typeof result === 'object' && 'authorizeUrl' in result);
    const url = result.authorizeUrl;
    assert(typeof url === 'string');
    const response = await fetch(url, { redirect: 'manual' });
    const callback = response.headers.get('location');
    assert(callback);
    assert.equal((await fetch(callback)).status, 200);
  };

  await consent('mcp.registry.connect', { preset: 'test' });
  const client = service.client;
  assert(client, 'Missing the daemon-held SDK client for an admitted row');
  const call = () => client.callTool(id, { name: 'read' });
  const lists = await Promise.all([client.listTools(id), client.listTools(id)]);
  assert.deepEqual(lists.map((result) => result.tools), [tools, tools]);
  assert.equal(initializations, 1);

  assert(bearer, 'The fixture did not receive a bearer');
  expired = bearer;
  const concurrent = Promise.all([call(), call(), call()]);
  void concurrent.catch(() => {});
  await Promise.race([
    refreshStarted.promise,
    concurrent.then(() => { throw new Error('Expired calls returned before refreshing'); }),
  ]);
  const deadline = Date.now() + 2000;
  while (expiredRequests < 3 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
  assert.equal(expiredRequests, 3);
  refreshRelease.resolve();
  assert.deepEqual(await concurrent, Array(3).fill(toolResult));
  assert.equal(fake.requests.filter(({ params }) => params.get('grant_type') === 'refresh_token').length, 1);
  assert.equal(initializations, 1);

  challengeScope = true;
  await assert.rejects(call(), { message: 'unauthorized' });
  challengeScope = false;
  assert.equal(fake.authorizeScopes.length, 1);

  holdCall = true;
  const old = assert.rejects(call(), { message: 'reconnect_needed' });
  await Promise.race([
    delayed.started.promise,
    old.then(() => { throw new Error('The old tool call never reached the fixture'); }),
  ]);
  await consent('mcp.registry.reconnect', {});
  holdCall = false;
  delayed.release.resolve();
  await old;
  assert.deepEqual(await call(), toolResult);
  assert.equal(initializations, 2);

  oversized = true;
  await assert.rejects(call(), { message: 'response_too_large' });
  oversized = false;
  assert.deepEqual(await call(), toolResult);
  assert.equal(initializations, 3);

  assert.deepEqual(await operation('mcp.registry.disconnect', {}), { ok: true });
  const requests = fake.requests.length;
  await assert.rejects(call(), { message: 'reconnect_needed' });
  assert.equal(fake.requests.length, requests);
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(run, 'evidence/mcp-oauth-row-client.json'), JSON.stringify({
    testedHead: process.argv[2], initializations, expiredRequests, refreshRequests: 1,
    consentRequests: fake.authorizeScopes.length, retiredCallRefused: true,
    disconnectedContact: 0, oversized: 'response_too_large', pass: true,
  }, null, 2));
  console.log('PASS: one SDK connection per generation, one refresh under concurrency, retired result refused, disconnected row made zero requests');
} finally {
  refreshRelease.resolve();
  delayed.release.resolve();
  fake.stop();
  await app.cleanup();
}
