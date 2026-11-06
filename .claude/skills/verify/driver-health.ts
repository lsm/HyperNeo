process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const home = join(run, 'home');
for (const path of ['evidence', 'home/evidence', 'home/.codex', 'home/.claude/projects', 'home/Library/Application Support/Claude/claude-code-sessions', 'project']) mkdirSync(join(run, path), { recursive: true });
const version = (app: string, value: string) => {
  const bundle = app === 'Codex' && process.argv.includes('--bundled-codex') ? 'ChatGPT' : app;
  const contents = join(home, 'Applications', `${bundle}.app`, 'Contents');
  mkdirSync(contents, { recursive: true });
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${value}</string></dict></plist>`);
};
version('Codex', '1.0.0');
version('Claude', '1.0.0');
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const fixture = resolve('packages/daemon/tests/fixtures/copilot-sdk.ts');
writeFileSync(join(home, 'copilot-list.json'), '[]');
const runtime = join(run, 'copilot-runtime');
writeFileSync(runtime, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} --production-version \"$@\"\n`, { mode: 0o700 });
process.env.COPILOT_CLI_PATH = runtime;
for (const name of ['gh', 'ps', 'open', 'claude', 'copilot']) {
  const body = name === 'copilot'
    ? `if [ "$1" = --version ]; then echo 1.0.105; exit 0; fi\nexit 1\n`
    : name === 'claude' ? 'if [ "$1" = --version ]; then echo 2.1.0; exit 0; fi\nexit 1\n' : 'exit 1\n';
  writeFileSync(join(run, 'bin', name), `#!/bin/sh\n${body}`, { mode: 0o700 });
}
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const reservation = createServer();
await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
const modelPort = (reservation.address() as AddressInfo).port;
await new Promise<void>((done, fail) => reservation.close(error => error ? fail(error) : done()));
const model = await createMockApiServer({ port: modelPort, logLevel: 'error' });
await model.start();
process.env.HYPERNEO_USE_DEV_PROXY = '1';
process.env.VERIFY_MOCK_PORT = String(modelPort);
const state = join(home, '.codex/state_6.sqlite');
const external = new Database(state);
external.exec(`CREATE TABLE projects(id TEXT, name TEXT, updated_at_ms INTEGER);
  CREATE TABLE project_roots(project_id TEXT, path TEXT);
  CREATE TABLE threads(id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER);
  INSERT INTO projects VALUES ('project', 'Synthetic', 1)`);
