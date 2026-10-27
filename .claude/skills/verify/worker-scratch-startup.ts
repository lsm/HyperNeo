import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { installClaudeNativeWrites } from '../../../packages/daemon/src/lib/drivers/claude-native-writes.ts';
import { workerSandboxPaths } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(process.env.VERIFY_CLAUDE?.startsWith('/'), 'Select the installed Claude CLI explicitly');
mkdirSync(join(run, 'evidence'), { recursive: true });
const observations: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC unavailable')); });
  const id = crypto.randomUUID();
  const registered = new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('provider RPC timed out')), 10000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done();
    };
  });
  ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'providers.create', data: { params: { providerId: 'anthropic', displayName: 'Synthetic', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-synthetic-loopback-only' } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  await registered;
  for (const enabled of [true, false]) {
    const root = join(run, enabled ? 'enabled' : 'disabled');
    mkdirSync(join(root, '.git/info'), { recursive: true });
    await installClaudeNativeWrites(root, [join(run, 'source')]);
    const policyPath = join(root, '.claude/settings.local.json');
    const persisted = JSON.parse(readFileSync(policyPath, 'utf8'));
    persisted.sandbox.enabled = enabled;
    writeFileSync(policyPath, JSON.stringify(persisted));
    const bytes = readFileSync(policyPath, 'utf8');
    const env = workerSandboxPaths(root);
    for (const path of [env.TMPDIR, env.XDG_CACHE_HOME]) {
      chmodSync(path, 0o755);
      writeFileSync(join(path, 'retained'), 'worker bytes');
    }
    const session = { id: crypto.randomUUID(), title: 'Scratch startup', workspacePath: root, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active' as const, config: { provider: 'anthropic', model: 'default', queryMode: 'manual' as const }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } };
    await app.db.createSession(session);
    const options = await new QueryOptionsBuilder({ session, db: app.db, settingsManager: app.settingsManager }).build();
    assert.equal(options.sandbox?.enabled, enabled);
    assert.equal(options.env?.TMPDIR, env.TMPDIR);
    const modes = [env.TMPDIR, env.XDG_CACHE_HOME].map(path => statSync(path).mode & 0o777);
    assert.deepEqual(modes, enabled ? [0o700, 0o700] : [0o755, 0o755]);
    if (!enabled) assert.equal(readFileSync(policyPath, 'utf8'), bytes, 'disabled policy must remain untouched');
    for (const path of [env.TMPDIR, env.XDG_CACHE_HOME]) assert.equal(readFileSync(join(path, 'retained'), 'utf8'), 'worker bytes');
    const nativeSettings = join(run, `native-${enabled}.json`);
    writeFileSync(nativeSettings, JSON.stringify({ ...persisted, sandbox: options.sandbox, env }));
    const probe = spawnSync('python3', [fileURLToPath(new URL('./worker-cli-probe.py', import.meta.url)), process.env.VERIFY_CLAUDE!, nativeSettings, root, `printf worker-started; printf retained > '${root}/native-started'`], { encoding: 'utf8', timeout: 180000, env: { ...process.env, ...Object.fromEntries(Object.entries(env).map(([key, value]) => [`EXP_${key}`, value])) } });
    writeFileSync(join(run, `evidence/native-${enabled}.log`), probe.stdout + probe.stderr);
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    assert(probe.stdout.includes('TOOL_RESULT: worker-started'), probe.stdout);
    assert(existsSync(join(root, 'native-started')));
    observations.push({ enabled, modes, retained: true, nativeShellStarted: true, disabledPolicyUntouched: !enabled });
  }
  console.log('PASS enabled scratch repaired; disabled scratch untouched; both native shells execute');
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observations, null, 2));
}
