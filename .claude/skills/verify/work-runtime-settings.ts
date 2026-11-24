import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'])
  assert(!process.env[key], key);
mkdirSync(join(run, 'evidence'));
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
const mockPort = reservation.port;
reservation.stop(true);
const mock = await createMockApiServer({ port: mockPort });
await mock.start();

const first = 'REMEMBER_SYNTHETIC_BLUE';
const second = 'RECALL_SYNTHETIC_BLUE';
const turns: { first: boolean; second: boolean; model: string; effort?: string }[] = [];
const proxy = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const { pathname, search } = new URL(request.url);
    const body = request.method === 'GET' ? undefined : await request.text();
    if (pathname.endsWith('/v1/messages') && body) {
      const payload = JSON.parse(body);
      const messages = JSON.stringify(payload.messages);
      if (messages.includes(first) || messages.includes(second))
        turns.push({
          first: messages.includes(first), second: messages.includes(second),
          model: payload.model, effort: payload.output_config?.effort,
        });
    }
    return fetch(mock.serverUrl + pathname + search, {
      method: request.method, body, headers: { 'content-type': 'application/json' },
    });
  },
});
process.env.HYPERNEO_USE_DEV_PROXY = '1';
process.env.VERIFY_MOCK_PORT = String(proxy.port);
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }),
    disableWorktrees: true,
  },
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  createSocket: createLocalSocket, url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false,
});
hub.registerTransport(transport);
const evidence: Record<string, unknown> = { daemonPort: app.server.port, turns };

async function completed(sessionId: string, count: number) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const { sdkMessages } = await hub.request<{ sdkMessages: { type: string; is_error?: boolean }[] }>(
      'message.sdkMessages', { sessionId }
    );
    const results = sdkMessages.filter((message) => message.type === 'result' && !message.is_error);
    const { session } = await hub.request<{ session: { processingState?: string } }>('session.get', { sessionId });
    if (results.length >= count && (!session.processingState || JSON.parse(session.processingState).status === 'idle'))
      return results.length;
    await Bun.sleep(100);
  }
  throw new Error(`Expected ${count} completed turns; saw wire requests ${JSON.stringify(turns)}`);
}

try {
  await transport.initialize();
  const { servers } = await hub.request<{ servers: Array<{ id: string }> }>('mcp.registry.list', {});
  for (const server of servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await hub.request('providers.create', {
    params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 },
    credentials: { apiKey: 'sk-devproxy-test-key' },
  });
  await hub.request('models.list', { forceRefresh: true });
  const start = await hub.request<{ ok: boolean; value: { ref: { adapter: string; id: string } } }>('operation.invoke', {
    name: 'work.start',
    input: { adapter: 'hyperneo', place: { machine: hostname(), folder: run, name: "Synthetic" }, title: 'Synthetic worker',
      message: first, model: 'claude-haiku-5-5', effort: 'off' },
  });
  assert.equal(start.ok, true, JSON.stringify(start));
  const { ref } = start.value;
  const neoId = 'neo:synthetic';
  assert(new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: neoId, projectId: null, kind: 'neo' }));
  const mcp = createOperationMcpHandler(app.sessionManager.getOperationRegistry(), () => ({
    role: 'neo', sessionId: neoId,
  }));
  const invokeAsNeo = async (name: string, input: unknown) => {
    const response = await mcp({ name, input });
    return JSON.parse((response.content[0] as { text: string }).text);
  };
  const discovery = await invokeAsNeo('operations.list', { prefix: 'work' });
  evidence.discoverable = discovery.names.includes('work.reconfigure');
  assert.equal(evidence.discoverable, true);
  evidence.completedTurns = await completed(ref.id, 1);
  const { value: status } = await invokeAsNeo('work.status', { ref });
  assert.deepEqual(status.ref, ref);
  const reconfigure = (input: unknown) => invokeAsNeo('work.reconfigure', input);
  const { sessionId: humanId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: run, title: 'Human session', config: { model: 'claude-haiku-5-5', provider: 'anthropic' },
  });
  const refusals = await Promise.all([
    reconfigure({ ref: { ...ref, id: humanId }, effort: 'high' }),
    reconfigure({ ref: { ...ref, adapter: 'codex-desktop' }, effort: 'high' }),
    reconfigure({ ref, model: 'missing-model' }),
    reconfigure({ ref, effort: 'not-an-effort' }),
  ]);
  evidence.refusals = refusals.map(({ reason }) => reason);
  assert.deepEqual(evidence.refusals, ['not_started_by_us', 'not_supported', 'unsupported_model', 'unsupported_effort']);
  const receipt = await reconfigure({ ref: status.ref, model: 'claude-sonnet-5-5', effort: 'high' });
  evidence.receipt = receipt;
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.value.previous.model, 'claude-haiku-5-5');
  assert.equal(receipt.value.next.model, 'claude-sonnet-5-5');
  assert.equal(receipt.value.next.effort, 'high');
  assert.equal(receipt.value.appliesFrom, 'next-turn');
  await hub.request('message.send', { sessionId: ref.id, content: second });
  evidence.completedTurns = await completed(ref.id, 2);
  assert(turns.some((turn) => turn.first && !turn.second && turn.model.startsWith('claude-haiku-')));
  assert(turns.some((turn) => turn.first && turn.second && turn.model === 'claude-sonnet-5-5' && turn.effort === 'high'));
  const effortOnly = await reconfigure({ ref, effort: 'medium' });
  evidence.effortOnly = effortOnly;
  assert.deepEqual(effortOnly.value.next, { model: 'claude-sonnet-5-5', effort: 'medium' });
  await hub.request('session.update', { sessionId: ref.id, title: 'Named by a person', metadata: { titleSetBy: 'user' } });
  const named = await reconfigure({ ref, model: 'claude-haiku-5-5' });
  evidence.named = named.reason;
  assert.equal(named.reason, 'human_only');
  console.log(`PASS: ${evidence.completedTurns} turns on one ref; next request used Sonnet with high effort and retained prior input.`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await app.cleanup();
  proxy.stop(true);
  await mock.stop();
}
