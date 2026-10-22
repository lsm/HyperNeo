import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { resolveNeoEntry } from '../../../packages/shared/src/web-entry.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';

const run = resolve(process.argv[2]);
const scenario = process.argv[3];
assert(['recover', 'fail'].includes(scenario));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.HYPERNEO_USE_DEV_PROXY, '1');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['evidence', 'bin']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const mock = await createMockApiServer({ port: 8001 });
await mock.start();
const evidence: Record<string, unknown> = { scenario, requests: 0, processes: [], responses: [], errors: [] };
const proxy = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  if (req.url?.includes('/messages') && !req.url.includes('count_tokens') && body.includes('CLAUDE_LOGIN_RECOVERED')) {
    evidence.requests = Number(evidence.requests) + 1;
    if (scenario === 'fail' || (evidence.processes as unknown[]).length === 1) {
      (evidence.responses as unknown[]).push({ process: (evidence.processes as unknown[]).length, status: 401 });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth token revoked' } }));
      return;
    }
  }
  const upstream = await fetch(mock.serverUrl + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, ...(req.method !== 'GET' ? { body } : {}) });
  if (req.url?.includes('/messages') && body.includes('CLAUDE_LOGIN_RECOVERED')) (evidence.responses as unknown[]).push({ process: (evidence.processes as unknown[]).length, status: upstream.status });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
  res.end();
});
await new Promise<void>(done => proxy.listen(8000, '127.0.0.1', done));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
let web: ReturnType<typeof Bun.serve> | undefined;
const until = async (check: () => Promise<boolean> | boolean, label: string, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (!(await check())) { assert(Date.now() < deadline, label); await new Promise(done => setTimeout(done, 100)); }
};
try {
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic model', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const registry = await hub.request<{ servers: Array<{ id: string }> }>('mcp.registry.list', {});
  for (const server of registry.servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const call = (name: string, input = {}) => hub.request<Record<string, unknown>>('operation.invoke', { name, input });
  await call('neo.preferences.set', { model: 'haiku', provider: 'anthropic', thinkingLevel: 'off' });
  const { sessionId } = scenario === 'fail' ? await call('neo.open') : await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'home'), title: 'Claude login recovery proof', config: { model: 'haiku', provider: 'anthropic' } });
  assert(typeof sessionId === 'string');
  evidence.sessionId = sessionId; evidence.port = app.server.port;
  const agent = await app.sessionManager.getSessionForControl(sessionId); assert(agent);
  const build = agent.optionsBuilder.build.bind(agent.optionsBuilder);
  agent.optionsBuilder.build = async (...args) => ({ ...await build(...args), spawnClaudeCodeProcess: opts => {
    const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe','pipe','pipe'], signal: opts.signal });
    (evidence.processes as unknown[]).push(child.pid);
    child.stderr.resume();
    return child;
  } });
  app.internalEventBus.subscribe('session.error', event => { if (event.sessionId === sessionId) (evidence.errors as unknown[]).push(event.error); }, { subscriberName: 'login-proof', sessionId });
  await hub.request('message.send', { sessionId, content: 'Say CLAUDE_LOGIN_RECOVERED.' });
  await until(() => Number(evidence.requests) >= 2, '401 did not restart the SDK and retry');
  if (scenario === 'fail') {
    await until(() => (evidence.errors as string[]).includes('Claude login failed — sign in again'), 'terminal authentication notice missing');
    assert.equal((evidence.processes as unknown[]).length, 2);
  } else {
    await until(async () => {
      const data = await hub.request('message.sdkMessages', { sessionId });
      evidence.messages = data;
      return (data as { sdkMessages: Array<{ type: string; is_error?: boolean }> }).sdkMessages.some(m => m.type === 'result' && m.is_error === false);
    }, 'replacement SDK did not complete the original prompt');
    assert.equal((evidence.errors as unknown[]).length, 0);
  }
  assert.equal((evidence.processes as unknown[]).length, 2);
  if (process.argv.includes('--serve')) {
    const root = resolve('packages/web/dist');
    web = Bun.serve({ hostname: '127.0.0.1', port: 0, websocket: createWebSocketHandlers(app.transport, app.sessionManager), async fetch(req, server) {
      const path = new URL(req.url).pathname;
      app.observeRequest(req);
      if (path.startsWith('/ws')) {
        if (server.upgrade(req, { data: { connectionSessionId: 'global', device: app.authenticateUpgrade(req, server.requestIP(req)?.address ?? null) } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      const file = resolve(root, '.' + path);
      if (file.startsWith(root + '/') && await Bun.file(file).exists()) return new Response(Bun.file(file));
      const neo = resolveNeoEntry(new URL(req.url));
      if (neo?.kind === 'redirect') return Response.redirect(new URL(neo.location, req.url));
      return new Response(Bun.file(`${root}${neo?.kind === 'entry' ? neo.path : '/index.html'}`));
    } });
    evidence.port = web.port;
    assert.notEqual(web.port, 8399);
  }
  evidence.pass = true;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS ${scenario}: ${run}/evidence/observed.json`);
  if (process.argv.includes('--serve')) await until(() => existsSync(join(run, 'browser-done')), 'browser proof not finished in 5 minutes', 300000);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  web?.stop(true);
  await transport.close(); await app.cleanup();
  proxy.closeAllConnections(); await new Promise<void>(done => proxy.close(() => done())); await mock.stop();
}