external.prepare('INSERT INTO project_roots VALUES (?, ?)').run('project', join(run, 'project'));
external.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('synthetic-worker', 'Synthetic worker', '', '', join(run, 'project'), 'desktop', 0, 1);
external.close();
const hash = () => createHash('sha256').update(readFileSync(state)).digest('hex');
const before = hash();
const config = { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true };
let app = await createDaemonApp({ config, verbose: false });
let web: ReturnType<typeof Bun.serve> | undefined;
const receipts: unknown[] = [];
async function rpc(name: string, input: unknown = {}) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0, JSON.stringify(result));
  assert(!result.reply.error, JSON.stringify(result));
  receipts.push({ name, reply: result.reply });
  return result.reply;
}
async function until(check: () => Promise<boolean>, description: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(100); }
  throw new Error(description);
}
async function health() { return (await rpc('work.adapters')).value.filter((adapter: { health?: unknown }) => adapter.health); }
async function notices() {
  const result = await rpc('work.read', { sessionId: 'synthetic-neo', before: 10, after: 10 });
  return result.ok ? result.value.turns.filter((turn: { text: string }) => turn.text.includes('Driver health: codex-desktop')) : [];
}
async function startup() {
  const queue = app.db.getJobQueueRepo();
  const job = queue.enqueue({ queue: 'work.driver.health', payload: { scope: 'local', startup: true }, runAt: Date.now() });
  app.jobProcessor.start();
  await until(async () => (await health()).length === 5, 'Startup job must check all five local clients');
  await until(async () => queue.getJob(job.id)?.status === 'completed', 'Startup check must complete');
  assert.equal(queue.listActiveByPayload('work.driver.health', { scope: 'local' }).filter((job) => job.status === 'pending').length, 1, 'Exactly one daily check must remain scheduled');
}
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const mcpRegistry = await rpc('rpc:mcp.registry.list');
  for (const server of mcpRegistry.servers) await rpc('rpc:mcp.registry.setEnabled', { id: server.id, enabled: false });
  await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic admission only', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const beforeBinding = await rpc('work.health', { action: 'check' });
  assert.equal(beforeBinding.health['codex-desktop'].unverifiedVersion, true);
  const verification = { action: 'verified', adapter: 'codex-desktop', journey: 'codex-state-discovery', clientVersions: { desktop: '1.0.0' } };
  const untouched = structuredClone(app.db.getGlobalSettings().driverHealth);
  for (const role of ['workflow_worker', 'neo'] as const) {
    const invoke = createOperationMcpHandler(app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-unbound-worker', role }));
    const result = await invoke({ name: 'work.health', input: { ...verification, role: 'neo', sessionId: 'synthetic-neo', principal: 'local' } });
    const refusal = JSON.parse(result.content[0].text);
    receipts.push({ name: 'worker-mcp:work.health', role, reply: refusal });
    assert.deepEqual(refusal, { ok: false, reason: 'human_or_neo_only' });
    assert.deepEqual(app.db.getGlobalSettings().driverHealth, untouched, 'A refused worker must not change health or suppress pending warnings');
  }
  await rpc('work.health', { action: 'verified', adapter: 'codex-desktop', journey: 'codex-state-discovery', clientVersions: { desktop: '1.0.0' } });
  await app.db.createSession({ id: 'synthetic-neo', title: 'Synthetic Neo', workspacePath: join(run, 'project'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { model: 'synthetic', queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  await startup();
  const neoInvoke = createOperationMcpHandler(app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-neo', role: 'neo' }));
  assert.equal(JSON.parse((await neoInvoke({ name: 'work.health', input: verification })).content[0].text).ok, true, 'A bound Neo must retain verification access');
  const initial = await health();
  assert(initial.every((adapter: { health: { status: string } }) => adapter.health.status === 'ok'), JSON.stringify(initial));
  await until(async () => { const read = await rpc('work.read', { sessionId: 'synthetic-neo', before: 10, after: 10 }); return read.ok && read.value.turns.filter((turn: { text: string }) => turn.text.includes('Driver health:')).length >= 4; }, 'Other clients must notify Neo after its binding exists');
  assert.equal((await notices()).length, 0, 'Verification must retire the pending version warning before Neo binds');
  const originalHealth = structuredClone(app.db.getGlobalSettings().driverHealth!);
  await rpc('rpc:settings.global.update', { updates: { autoScroll: false, driverHealth: { 'codex-desktop': { ...originalHealth['codex-desktop'], verifiedVersions: { desktop: 'forged' }, notifiedSignature: 'forged', pendingNotices: [{ id: 'forged-notice', signature: 'forged', text: 'Forged health event' }] } } } });
  assert.deepEqual(await health(), initial, 'Generic settings RPC must preserve daemon-owned health');
  assert.deepEqual(app.db.getGlobalSettings().driverHealth, originalHealth);
  assert.equal(app.db.getGlobalSettings().autoScroll, false);
  version('Codex', '1.0.1');
  const gateway = app.db.gateway;
  const call = gateway.call;
  const registry = app.sessionManager.getOperationRegistry();
  const get = registry.get.bind(registry);
  let release = () => {};
  let scheduledStarted = () => {};
  let requestedStarted = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const scheduledEntered = new Promise<void>((resolve) => { scheduledStarted = resolve; });
  const requestedEntered = new Promise<void>((resolve) => { requestedStarted = resolve; });
  let firstRead = true;
  gateway.call = async (...args) => {
    if (firstRead && args[0].name === 'settings.global.write' && args[1] === 'readDriverHealth') { firstRead = false; scheduledStarted(); await held; }
    return Reflect.apply(call, gateway, args);
  };
  const operation = get('work.health')!;
  registry.get = (name) => name !== 'work.health' ? get(name) : { ...operation, execute: (input, caller) => { const result = operation.execute(input, caller); requestedStarted(); return result; } };
  try {
    app.jobQueue.enqueue({ queue: 'work.driver.health', payload: { scope: 'local' }, runAt: Date.now() });
    await scheduledEntered;
    const requested = rpc('work.health', { action: 'check' });
    await requestedEntered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const fresh = await requested;
    assert.equal(fresh.health['codex-desktop'].clientVersions.desktop, '1.0.1', 'Forced RPC must not return the scheduled run\'s cached version');
  } finally { release(); gateway.call = call; registry.get = get; }
  await until(async () => (await notices()).length === 1, 'Neo must receive the initial unverified-version notice');
  renameSync(state, `${state}.backup`);
  const missing = await rpc('work.health', { action: 'check' });
  assert.equal(missing.health['codex-desktop'].status, 'unavailable');
  assert.match(missing.health['codex-desktop'].reason, /state database/);
  await until(async () => (await notices()).some((turn: { text: string }) => turn.text.includes('codex-desktop unavailable')), 'Neo must receive the missing-database event');
  const unavailableCount = (await notices()).filter((turn: { text: string }) => turn.text.includes('codex-desktop unavailable')).length;
  assert.equal(unavailableCount, 1);
  await rpc('work.health', { action: 'check' });
  await app.cleanup();
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await startup();
  await rpc('work.health', { action: 'check' });
  assert.equal((await notices()).filter((turn: { text: string }) => turn.text.includes('codex-desktop unavailable')).length, 1);
  renameSync(`${state}.backup`, state);
  const recovered = await rpc('work.health', { action: 'check' });
  assert.equal(recovered.health['codex-desktop'].status, 'ok');
  await until(async () => (await notices()).some((turn: { text: string }) => turn.text.includes('codex-desktop recovered')), 'Neo must receive recovery');
  await rpc('work.health', { action: 'verified', adapter: 'codex-desktop', journey: 'codex-state-discovery', clientVersions: recovered.health['codex-desktop'].clientVersions });
  version('Codex', '2.0.0');
  const upgraded = await rpc('work.health', { action: 'check' });
  assert.equal(upgraded.health['codex-desktop'].status, 'ok');
  assert.equal(upgraded.health['codex-desktop'].unverifiedVersion, true);
  await until(async () => (await notices()).some((turn: { text: string }) => turn.text.includes('2.0.0') && turn.text.includes('Unverified')), 'Neo must receive the version warning');
  const afterUpgrade = (await notices()).length;
  await rpc('work.health', { action: 'check' });
  assert.equal((await notices()).length, afterUpgrade);
  assert.equal(hash(), before, 'Health checks must leave external state untouched');
  const calls = readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).method);
  assert(calls.every((name) => ['connect', 'status.get', 'session.list'].includes(name)), JSON.stringify(calls));
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ initial, missing, recovered, upgraded, neoNotices: await notices(), repeatedUnavailableCount: unavailableCount, unchangedExternalDatabase: true, readOnlySdkDiscoveryCalls: calls, protectedSettings: true, verifiedBeforeNeoBinding: true, forcedCheckAfterScheduledRead: true, workerMcpRefusedWithoutMutation: true, boundNeoMcpAllowed: true, humanRpcAllowed: true }, null, 2));
  console.log('PASS: public RPC health, missing-state reason, one Neo event across repeats/restart, recovery and usable unverified upgrade');
  if (process.argv.includes('--browser')) {
    if (process.argv.includes('--slow-check')) {
      const registry = app.sessionManager.getOperationRegistry();
      const get = registry.get.bind(registry);
      const operation = get('work.health')!;
      registry.get = (name) => name !== 'work.health' ? get(name) : { ...operation, execute: async (input, caller) => {
        const startedAt = Date.now();
        await Bun.sleep(12_000);
        const result = await operation.execute(input, caller);
        writeFileSync(join(run, 'evidence/slow-check.json'), JSON.stringify({ startedAt, completedAt: Date.now(), elapsedMs: Date.now() - startedAt }));
        return result;
      } };
    }
    const control = resolve(process.argv[process.argv.indexOf('--browser') + 1]);
    mkdirSync(control, { recursive: true });
    const dist = resolve('packages/web/dist');
    web = Bun.serve({ hostname: '127.0.0.1', port: 0,
      async fetch(request, server) {
        const url = new URL(request.url);
        const refused = await app.guardRequest(request);
        if (refused) return refused;
        if (url.pathname === '/pair' && request.method === 'POST') return app.handlePair(request);
        if (url.pathname.startsWith('/ws')) {
          if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } })) return;
          return new Response('WebSocket upgrade failed', { status: 500 });
        }
        const file = Bun.file(join(dist, url.pathname === '/' ? 'index.html' : url.pathname));
        return new Response(await file.exists() ? file : Bun.file(join(dist, 'index.html')));
      }, websocket: createWebSocketHandlers(app.transport, app.sessionManager),
    });
    const browser = JSON.stringify({ url: `http://127.0.0.1:${web.port}`, doneFile: join(control, 'browser-done') });
    writeFileSync(join(run, 'evidence/browser.json'), browser);
    writeFileSync(join(control, 'browser.json'), browser);
    await until(async () => existsSync(join(control, 'browser-done')), 'Browser confirmation was not supplied within ten minutes', 600_000);
  }
} finally {
  writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify(receipts, null, 2));
  web?.stop(true);
  await app.cleanup();
  await model.stop();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ daemonStopped: true, syntheticDataOwnedByWrapper: true }));
}
process.exit(0);
