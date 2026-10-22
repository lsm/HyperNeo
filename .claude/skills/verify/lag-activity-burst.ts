import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { runLagPhase } from '../../../packages/daemon/src/lib/event-loop-activity.ts';
import { startDaemonLagDiagnostics } from '../../../packages/daemon/src/lib/event-loop-lag.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';

const run = resolve(process.argv[2] ?? '');
assert(process.argv[2] && process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')), 'fresh synthetic database required');
mkdirSync(join(run, 'home'), { recursive: true });
mkdirSync(join(run, 'data'), { recursive: true });
const app = await createDaemonApp({
  config: getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const reports: Record<string, unknown>[] = [];
const unsubscribe = subscribeToStructuredLogs((event) => {
  if (event.message === 'event_loop.lag_activity') reports.push(event.metadata);
});
const stop = startDaemonLagDiagnostics(app.messageHub, () => {});
let ws: WebSocket | undefined;
try {
  await new Promise((done) => setTimeout(done, 300));
  app.messageHub.onRequest('verify.activityBurst', () => {
    runLagPhase('scanner:synthetic:blocked', () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1350);
    });
    for (let i = 0; i < 122; i++) runLagPhase('scanner:worktree:metadata', () => {});
    return { accepted: true };
  });
  assert(app.server && app.server.port !== 8399);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  const id = crypto.randomUUID();
  const reply = await new Promise<unknown>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('RPC timeout')), 10_000);
    ws!.onopen = () => ws!.send(JSON.stringify({
      id, type: 'REQ', method: 'verify.activityBurst',
      data: { text: 'PRIVATE_SYNTHETIC_BODY' }, sessionId: 'global',
      version: '1.0.0', timestamp: new Date().toISOString(),
    }));
    ws!.onmessage = (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.requestId !== id) return;
      clearTimeout(timeout);
      done(message.data);
    };
    ws!.onerror = () => {
      clearTimeout(timeout);
      fail(new Error('WebSocket failed'));
    };
  });
  assert.deepEqual(reply, { accepted: true });
  await new Promise((done) => setTimeout(done, 300));
  const report = reports.find((entry) => Number(entry.lagMs) >= 1000);
  assert(report, 'blocked RPC must emit diagnostic');
  writeFileSync(join(run, 'observed.json'), JSON.stringify({
    surface: 'isolated daemon WebSocket RPC and production diagnostic attachment',
    modeledWaitMs: 1350, syntheticOnly: true, runtime: process.versions, report,
  }, null, 2));
  const entries = report.activities as { name: string; kind: string; durationMs?: number }[];
  assert(entries.some((entry) => entry.name === 'scanner:synthetic:blocked'
    && entry.kind === 'end' && Number(entry.durationMs) >= 1000),
  'early blocking phase must survive the later metadata burst');
  assert.equal(report.droppedActivities, 0, 'recorded live burst size must fit');
  assert(!JSON.stringify(report).includes('PRIVATE_SYNTHETIC_BODY'));
  process.stdout.write(`Retained early blocking phase: ${join(run, 'observed.json')}\n`);
} finally {
  ws?.close();
  stop();
  unsubscribe();
  await app.cleanup();
}
