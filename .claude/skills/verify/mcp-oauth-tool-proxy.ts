import assert from 'node:assert/strict';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
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

let oldBearer = '';
let oldRefresh = '';
let currentBearer = '';
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
const streamReady = Promise.withResolvers<void>();
let mode = 'normal';
let expired = false;
const fixture = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
const text = (value: string) => ({ type: 'text', text: value });
const tool = { name: 'read', description: 'Read a record', inputSchema: { type: 'object' } };
const secretFree = (value: unknown) =>
  assert(!JSON.stringify(value).includes(oldBearer) && !JSON.stringify(value).includes(oldRefresh) &&
    !JSON.stringify(value).includes(currentBearer),
    'The in-process MCP boundary exposed fixture credentials');
const fake = await startFakeMcpOAuthServer({
  port: 18347,
  mcpReply: async (request) => {
    const bearer = request.headers.get('authorization')?.slice(7) ?? '';
    if (request.method === 'GET') {
      if (stream) return new Response(null, { status: 405 });
      oldBearer = bearer;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          streamReady.resolve();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const { id, method, params } = await request.json();
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
    if (id === undefined) return new Response(null, { status: 202 });
    if (method === 'initialize') return reply({
      protocolVersion: '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'loopback', version: '1' },
    });
    if (method === 'tools/list') {
      if (mode === 'count') return reply({ tools: Array(129).fill(tool) });
      if (mode === 'description-size') return reply({ tools: [{ ...tool, description: '界'.repeat(6000) }] });
      if (mode === 'schema-size') return reply({ tools: [{ ...tool, inputSchema: { type: 'object', description: '界'.repeat(30000) } }] });
      if (mode === 'name') return reply({ tools: [{ ...tool, name: oldBearer }] });
      if (mode === 'description') return reply({ tools: [{ ...tool, description: oldBearer }] });
      if (mode === 'schema-key') return reply({ tools: [{ ...tool, inputSchema: {
        type: 'object', properties: { [oldBearer]: { type: 'string' } },
      } }] });
      return reply({ tools: [tool] });
    }
    if (params.arguments?.path === 'delayed') {
      fixture.started.resolve();
      await fixture.release.promise;
      return reply({ content: [text(bearer)] });
    }
    if (expired && bearer === oldBearer) return new Response(null, { status: 401 });
    currentBearer = bearer;
    oldRefresh = fake.requests.find(({ params }) => params.get('grant_type') === 'refresh_token')
      ?.params.get('refresh_token') ?? '';
    if (params.arguments?.path === 'get') {
      stream?.enqueue(new TextEncoder().encode(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: {
          content: [text(oldBearer), text(oldRefresh)], structuredContent: { [oldBearer]: oldRefresh },
        } })}\n\n`
      ));
      return new Response(null, { status: 202 });
    }
    if (params.arguments?.path === 'tool-error') return reply({ isError: true, content: [text(oldBearer)] });
    if (params.arguments?.path === 'rpc-error')
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32603, message: oldBearer } });
    if (params.arguments?.path === 'bytes') {
      const overhead = Buffer.byteLength(JSON.stringify({ content: [text('kept'), text(''), text('[truncated]')] }));
      const prefix = 'x'.repeat(32768 - overhead - 12);
      return reply({ content: [text('kept'), text(prefix + bearer + '界'.repeat(15000))] });
    }
    if (params.arguments?.path === 'items') return reply({ content: Array(130).fill(text('item')) });
    if (params.arguments?.path === 'transport-cap')
      return reply({ content: [text('x'.repeat(262144))] });
    if (params.arguments?.path === 'retired-credentials')
      return reply({ content: [text(oldBearer), text(oldRefresh)] });
    return reply({ content: [text('read completed')] });
  },
});
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(data, 'daemon.db') }),
  verbose: false,
});
try {
  await app.jobProcessor.stop();
  const { id } = app.db.appMcpServers.create({
    name: 'oauth-tool-proxy-proof', sourceType: 'http', url: fake.url, enabled: false,
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
  assert(typeof service.toolProxy === 'function', 'Missing the in-process MCP tool proxy');
  const proxy = service.toolProxy(id, 'oauth-tool-proxy-proof');
  const client = new Client({ name: 'fixture-session', version: '1' });
  const [session, server] = InMemoryTransport.createLinkedPair();
  await proxy.instance.connect(server);
  await client.connect(session);
  assert.deepEqual((await client.listTools()).tools, [tool]);
  await streamReady.promise;
  assert(oldBearer, 'The standalone GET did not receive a fixture bearer');

  const call = (path: string) => client.callTool({ name: 'read', arguments: { path } });
  const delayed = call('delayed');
  void delayed.catch(() => {});
  await Promise.race([fixture.started.promise, delayed.then(() => {
    throw new Error('Delayed call resolved before reaching the fixture');
  })]);
  expired = true;
  assert.deepEqual((await call('normal')).content, [text('read completed')]);
  fixture.release.resolve();
  const post = await delayed;
  secretFree(post);
  assert.deepEqual(post.content, [text('[redacted]')]);

  const get = await call('get');
  assert(oldRefresh, 'The fixture did not receive a refresh token');
  secretFree(get);
  assert.deepEqual(get.content, [text('[redacted]'), text('[redacted]')]);
  assert.deepEqual(get.structuredContent, { '[redacted]': '[redacted]' });

  for (const path of ['tool-error', 'rpc-error']) {
    const error = await call(path);
    secretFree(error);
    assert.equal(error.isError, true);
    assert.deepEqual(error.content, [text('request_failed')]);
  }

  for (mode of ['count', 'description-size', 'schema-size', 'name', 'description', 'schema-key']) {
    const reason = ['count', 'description-size', 'schema-size'].includes(mode) ? 'response_too_large' : 'request_failed';
    await assert.rejects(client.listTools(), { message: new RegExp(reason) });
  }
  mode = 'normal';

  const bytes = await call('bytes');
  const items = await call('items');
  for (const result of [bytes, items]) {
    secretFree(result);
    assert(Buffer.byteLength(JSON.stringify(result)) <= 32768);
    assert(Array.isArray(result.content));
    assert(result.content.length <= 32);
    assert.deepEqual(result.content.at(-1), text('[truncated]'));
  }
  assert(Array.isArray(bytes.content));
  assert.deepEqual(bytes.content[0], text('kept'));
  assert(bytes.content[1]?.type === 'text' && bytes.content[1].text.endsWith('[redacted]'),
    'A bearer crossing the byte limit must be replaced before truncation');

  const fault = await call('transport-cap');
  assert.equal(fault.isError, true);
  assert.deepEqual(fault.content, [text('response_too_large')]);
  const reopened = await call('retired-credentials');
  secretFree(reopened);
  assert.deepEqual(reopened.content, [text('[redacted]'), text('[redacted]')]);

  await client.close();
  await proxy.instance.close();
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(run, 'evidence/mcp-oauth-tool-proxy.json'), JSON.stringify({
    testedHead: process.argv[2], pass: true, postAfterRefresh: 'redacted',
    standaloneGetAfterRefresh: 'redacted', catalogRefusals: 6,
    sameGenerationTransportReopen: 'redacted',
    outputCaps: ['bytes', 'items'], upstreamError: 'request_failed',
  }, null, 2));
  console.log('PASS: in-process MCP catalog refusal, item and byte caps, delayed POST and standalone GET redaction, bounded upstream error');
} finally {
  fixture.release.resolve();
  fake.stop();
  await app.cleanup();
}
