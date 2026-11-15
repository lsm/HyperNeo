import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.HYPERNEO_USE_DEV_PROXY, '1');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert(!process.env[key]);
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['evidence', 'bin']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;

const MARKER = 'USAGE_LIMIT_RECOVERED';
const mock = await createMockApiServer({ port: 8001 });
await mock.start();
const evidence: Record<string, unknown> = { limited: 0, answered: 0, errors: [] };
let limited = true;
const proxy = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  const turn = req.url?.includes('/messages') && !req.url.includes('count_tokens') && body.includes(MARKER);
  if (turn && limited) {
    evidence.limited = Number(evidence.limited) + 1;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'You have hit your usage limit. Your limit will reset in 1 minutes.' } }));
    return;
  }
  if (turn) evidence.answered = Number(evidence.answered) + 1;
  const upstream = await fetch(mock.serverUrl + req.url, {
    method: req.method,
    headers: { 'content-type': 'application/json' },
    ...(req.method !== 'GET' ? { body } : {}),
  });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
  res.end();
});
await new Promise<void>((done) => proxy.listen(8000, '127.0.0.1', done));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  createSocket: createLocalSocket,
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
});
hub.registerTransport(transport);
const until = async (check: () => Promise<boolean> | boolean, label: string, timeout: number) => {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 250));
  }
};
try {
  await transport.initialize();
  await hub.request('providers.create', {
    params: { providerId: 'anthropic', displayName: 'Synthetic model', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 },
    credentials: { apiKey: 'sk-devproxy-test-key' },
  });
  const registry = await hub.request<{ servers: Array<{ id: string }> }>('mcp.registry.list', {});
  for (const server of registry.servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'home'),
    title: 'Usage limit result resume proof',
    config: { model: 'haiku', provider: 'anthropic' },
  });
  evidence.sessionId = sessionId;
  const agent = await app.sessionManager.getSessionForControl(sessionId);
  assert(agent);
  const build = agent.optionsBuilder.build.bind(agent.optionsBuilder);
  agent.optionsBuilder.build = async (...args) => ({
    ...(await build(...args)),
    spawnClaudeCodeProcess: (opts) => {
      evidence.processes = Number(evidence.processes ?? 0) + 1;
      const child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: { ...opts.env, CLAUDE_CODE_MAX_RETRIES: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: opts.signal,
      });
      child.stderr.resume();
      return child;
    },
  });
  app.internalEventBus.subscribe(
    'session.error',
    (event) => {
      if (event.sessionId === sessionId) (evidence.errors as unknown[]).push(event.error);
    },
    { subscriberName: 'limit-resume-proof', sessionId }
  );
  const session = async () =>
    (await hub.request<{ session: { processingState?: string; metadata?: { queryFailureEpisode?: unknown } } }>('session.get', { sessionId })).session;
  const state = async () => {
    const raw = (await session()).processingState;
    return raw ? (JSON.parse(raw) as { status: string; reason?: string; retryAt?: number }) : { status: 'idle' };
  };

  const sentAt = Date.now();
  await hub.request('message.send', { sessionId, content: `Say ${MARKER}.` });
  await until(async () => (await state()).status === 'rate_limit_cooldown', 'the 429 result did not reach the limit hold', 120_000);
  const held = await state();
  const heldAt = Date.now();
  evidence.hold = held;
  evidence.secondsToHold = Math.round((heldAt - sentAt) / 1000);
  evidence.episodeAtHold = (await session()).metadata?.queryFailureEpisode ?? null;
  const ahead = Number(held.retryAt) - heldAt;
  evidence.retryInSeconds = Math.round(ahead / 1000);
  assert(ahead > 0 && ahead <= 15 * 60_000, `retryAt ${ahead}ms ahead`);
  assert.notEqual((evidence.episodeAtHold as { failed?: boolean } | null)?.failed, true);
  assert.equal((evidence.errors as unknown[]).length, 0);

  limited = false;
  await until(
    async () => {
      const data = await hub.request<{ sdkMessages: Array<{ type: string; is_error?: boolean }> }>('message.sdkMessages', { sessionId });
      return data.sdkMessages.some((m) => m.type === 'result' && m.is_error === false);
    },
    'the held turn did not resume and answer',
    ahead + 3 * 60_000
  );
  evidence.secondsHeld = Math.round((Date.now() - heldAt) / 1000);
  evidence.finalState = await state();
  evidence.episodeAtEnd = (await session()).metadata?.queryFailureEpisode ?? null;
  assert(Number(evidence.answered) >= 1);
  assert.equal((evidence.errors as unknown[]).length, 0);
  evidence.pass = true;
  console.log(`PASS: ${run}/evidence/observed.json`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await app.cleanup();
  proxy.closeAllConnections();
  await new Promise<void>((done) => proxy.close(() => done()));
  await mock.stop();
}
