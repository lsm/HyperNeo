import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { startDaemonLagDiagnostics } from '../../../packages/daemon/src/lib/event-loop-lag.ts';
import { delayedSettings } from '../../../packages/daemon/tests/helpers/delayed-settings.ts';

const [mode, portText, runText, source = 'workspace'] = process.argv.slice(2);
const port = Number(portText);
assert(['reproduce', 'verify'].includes(mode));
assert(port > 0 && port !== 8399 && runText);
assert(['workspace', 'user'].includes(source));
const run = resolve(runText);
assert(process.env.NODE_ENV === 'test');
assert(process.env.HOME === join(run, 'home'));
assert(process.env.HYPERNEO_DATA_DIR === join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath), 'requires a new synthetic database');
const workspace = join(run, 'workspace');
const userSettings = join(run, 'home/.claude');
for (const dir of [join(run, 'data'), join(workspace, '.claude'), userSettings])
  mkdirSync(dir, { recursive: true });
process.env.HYPERNEO_WORKSPACE_PATH = workspace;
process.env.TEST_USER_SETTINGS_DIR = userSettings;
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath }),
  verbose: false,
});
const warnings: string[] = [];
const stop = startDaemonLagDiagnostics(app.messageHub, (line) => warnings.push(line));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let maxLagMs = 0;
let previous = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  maxLagMs = Math.max(maxLagMs, now - previous - 10);
  previous = now;
}, 10);
const pending = new Map<string, (data: unknown) => void>();
const rpc = (method: string) =>
  new Promise<{ data: unknown; ms: number }>((done, fail) => {
    const id = crypto.randomUUID();
    const started = performance.now();
    const timeout = setTimeout(() => fail(new Error(`${method} timed out`)), 10_000);
    pending.set(id, (data) => {
      clearTimeout(timeout);
      done({ data, ms: performance.now() - started });
    });
    ws.send(
      JSON.stringify({
        id,
        type: 'REQ',
        method,
        data: {},
        sessionId: 'global',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      })
    );
  });
ws.onmessage = (event) => {
  const message = JSON.parse(event.data.toString());
  const request = pending.get(message.requestId);
  if (!request) return;
  pending.delete(message.requestId);
  request(message.data);
};
let writer: Awaited<ReturnType<typeof delayedSettings>> | undefined;
try {
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = fail;
  });
  app.messageHub.onRequest('verify.settings', async () => {
    await app.settingsManager.prepareSDKOptions();
    return { prepared: true };
  });
  writer = await delayedSettings(
    source === 'workspace'
      ? join(workspace, '.claude/settings.local.json')
      : join(userSettings, 'settings.json'),
    join(run, 'home'),
    1400
  );
  await new Promise((done) => setTimeout(done, 300));
  maxLagMs = 0;
  const prepare = rpc('verify.settings');
  const health = await rpc('system.health');
  const result = await prepare;
  const [code] = await writer.done;
  assert.equal(code, 0);
  assert.deepEqual(result.data, { prepared: true });
  assert.equal((health.data as { status: string }).status, 'ok');
  await new Promise((done) => setTimeout(done, 300));
  const report = {
    source,
    prepare: result,
    health,
    maxLagMs,
    warnings,
    historical1748Attribution: 'unproven',
  };
  writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (mode === 'verify') {
    assert(maxLagMs < 1000, 'settings I/O must not block the main thread for 1 s');
    assert(health.ms < 250, 'health must remain responsive during settings I/O');
  } else assert(maxLagMs >= 1000, 'baseline must reproduce a settings main-thread block');
} finally {
  clearInterval(heartbeat);
  stop();
  ws.close();
  await writer?.stop();
  await app.cleanup();
}
