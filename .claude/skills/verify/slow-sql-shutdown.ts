import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as watchdog from '../../../packages/daemon/src/lib/event-loop-watchdog.ts';
import * as lag from '../../../packages/daemon/src/lib/event-loop-lag.ts';
import { emitStructuredLogEvent } from '../../../packages/daemon/src/lib/logger.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'home'), { recursive: true });
const originalWatchdog = { ...watchdog };
const originalLag = { ...lag };
mock.module('../../../packages/daemon/src/lib/event-loop-watchdog.ts', () => ({
  ...originalWatchdog,
  armStallDetectionWhenStartupSettles: (
    _handle: unknown,
    _ready: unknown,
    options: watchdog.ArmStallDetectionOptions
  ) => options.onArm?.('startup_settled'),
}));
mock.module('../../../packages/daemon/src/lib/event-loop-lag.ts', () => ({
  ...originalLag,
  startDaemonLagDiagnostics: (_hub: unknown, warn: (line: string) => void) =>
    originalLag.startEventLoopLagLog(warn, { tickMs: 60_000 }),
}));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const results: { errorCleanup: boolean; persisted: boolean; metadata?: Record<string, unknown> }[] =
  [];
for (const fails of [false, true]) {
  const name = fails ? 'error' : 'normal';
  const path = join(run, `${name}.jsonl`);
  const app = await createDaemonApp({
    config: getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, `data/${name}.db`),
      structuredLogFilePath: path,
    }),
    verbose: false,
  });
  let cleaned = false;
  try {
    emitStructuredLogEvent({
      level: 'warn',
      args: ['shutdown capture baseline'],
      source: 'logger',
    });
    await app.flushStructuredLogs();
    const db = app.db.getDatabase();
    const statement = (alias: string) =>
      db.prepare(
        `WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter WHERE n<?) SELECT SUM(n) AS ${alias} FROM counter`
      );
    const at = performance.now();
    statement('warmup_total').get(1_000_000);
    const count = Math.round((1_000_000 * 500) / (performance.now() - at));
    const select = statement('shutdown_total');
    const dispose = app.fileIndex.dispose.bind(app.fileIndex);
    app.fileIndex.dispose = () => {
      dispose();
      const row = select.get(count) as { shutdown_total: number };
      assert.equal(row.shutdown_total, (count * (count + 1)) / 2);
      if (fails) throw new Error('synthetic cleanup failure');
    };
    if (fails) await assert.rejects(app.cleanup(), /synthetic cleanup failure/);
    else await app.cleanup();
    cleaned = true;
    const events = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const slow = events.filter((event) =>
      String(event.metadata?.normalizedSql).includes('shutdown_total')
    );
    results.push({
      errorCleanup: fails,
      persisted: slow.length === 1,
      metadata: slow[0]?.metadata,
    });
  } finally {
    if (!cleaned) await app.cleanup().catch(() => {});
    if (fails) app.db.close();
  }
}
const report = {
  surface: 'actual daemon app cleanup → real Bun SQLite query → structured JSONL file',
  fixture:
    'NODE_ENV=test; watchdog arming explicitly simulated; real monitor uses 60 s cadence to leave the final query pending',
  results,
};
writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
for (const result of results) {
  assert(result.persisted, 'shutdown must retain the pending SQL record in the real log file');
  assert.equal(result.metadata?.resourceScope, 'event_loop_tick');
}
