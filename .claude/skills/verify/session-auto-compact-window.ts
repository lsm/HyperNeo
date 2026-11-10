import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { KimiProvider } from '../../../packages/daemon/src/lib/providers/kimi-provider.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { releaseSessionKeyBridges } from '../../../packages/daemon/src/lib/providers/provider-key-bridge.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const name of ['workspace', 'bin', 'evidence', 'sdk'])
  mkdirSync(join(run, name), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.CLAUDE_CONFIG_DIR = join(run, 'sdk');
process.env.TEST_SDK_SESSION_DIR = join(run, 'sdk');
const model = KimiProvider.MODELS.find((entry) => entry.contextWindow >= 1_000_000)!;
assert(model);
const providerWindow = KimiProvider.resolveContextWindow(model.id);
const fixture = createServer(async (request, response) => {
  for await (const _chunk of request) {
  }
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify(
      request.url?.includes('count_tokens')
        ? { input_tokens: 1000 }
        : {
            data: [{ id: model.id, object: 'model' }],
          }
    )
  );
});
await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
const fixturePort = (fixture.address() as { port: number }).port;
assert(![8399, 8499].includes(fixturePort));
const endpoint = `http://127.0.0.1:${fixturePort}`;
const builds = new Map<
  string,
  { window?: number | 'auto'; providerEnv?: string; childEnv?: string }
>();
const originalBuild = QueryOptionsBuilder.prototype.build;
QueryOptionsBuilder.prototype.build = async function (...args) {
  const options = await originalBuild.apply(this, args);
  const id = options.env?.HYPERNEO_SESSION_ID!;
  const observed = {
    window: options.settings?.autoCompactWindow,
    providerEnv: options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    childEnv: undefined as string | undefined,
  };
  builds.set(id, observed);
  return {
    ...options,
    spawnClaudeCodeProcess: (child) => {
      observed.childEnv = child.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      return spawn(child.command, child.args, {
        cwd: child.cwd,
        env: child.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: child.signal,
      });
    },
  };
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = {};
const sessionIds: string[] = [];
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({
        port: 0,
        host: '127.0.0.1',
        dbPath: join(run, 'data/daemon.db'),
        workspaceRoot: join(run, 'workspace'),
      }),
      disableWorktrees: true,
    },
    verbose: false,
  });
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({
    createSocket: createLocalSocket,
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
  });
  hub.registerTransport(transport);
  await transport.initialize();
  const registry = await hub.request<{ servers: { id: string; enabled: boolean }[] }>(
    'mcp.registry.list',
    {}
  );
  for (const server of registry.servers)
    if (server.enabled)
      await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const providers = getProviderRegistry();
  providers.unregister('kimi');
  providers.register(
    new KimiProvider(
      { KIMI_BASE_URL: endpoint, KIMI_API_KEY: 'synthetic-loopback-only' },
      undefined,
      async () => new Response(JSON.stringify({ data: [{ id: model.id }] }))
    )
  );
  setModelsCache(new Map([['global', [model]]]));
  for (const window of [450_000, undefined]) {
    const created = await hub.request<{ sessionId: string }>('session.create', {
      title: 'Synthetic session window',
      workspacePath: join(run, 'workspace'),
      config: {
        provider: 'kimi',
        model: model.id,
        ...(window === undefined ? {} : { autoCompactWindow: window }),
      },
    });
    const live = await app.sessionManager.getSessionForControl(created.sessionId);
    sessionIds.push(created.sessionId);
    assert(live);
    await live.ensureQueryStarted();
    const deadline = Date.now() + 60_000;
    while ((!builds.has(created.sessionId) || !live.queryObject) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
    }
    const observed = builds.get(created.sessionId);
    const context = await live.queryObject?.getContextUsage();
    evidence[window === undefined ? 'inherited' : 'explicit'] = {
      persistedWindow: live.getSessionData().config['autoCompactWindow'],
      ...observed,
      context: context && {
        maxTokens: context.maxTokens,
        autoCompactThreshold: context.autoCompactThreshold,
        autocompactSource: context.autocompactSource,
        isAutoCompactEnabled: context.isAutoCompactEnabled,
      },
    };
    assert(observed);
    assert.equal(observed.window, window ?? providerWindow);
    assert.equal(observed.providerEnv, undefined);
    assert.equal(observed.childEnv, window === undefined ? String(providerWindow) : undefined);
    assert.equal(live.getSessionData().config['autoCompactWindow'], window);
    assert(context);
    assert.equal(context.autocompactSource === 'env', window === undefined);
  }
  const explicit = evidence.explicit as { context: { autoCompactThreshold: number } };
  const inherited = evidence.inherited as { context: { autoCompactThreshold: number } };
  assert(explicit.context.autoCompactThreshold < inherited.context.autoCompactThreshold);
  evidence.passed = true;
} finally {
  transport?.close();
  await app?.cleanup();
  for (const sessionId of sessionIds) releaseSessionKeyBridges(sessionId);
  QueryOptionsBuilder.prototype.build = originalBuild;
  fixture.closeAllConnections();
  await new Promise<void>((done) => fixture.close(() => done()));
  evidence.resourcesClosed = true;
  writeFileSync(
    join(run, 'evidence/session-auto-compact-window.json'),
    JSON.stringify(evidence, null, 2)
  );
}
console.log('PASS persisted session window reaches SDK settings and child environment');
