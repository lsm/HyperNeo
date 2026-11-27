import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { auth } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createMcpFetch, type McpOAuthPreset } from '../../../packages/daemon/src/lib/connections/mcp-fetch.ts';
import { createMcpOAuthProvider } from '../../../packages/daemon/src/lib/connections/mcp-oauth-provider.ts';
import { ConnectionVault } from '../../../packages/daemon/src/lib/connections/vault.ts';
import { createCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { startFakeMcpOAuthServer } from '../../../packages/daemon/tests/helpers/fake-mcp-oauth-server.ts';

const run = resolve(process.argv.at(-1) ?? '');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);

const tools = [{ name: 'read', inputSchema: { type: 'object' } }];
const encoder = new TextEncoder();
let scenario = 'live';
const fake = await startFakeMcpOAuthServer({
  mcpReply: async (request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const { id, method } = await request.json();
    if (method === 'initialize') return Response.json({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'loopback', version: '1' } },
    });
    if (id === undefined) return new Response(null, { status: 202 });
    const result = `data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools } })}\r\n\r\n`;
    const chunks = scenario === 'event-cap'
      ? [`data: ${'é'.repeat(140)}`]
      : scenario === 'body-cap'
        ? Array.from({ length: 6 }, () => `:${'x'.repeat(100)}\n\n`)
        : [': keepalive\r\n\r', '\n' + result];
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      },
    }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  },
});
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
try {
  await app.jobProcessor.stop();
  const preset: McpOAuthPreset = {
    url: fake.url, issuer: fake.base, authorizationEndpoint: `${fake.base}/authorize`,
    origins: [fake.base], scopes: ['read'],
  };
  const vault = new ConnectionVault(createCredentialStore(app.db.getDatabase()), 'streaming-proof');
  let consent: URL | undefined;
  const attempt = createMcpOAuthProvider({
    vault, serverId: 'transport-proof', preset, generation: 1,
    redirectUrl: 'http://127.0.0.1:9/callback',
    attempt: { authorize: (url) => { consent = url; } },
  });
  const authOptions = { serverUrl: fake.url, scope: 'read', fetchFn: attempt.fetch };
  assert.equal(await auth(attempt.provider, authOptions), 'REDIRECT');
  assert(consent);
  const redirect = (await fetch(consent, { redirect: 'manual' })).headers.get('location');
  assert(redirect);
  const authorizationCode = new URL(redirect).searchParams.get('code');
  assert(authorizationCode);
  assert.equal(await auth(attempt.provider, { ...authOptions, authorizationCode }), 'AUTHORIZED');
  await attempt.commit();
  const grant = await vault.readMcp('transport-proof');
  assert(grant);

  const evidence: Record<string, string> = {};
  for (scenario of ['live', 'event-cap', 'body-cap']) {
    const transport = new StreamableHTTPClientTransport(new URL(fake.url), {
      requestInit: { headers: { Authorization: `Bearer ${grant.tokens.access_token}` } },
      fetch: createMcpFetch({
        preset, tokenEndpoint: () => undefined, maxBytes: 512,
        ...{ maxSseEventBytes: 256 },
      }),
    });
    const client = new Client({ name: 'streaming-proof', version: '1' });
    try {
      await client.connect(transport, { timeout: 2000 });
      let fault = '';
      client.onerror = (error) => { if (error.message.includes('response_too_large')) fault = 'response_too_large'; };
      const result = await client.listTools(undefined, { timeout: 2000 }).catch(() => null);
      if (scenario === 'live') {
        assert(result, 'The SDK did not list tools while the SSE response stayed open');
        assert.deepEqual(result.tools, tools);
        evidence[scenario] = 'listed_while_stream_open';
      } else {
        assert.equal(result, null);
        assert.equal(fault, 'response_too_large');
        evidence[scenario] = fault;
      }
    } finally {
      await client.close();
    }
  }
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'evidence/mcp-oauth-streaming.json'), JSON.stringify({
    testedHead: process.argv[2], evidence, pass: true,
  }, null, 2));
  console.log('PASS: SDK listed tools before EOF and refused both oversized SSE events and responses');
} finally {
  fake.stop();
  await app.cleanup();
}
