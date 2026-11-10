import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readLatestSessionPrState, SessionExternalEventStore } from '../../../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import {
  hasTopicSearches,
  legacyBindings,
  legacySql,
  observeLatestPrState,
  seedPrHistory,
  subject,
  topicIndex,
} from '../../../packages/daemon/tests/unit/helpers/latest-pr-state-fixture.ts';

const mode = process.argv[2];
const baseline = resolve(process.argv[3]);
const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert(['baseline', 'upgrade', 'bootstrap'].includes(mode));
for (const dir of ['data', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
const path = join(run, 'data/daemon.db');
const snapshot = (db: Database) => ({
  count: (db.prepare('SELECT count(*) AS count FROM session_external_events').get() as { count: number }).count,
  sha: createHash('sha256').update(JSON.stringify(db.prepare('SELECT rowid, * FROM session_external_events ORDER BY rowid').all())).digest('hex'),
});
const evidence: Record<string, unknown> = { mode };
if (mode === 'upgrade') {
  copyFileSync(baseline, path);
  const old = new Database(path);
  try {
    evidence.before = snapshot(old);
    assert.equal(old.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(topicIndex), null);
  } finally {
    old.close();
  }
}
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
try {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: path, workspaceRoot: join(run, 'workspace') }), disableWorktrees: true }, verbose: false });
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const db = app.db.getDatabase();
  if (mode !== 'upgrade') seedPrHistory(db);
  evidence.after = snapshot(db);
  if (mode === 'upgrade') assert.deepEqual(evidence.after, evidence.before);
  const samples = [];
  for (const suffix of ['', '1', '2', '3', '4', '5', '99999']) {
    const value = `${subject}${suffix}`.toUpperCase();
    const observed = observeLatestPrState(db, value);
    const legacy = db.prepare(legacySql).get(...legacyBindings(value)) as { id: string } | null;
    const actual = await app.db.gateway.run(readLatestSessionPrState, value);
    assert.equal(actual?.event.id ?? null, legacy?.id ?? null);
    samples.push({ subject: value, id: actual?.event.id ?? null, ...observed });
  }
  evidence.results = samples.map(({ subject, id, sql, bindings, plan }) => ({ subject, id, sql, bindings, plan }));
  const legacyPlan = db.prepare(`EXPLAIN QUERY PLAN ${legacySql}`).all(...legacyBindings(subject)) as { detail: string }[];
  evidence.legacyPlan = legacyPlan.map((row) => row.detail);
  const measure = (call: () => unknown) => {
    const times = [];
    for (let i = 0; i < 11; i++) {
      const start = performance.now();
      call();
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[5];
  };
  evidence.medianMs = {
    legacy: measure(() => db.prepare(legacySql).get(...legacyBindings(subject))),
    current: measure(() => new SessionExternalEventStore(db).latestPrState(subject)),
  };
  evidence.migration = db.prepare("SELECT key FROM migration_markers WHERE key = 'migration_498'").all();
  assert(samples.every(({ plan }) => hasTopicSearches(plan)), 'both production legs must search source and indexed topic');
  assert(!hasTopicSearches(legacyPlan.map((row) => row.detail)));
  evidence.passed = true;
} finally {
  await app?.cleanup();
  if (mode === 'baseline') copyFileSync(path, baseline);
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/latest-pr-state.json'), JSON.stringify(evidence, null, 2));
}
console.log('PASS watched PR lookup preserves results and searches both topic index legs');
