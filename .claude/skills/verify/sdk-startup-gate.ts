import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { getSdkStartupGate } from '../../../packages/daemon/src/lib/agent/sdk-startup-gate.ts';
import { getProviderService } from '../../../packages/daemon/src/lib/provider-service.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_USE_DEV_PROXY, '1');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) assert(!process.env[key], key);
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const gateLogs: unknown[] = [];
const unsubscribe = subscribeToStructuredLogs(event => {
  if (event.message.includes('SDK startup gate:')) gateLogs.push(event);
});
const evidence: Record<string, unknown> = { gateLogs, workers: [] };
const mock = await createMockApiServer({ port: 8000 });
await mock.start();
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
assert.notEqual(app.server.port, 8399);
evidence.port = app.server.port;
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const until = async (check: () => Promise<boolean> | boolean, label: string) => {
  const deadline = Date.now() + 60000;
  while (!(await check())) { assert(Date.now() < deadline, label); await new Promise(done => setTimeout(done, 50)); }
};
const service = getProviderService();
const original = service.resolveSessionProviderEnvVars.bind(service);
const blocked = new Set<string>();
const envCalls = new Map<string, number>();
let unblock = () => {};
const blockedUntilCleanup = new Promise<void>(done => { unblock = done; });
service.resolveSessionProviderEnvVars = async session => {
  const count = (envCalls.get(session.id) ?? 0) + 1;
  envCalls.set(session.id, count);
  if (blocked.has(session.id) && count > 1) await blockedUntilCleanup;
  return original(session);
};
try {
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Isolated mock', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const registry = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of registry.servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  for (let index = 0; index < 3; index++) {
    const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'home'), title: `Hung startup ${index}`, config: { model: 'haiku', provider: 'anthropic' } });
    (evidence.workers as unknown[]).push({ sessionId, phase: index < 2 ? 'provider_environment' : 'sdk_first_message' });
    if (index < 2) blocked.add(sessionId);
    else {
      const agent = await app.sessionManager.getSessionForControl(sessionId);
      assert(agent);
      const build = agent.optionsBuilder.build.bind(agent.optionsBuilder);
      agent.optionsBuilder.build = async (...args) => ({ ...await build(...args), spawnClaudeCodeProcess: opts => {
        const child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal });
        child.stderr.resume();
        return child;
      } });
    }
    await hub.request('message.send', { sessionId, content: 'Synthetic hung startup' });
    await until(() => getSdkStartupGate().getStats().active === index + 1, 'worker did not acquire startup permit');
  }
  const call = (name: string, input = {}) => hub.request<Record<string, unknown>>('operation.invoke', { name, input });
  await call('neo.preferences.set', { model: 'haiku', provider: 'anthropic', thinkingLevel: 'off' });
  const { sessionId } = await call('neo.open');
  assert(typeof sessionId === 'string');
  evidence.root = sessionId;
  const startedAt = Date.now();
  evidence.receipt = await call('neo.message.send', { sessionId, requestId: crypto.randomUUID(), content: 'Say STARTUP_GATE_RECOVERED.' });
  await until(() => getSdkStartupGate().getStats().queued === 1, 'root Neo did not queue behind workers');
  evidence.queued = getSdkStartupGate().getStats();
  await until(async () => {
    const result = await hub.request<{ sdkMessages: { type: string; is_error?: boolean }[] }>('message.sdkMessages', { sessionId });
    return result.sdkMessages.some(message => message.type === 'result' && message.is_error === false);
  }, 'root Neo never completed its enqueued input');
  evidence.elapsedMs = Date.now() - startedAt;
  assert(Number(evidence.elapsedMs) < 60000);
  evidence.pass = true;
  console.log(`PASS: root Neo completed queued input without a restart: ${run}/evidence/sdk-startup-gate.json`);
} finally {
  service.resolveSessionProviderEnvVars = original;
  await transport.close();
  const cleanup = app.cleanup();
  unblock();
  await cleanup;
  await mock.stop();
  unsubscribe();
  writeFileSync(join(run, 'evidence/sdk-startup-gate.json'), JSON.stringify(evidence, null, 2));
}
