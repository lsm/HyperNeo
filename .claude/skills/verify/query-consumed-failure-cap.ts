import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Session } from '@hyperneo/shared';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS = '400';
process.env.HYPERNEO_TEST_DISABLE_SANDBOX = '1';
const starts: number[] = [];
const children: ChildProcess[] = [];
const { QueryOptionsBuilder } = await import('../../../packages/daemon/src/lib/agent/query-options-builder.ts');
const build = QueryOptionsBuilder.prototype.build;
QueryOptionsBuilder.prototype.build = async function (...args) {
  const options = await build.apply(this, args);
  return {
    ...options,
    spawnClaudeCodeProcess: (opts) => {
      starts.push(Date.now());
      const child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(() => {}, 1000);'], {
        cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal,
      });
      children.push(child);
      return child;
    },
  };
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP disabled'); }) as typeof fetch;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const app = await createDaemonApp({ config: {
  ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
  disableWorktrees: true, disableGoalProcessing: true,
}, verbose: false });
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const errors: { sessionId: string; error: string; details?: unknown }[] = [];
const stopErrors = app.internalEventBus.subscribe('session.error', event => { errors.push(event); }, { subscriberName: 'consumed-failure-proof' });
const evidence: Record<string, unknown> = { passed: false, nativeSdkTransport: true, syntheticOnly: true, mode };
const until = async (check: () => boolean | Promise<boolean>, label: string, ms = 15000) => {
  const end = Date.now() + ms;
  while (!await check()) {
    assert(Date.now() < end, label);
    await new Promise(done => setTimeout(done, 25));
  }
};
try {
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic only', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'synthetic-never-sent' } });
  const registry = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of registry.servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic native consumed failure', config: { model: 'haiku', provider: 'anthropic' } });
  const agent = app.sessionManager.getSession(sessionId)!;
  await app.db.updateSession(sessionId, { metadata: { ...agent.session.metadata, titleGenerated: true, titleSetBy: 'user' } });
  agent.session.metadata.titleGenerated = true;
  agent.session.metadata.titleSetBy = 'user';
  const read = async () => (await hub.request<{ session: Session }>('session.get', { sessionId })).session;
  if (mode === 'health') {
    const { ErrorCategory } = await import('../../../packages/daemon/src/lib/error-manager.ts');
    await agent.errorManager.handleError(sessionId, new Error('Synthetic prior timeout'), ErrorCategory.TIMEOUT);
  }
  await hub.request('message.send', { sessionId, content: 'Synthetic consumed prompt must reach the shared cap' });
  try {
    if (mode === 'interrupt' || mode === 'reset') {
      await until(async () => (await read()).metadata.queryFailureEpisode?.failures === 2, 'Second consumed failure missing');
      const before = starts.length;
      const prior = (await read()).metadata.queryFailureEpisode!;
      await hub.request(mode === 'interrupt' ? 'client.interrupt' : 'session.resetQuery', { sessionId, restartQuery: false });
      await new Promise(done => setTimeout(done, 2700));
      assert.equal(starts.length, before);
      const current = (await read()).metadata.queryFailureEpisode!;
      if (mode === 'reset') { assert.notEqual(current.id, prior.id); assert.equal(current.failures, 0); }
      assert.equal(current.failed, false);
      evidence.passed = true;
    } else {
    await until(async () => (await read()).metadata.queryFailureEpisode?.failed === true, 'Consumed prompt stopped below the shared cap');
    await until(() => errors.some(event => event.error.includes('Query stopped after 3 failures')), 'Terminal failure not published');
    const episode = (await read()).metadata.queryFailureEpisode!;
    assert.equal(episode.failures, 3);
    assert(episode.error.includes('SDK startup timeout'));
    assert.equal(starts.length, 3);
    assert(starts[1] - starts[0] >= 950);
    assert(starts[2] - starts[1] >= 1950);
    const messages = await hub.request<{ sdkMessages: { type: string; deliveryStatus?: string }[] }>('message.sdkMessages', { sessionId });
    assert(messages.sdkMessages.some(message => message.type === 'user' && message.deliveryStatus === 'delivered'));
    evidence.delivered = true;
    if (mode === 'health') {
      const terminal = errors.find(event => event.error.includes('Query stopped after 3 failures'))!;
      assert.equal((terminal.details as { category: string }).category, 'timeout');
      let health: { system: { apiConnection: { status: string; errorCount: number } } } | undefined;
      await until(async () => { health = await hub.request('state.global.snapshot', { includeSessions: false }); return health!.system.apiConnection.status === 'degraded'; }, 'capped timeout did not update public API health');
      assert.equal(health!.system.apiConnection.errorCount, 2);
      evidence.apiHealth = health!.system.apiConnection;
    }

    await new Promise(done => setTimeout(done, 2300));
    assert.equal(starts.length, 3);
    evidence.passed = true;
    }
  } finally {
    evidence.starts = starts;
    evidence.episode = (await read()).metadata.queryFailureEpisode;
    evidence.messages = await hub.request('message.sdkMessages', { sessionId });
    evidence.errors = errors;
  }
} finally {
  stopErrors();
  await transport.close();
  await app.cleanup();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(done => child.once('exit', () => done()))));
  QueryOptionsBuilder.prototype.build = build;
  globalThis.fetch = originalFetch;
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/query-consumed-failure-cap.json'), JSON.stringify(evidence, null, 2).replaceAll(run, '<synthetic-run>'));
}
console.log(JSON.stringify(evidence).replaceAll(run, '<synthetic-run>'));
