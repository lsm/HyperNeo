import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { startDaemonLagDiagnostics } from '../../../packages/daemon/src/lib/event-loop-lag.ts';
import { runLagPhase } from '../../../packages/daemon/src/lib/event-loop-activity.ts';
import {
  emitStructuredLogEvent,
  subscribeToStructuredLogs,
} from '../../../packages/daemon/src/lib/logger.ts';

const [portText, runText] = process.argv.slice(2);
const port = Number(portText);
assert(
  port > 0 && port !== 8399 && runText,
  'usage: lag-activity-check.ts <free-port> <fresh-run>'
);
const run = resolve(runText);
assert(process.env.NODE_ENV === 'test');
assert(process.env.HOME === join(run, 'home'));
assert(process.env.HYPERNEO_DATA_DIR === join(run, 'data'));
const db = join(run, 'data/daemon.db');
assert(!existsSync(db), 'requires a new synthetic database');
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'home'), { recursive: true });
const app = await createDaemonApp({
  config: getConfig({
    port,
    host: '127.0.0.1',
    dbPath: db,
    structuredLogFilePath: join(run, 'daemon.jsonl'),
  }),
  verbose: false,
});
const diagnostics: Record<string, unknown>[] = [];
const warnings: string[] = [];
const off = subscribeToStructuredLogs((event) => {
  if (event.message === 'event_loop.lag_activity') diagnostics.push(event.metadata);
});
function lagProfileSyntheticHotspot(): void {
  const until = performance.now() + 1350;
  while (performance.now() < until) {}
}
const stop = startDaemonLagDiagnostics(app.messageHub, (line) => warnings.push(line));
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
try {
  runLagPhase('stale.previous_tick', () => {});
  await pause(300);
  const retained = Array.from({ length: 400_000 }, (_, i) => ({ text: `synthetic heap ${i}`, i }));
  const sampleDurations = Array.from({ length: 200 }, () => {
    const start = performance.now();
    process.memoryUsage().heapUsed;
    return performance.now() - start;
  }).sort((a, b) => a - b);
  assert.equal(retained.length, 400_000);
  app.messageHub.onRequest('verify.lag', () =>
    runLagPhase('timer.synthetic_periodic', () => {
      emitStructuredLogEvent({
        level: 'warn',
        source: 'logger',
        module: 'hyperneo:daemon:agentsession PRIVATE_SESSION_MARKER',
        args: ['NEVER_RECORD_THIS_BODY'],
        metadata: { event: 'phase' },
      });
      lagProfileSyntheticHotspot();
      return { accepted: true };
    })
  );
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const id = crypto.randomUUID();
  try {
    const result = await new Promise<unknown>((done, fail) => {
      const timeout = setTimeout(() => fail(new Error('RPC timeout')), 10_000);
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            id,
            type: 'REQ',
            method: 'verify.lag',
            data: { privateText: 'NEVER_RECORD_THIS_BODY' },
            sessionId: 'global',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
          })
        );
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data.toString());
        if (message.requestId !== id) return;
        clearTimeout(timeout);
        done(message.data);
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        fail(new Error('RPC connection failed'));
      };
    });
    assert.deepEqual(result, { accepted: true });
  } finally {
    ws.close();
  }
  await pause(300);
  const diagnostic = diagnostics.find((entry) =>
    (entry.activities as { name: string }[]).some(
      (phase) => phase.name === 'timer.synthetic_periodic'
    )
  );
  assert(diagnostic, 'blocking RPC must produce activity metadata');
  assert((diagnostic.lagMs as number) >= 1000);
  if (process.env.HYPERNEO_LAG_PROFILE === '1') {
    const profile = diagnostic.samplingProfile as { status: string; stacks: { frames: { name: string; file: string; line: number }[] }[] };
    assert(profile?.status === 'captured', 'enabled profiler must produce a stalled-tick profile');
    assert(profile.stacks.some((stack) => stack.frames.some((frame) => frame.name === 'lagProfileSyntheticHotspot' && frame.file.endsWith('lag-activity-check.ts') && frame.line > 0)), 'profile must identify real synthetic hot function with file:line');
  } else assert(!('samplingProfile' in diagnostic), 'default-off profiler must be absent');
  const names = (diagnostic.activities as { name: string }[]).map((phase) => phase.name);
  assert(names.includes('rpc.in:verify.lag'));
  assert(names.includes('rpc.out:verify.lag'));
  assert(!names.includes('stale.previous_tick'));
  assert(!JSON.stringify(diagnostics).includes('NEVER_RECORD_THIS_BODY'));
  assert(!JSON.stringify(diagnostics).includes('PRIVATE_SESSION_MARKER'));
  app.jobProcessor.register('verify.periodic:PRIVATE_SESSION_MARKER', async () => {
    const until = performance.now() + 1350;
    while (performance.now() < until) {}
    return { completed: true };
  });
  app.jobQueue.enqueue({ queue: 'verify.periodic:PRIVATE_SESSION_MARKER', payload: {} });
  for (
    let i = 0;
    i < 30 &&
    !diagnostics.some((entry) =>
      (entry.activities as { name: string }[]).some((phase) => phase.name === 'job:verify.periodic')
    );
    i++
  )
    await pause(250);
  assert(
    diagnostics.some((entry) =>
      (entry.activities as { name: string }[]).some((phase) => phase.name === 'job:verify.periodic')
    ),
    'durable periodic work must be named'
  );
  assert(!JSON.stringify(diagnostics).includes('PRIVATE_SESSION_MARKER'));
  assert(typeof diagnostic.heapAfterBytes === 'number');
  assert(warnings.some((line) => /^\[Daemon\] Event loop blocked for \d+ms$/.test(line)));
  writeFileSync(
    join(run, 'observed.json'),
    JSON.stringify(
      {
        surface: 'real isolated daemon WebSocket RPC and production lag diagnostics attachment',
        diagnostic,
        periodicDiagnostic: diagnostics.find((entry) =>
          (entry.activities as { name: string }[]).some(
            (phase) => phase.name === 'job:verify.periodic'
          )
        ),
        warnings,
        heapSampleP95Ms: sampleDurations[189],
        heapSampleMaxMs: sampleDurations.at(-1),
        runtime: process.versions,
        syntheticOnly: true,
      },
      null,
      2
    )
  );
  process.stdout.write(
    `Verified real blocked RPC, phase attribution, tick clearing, payload privacy and heap fields: ${join(run, 'observed.json')}\n`
  );
} finally {
  stop();
  off();
  await app.cleanup();
}
