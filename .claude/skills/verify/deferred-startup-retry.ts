import { strict as assert } from 'node:assert';
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';

const run = resolve(process.argv[2]);
const retryKind = process.argv[3] ?? 'startup';
assert(['startup', 'transient', 'stall'].includes(retryKind));
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_USE_DEV_PROXY, '1');
assert.equal(process.env.HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS, '15000');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'])
  assert(!process.env[key], key);
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const markers = [retryKind === 'stall' ? 'STALL_RETRY_INPUT' : retryKind === 'transient' ? 'TRANSIENT_RETRY_INPUT' : 'STARTUP_RETRY_INPUT', 'DEFERRED_AFTER_RETRY'];
const inputs: Array<{ attempt: number; type: string; uuid?: string }> = [];
const requests: string[] = [];
const evidence: Record<string, unknown> = { run, retryKind, requests, inputs };
const mock = await createMockApiServer({ port: 8001 });
await mock.start();

let attempt = 0;
const proxy = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  const modelRequest = req.url?.includes('/messages') && !req.url.includes('count_tokens');
  if (modelRequest) {
    requests.push(JSON.stringify({ markers: markers.filter((marker) => body.includes(marker)) }));
    if (retryKind === 'stall' && attempt === 1 && body.includes(markers[0])) {
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
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
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
    workspacePath: join(run, 'home'), title: 'Deferred input after startup retry', config: { model: 'haiku', provider: 'anthropic' },
  });
  evidence.sessionId = sessionId;
  const agent = app.sessionManager.getCachedSession(sessionId)!;
  const build = agent.optionsBuilder.build.bind(agent.optionsBuilder);
  let breakFirstStream: (() => void) | undefined;
  agent.optionsBuilder.build = async (...args) => ({
    ...await build(...args),
    spawnClaudeCodeProcess: (opts) => {
      const number = ++attempt;
      const child = spawn(number === 1 && retryKind !== 'stall' ? process.execPath : opts.command,
        number === 1 && retryKind !== 'stall' ? ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'] : opts.args,
        { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal });
      child.stderr.on('data', (chunk) => appendFileSync(join(run, `sdk-${number}.stderr.log`), chunk));
      if (number === 1) breakFirstStream = () => child.stdout.destroy(new Error('stream closed'));
      const input = new PassThrough();
      let pending = '';
      input.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop()!;
        for (const line of lines) {
          const message = JSON.parse(line);
          inputs.push({ attempt: number, type: message.type, uuid: message.uuid });
        }
      });
      input.pipe(child.stdin);
      child.stdin.on('error', () => {});
      Object.defineProperty(child, 'stdin', { value: input });
      return child;
    },
  });
  const current = await hub.request<{ messageId: string }>('message.send', { sessionId, content: markers[0] });
  await until(() => inputs.some((input) => input.attempt === 1 && input.uuid === current.messageId), 'first SDK never received kickoff');
  evidence.deferredReceipt = await hub.request('message.send', { sessionId, content: markers[1], deliveryMode: 'defer' });
  await until(async () => (await hub.request<{ total: number }>('session.messages.byStatus', { sessionId, status: 'deferred' })).total === 1, 'follow-up was not deferred while busy');
  if (retryKind === 'transient') {
    assert(breakFirstStream);
    breakFirstStream();
    await until(async () => JSON.stringify(await hub.request('message.sdkMessages', { sessionId })).includes('The connection was interrupted. Retrying'), 'transient retry notice was not published');
  }
  if (retryKind === 'stall') await until(async () => JSON.stringify(await hub.request('message.sdkMessages', { sessionId })).includes('The model sent nothing'), 'stream-stall retry notice was not published');
  await until(() => inputs.some((input) => input.attempt === 2 && input.uuid === current.messageId), 'replacement SDK never received the retry input');
  await until(() => markers.every((marker) => requests.some((body) => body.includes(marker))), 'both inputs did not reach the mock model');
  const consumed = await hub.request<{ total: number }>('session.messages.byStatus', { sessionId, status: 'consumed' });
  const remaining = await hub.request<{ total: number }>('session.messages.byStatus', { sessionId, status: 'deferred' });
  assert.equal(consumed.total, 2);
  assert.equal(remaining.total, 0);
  evidence.counts = { consumed: consumed.total, deferred: remaining.total };
  evidence.pass = true;
  console.log(`PASS: replacement SDK received retry input; deferred follow-up reached the next turn. ${run}/evidence/deferred-retry.json`);
} finally {
  writeFileSync(join(run, 'evidence/deferred-retry.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await app.cleanup();
  proxy.closeAllConnections();
  await new Promise<void>((done) => proxy.close(() => done()));
  await mock.stop();
}
