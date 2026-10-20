import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { startDaemonLagDiagnostics } from '../../../packages/daemon/src/lib/event-loop-lag.ts';

const [portText, runText] = process.argv.slice(2);
const port = Number(portText);
assert(port > 0 && port !== 8399 && runText);
const run = resolve(runText);
assert(process.env.NODE_ENV === 'test');
assert(process.env.HOME === join(run, 'home'));
assert(process.env.HYPERNEO_DATA_DIR === join(run, 'data'));
const db = join(run, 'data/daemon.db');
assert(!existsSync(db));
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'home'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: db }), verbose: false });
const stop = startDaemonLagDiagnostics(app.messageHub, () => {});
const payload = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ i, text: 'synthetic'.repeat(20) })));
app.messageHub.onRequest('verify.profile-work', () => {
  let bytes = 0;
  for (let i = 0; i < 8; i++) bytes += JSON.stringify(JSON.parse(payload)).length;
  return { bytes };
});
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
try {
  await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('connect failed')); });
  const call = () => new Promise<number>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timeout')), 10_000);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.requestId !== id) return;
      clearTimeout(timer);
      assert.equal(message.data.bytes, payload.length * 8);
      done(message.data.bytes);
    };
    ws.send(JSON.stringify({ id, type: 'REQ', method: 'verify.profile-work', data: {}, sessionId: 'global', timestamp: new Date().toISOString() }));
  });
  for (let i = 0; i < 1000; i++) await call();
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  const latencies: number[] = [];
  for (let i = 0; i < 12000; i++) {
    const at = performance.now();
    await call();
    latencies.push(performance.now() - at);
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  latencies.sort((a, b) => a - b);
  const report = { runtime: Bun.version, profile: process.env.HYPERNEO_LAG_PROFILE === '1', requests: 12000, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, rpcP50Ms: latencies[6000], rpcP95Ms: latencies[11400], syntheticOnly: true };
  writeFileSync(join(run, 'overhead.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report)+'\n');
} finally {
  ws.close();
  stop();
  await app.cleanup();
}
