import { strict as assert } from 'node:assert';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_USE_DEV_PROXY, '1');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'])
  assert(!process.env[key], key);
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const markers = ['WORKER_REPORT_AFTER_INTERRUPT', 'TODO_NOTICE_AFTER_INTERRUPT', 'LOCAL_TIME_AFTER_INTERRUPT'];
const requests: string[] = [];
const evidence: Record<string, unknown> = { run, requests };
const mock = await createMockApiServer({ port: 8001 });
await mock.start();
let holding = false;
const proxy = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  const modelRequest = req.url?.includes('/messages') && !req.url.includes('count_tokens');
  if (modelRequest) {
    requests.push(JSON.stringify({ markers: ['INTERRUPT_CURRENT_TURN', ...markers].filter((marker) => body.includes(marker)) }));
    if (!holding && body.includes('INTERRUPT_CURRENT_TURN')) {
      holding = true;
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      return;
    }
  }
  try {
    const upstream = await fetch(mock.serverUrl + req.url, {
      method: req.method, headers: { 'content-type': 'application/json' },
      ...(req.method !== 'GET' ? { body } : {}),
    });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    for await (const chunk of upstream.body!) res.write(chunk);
    res.end();
  } catch {
    res.destroy();
  }
});
await new Promise<void>((done) => proxy.listen(8000, '127.0.0.1', done));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 45000;
  while (!check()) {
    assert(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 50));
  }
}
try {
  await transport.initialize();
  await hub.request('providers.create', {
    params: { providerId: 'anthropic', displayName: 'Isolated mock', kind: 'built_in',
      authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 },
    credentials: { apiKey: 'sk-devproxy-test-key' },
  });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'home'), title: 'Interrupt queued input proof', config: { model: 'haiku', provider: 'anthropic' },
  });
  evidence.sessionId = sessionId;
  const current = await hub.request<{ messageId: string }>('message.send', { sessionId, content: 'INTERRUPT_CURRENT_TURN' });
  await until(() => holding, 'current turn never reached isolated model');
  const repo = app.db.getSDKMessageRepo();
  const jobs = app.db.getJobQueueRepo();
  for (const [index, marker] of markers.entries()) {
    const uuid = crypto.randomUUID();
    repo.saveUserMessage(sessionId, { type: 'user', uuid, message: { role: 'user', content: marker } }, 'enqueued');
    if (index < 2) jobs.enqueue({
      queue: 'message_delivery', payload: { sessionId, messageUuid: uuid, origin: 'recovery', parentToolUseId: null },
      runAt: Date.now() + 1000, maxRetries: 8,
    });
  }
  const rows = () => app.db.getDatabase().prepare(
    "SELECT sdk_uuid, send_status FROM sdk_messages WHERE session_id = ? AND message_type = 'user' ORDER BY seq"
  ).all(sessionId) as Array<{ sdk_uuid: string; send_status: string }>;
  evidence.before = rows();
  let interrupted = false;
  const unsub = app.internalEventBus.subscribe('agent.interrupted', () => { interrupted = true; }, { sessionId, subscriberName: 'verify.interrupt' });
  evidence.receipt = await hub.request('client.interrupt', { sessionId });
  await until(() => interrupted, 'client.interrupt never completed');
  unsub();
  evidence.afterInterrupt = rows();
  assert.equal(rows().filter((row) => row.send_status === 'failed').length, 0, 'interrupt failed queued input');
  assert(rows().some((row) => row.sdk_uuid === current.messageId && row.send_status === 'consumed'), 'current input was replayed or lost');
  await until(() => rows().every((row) => row.send_status === 'consumed') &&
    markers.every((marker) => requests.slice(1).some((body) => body.includes(marker))), 'queued inputs did not reach next model turn');
  evidence.afterDelivery = rows();
  evidence.pass = true;
  console.log(`PASS: interrupted turn ended; all three queued inputs reached the next turn. ${run}/evidence/interrupt.json`);
} finally {
  writeFileSync(join(run, 'evidence/interrupt.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await app.cleanup();
  proxy.closeAllConnections();
  await new Promise<void>((done) => proxy.close(() => done()));
  await mock.stop();
}
