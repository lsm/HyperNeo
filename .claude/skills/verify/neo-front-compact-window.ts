import assert from 'node:assert/strict';
import spawn from 'node:child_process';
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
for (const name of ['home', 'workspace', 'bin', 'evidence', 'sdk'])
  mkdirSync(join(run, name), { recursive: true });
process.env.HOME = join(run, 'home');
process.env.CLAUDE_CONFIG_DIR = join(run, 'sdk');
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
const model = KimiProvider.MODELS.find((entry) => entry.contextWindow >= 1_000_000)!;
const providerWindow = KimiProvider.resolveContextWindow(model.id);
const fixture = createServer(async (request, response) => {
  for await (const _chunk of request) {
  }
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify(
      request.url?.includes('count_tokens')
        ? { input_tokens: 1000 }
        : { data: [{ id: model.id, object: 'model' }] }
    )
  );
});
await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const builds = new Map<
  string,
  { window?: number; providerEnv?: string; childEnv?: string; percentEnv?: string }
>();
const originalBuild = QueryOptionsBuilder.prototype.build;
QueryOptionsBuilder.prototype.build = async function (...args) {
  const options = await originalBuild.apply(this, args);
  const id = options.env?.HYPERNEO_SESSION_ID!;
  const observed = {
    window: (options.settings as { autoCompactWindow?: number } | undefined)?.autoCompactWindow,
    providerEnv: options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    percentEnv: options.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
    childEnv: undefined as string | undefined,
  };
  builds.set(id, observed);
  return {
    ...options,
    spawnClaudeCodeProcess: (child: {
      command: string;
      args: string[];
      cwd?: string;
      env: Record<string, string>;
      signal?: AbortSignal;
    }) => {
      observed.childEnv = child.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      return (spawn as unknown as typeof import('node:child_process')).spawn(
        child.command,
        child.args,
        {
          cwd: child.cwd,
          env: child.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: child.signal,
        }
      );
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
  transport = new WebSocketClientTransport({
    createSocket: createLocalSocket,
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
  });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  hub.registerTransport(transport);
  await transport.initialize();
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
  for (const [label, config] of [
    ['inherited', {}],
    ['seventy', { autoCompactPercent: 70 }],
    ['twentyfive', { autoCompactPercent: 25 }],
  ] as const) {
    const created = await hub.request<{ sessionId: string }>('session.create', {
      title: `Front window ${label}`,
      workspacePath: join(run, 'workspace'),
      config: { provider: 'kimi', model: model.id, ...config },
    });
    sessionIds.push(created.sessionId);
    const live = await app.sessionManager.getSessionForControl(created.sessionId);
    assert(live);
    await live.ensureQueryStarted();
    const deadline = Date.now() + 60_000;
    while ((!builds.has(created.sessionId) || !live.queryObject) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 100));
    const observed = builds.get(created.sessionId);
    assert(observed, `${label} never built query options`);
    const context = await live.queryObject?.getContextUsage();
    evidence[label] = {
      percent: 'autoCompactPercent' in config ? config.autoCompactPercent : null,
      providerWindow,
      ...observed,
      context: context && {
        maxTokens: context.maxTokens,
        autoCompactThreshold: context.autoCompactThreshold,
        isAutoCompactEnabled: context.isAutoCompactEnabled,
      },
    };
    if (!('autoCompactPercent' in config)) {
      assert.equal(observed.window, providerWindow);
      assert.equal(observed.childEnv, String(providerWindow));
    } else {
      const expected = Math.floor(
        (providerWindow * (config as { autoCompactPercent: number }).autoCompactPercent) / 100
      );
      assert.equal(observed.window, expected, `${label} window`);
      assert.equal(observed.percentEnv, undefined, `${label} sends the window, not the percentage again`);
      assert(context, `${label} returned no context usage`);
      assert.equal(context.isAutoCompactEnabled, true);
      assert.equal(context.maxTokens, expected, `${label} effective window`);
    }
  }
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
    join(run, 'evidence/neo-front-compact-window.json'),
    JSON.stringify(evidence, null, 2)
  );
}
