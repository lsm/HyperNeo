import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLagPhase } from '../../../packages/daemon/src/lib/event-loop-activity.ts';
import { startDaemonLagDiagnostics } from '../../../packages/daemon/src/lib/event-loop-lag.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'hn-lag-diagnostics-'));
const dir = mkdtempSync(join(tmpdir(), 'hn-lag-db-'));
const records: { event: string; metadata: Record<string, unknown> }[] = [];
const off = subscribeToStructuredLogs((event) => {
  const name =
    event.message === 'event_loop.lag_activity' ? event.message : String(event.metadata.event ?? '');
  if (name === 'slow' || name === 'event_loop.lag_activity')
    records.push({ event: name, metadata: event.metadata });
});
const lines: string[] = [];
const stop = startDaemonLagDiagnostics({ onMessage: () => () => {} }, (line) => lines.push(line));
const db = new Database(join(dir, 'lag.db'), {
  queryObservability: { slowThresholdMs: 250, summaryIntervalMs: 0, maxQueryGroups: 50, summaryQueryLimit: 5 },
});
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const spin = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};
try {
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
  await pause(600);
  runLagPhase('verify:cpu_spin', () => spin(1300));
  await pause(600);
  runLagPhase('verify:off_cpu_wait', () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300)
  );
  await pause(600);
  db.transaction(() => {
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('a', 'one');
    spin(1300);
  })();
  await pause(600);
} finally {
  stop();
  off();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
const blocks = records
  .filter((r) => r.event === 'event_loop.lag_activity')
  .map((r) => ({
    lagMs: Math.round(Number(r.metadata.lagMs)),
    phases: (r.metadata.activities as { name: string; kind: string }[])
      .filter((a) => a.kind === 'end')
      .map((a) => a.name),
    resources: r.metadata.resources,
  }));
const report = {
  surface:
    'startDaemonLagDiagnostics (what the daemon arms) and the Bun SQLite wrapper with query observability, read through the structured log stream',
  lines,
  blocks,
  slowSql: records.filter((r) => r.event === 'slow').map((r) => ({ sql: r.metadata.normalizedSql, operation: r.metadata.operation, durationMs: r.metadata.durationMs })),
  runtime: Bun.version,
};
writeFileSync(join(out, 'lag-diagnostics.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
