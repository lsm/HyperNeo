import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import {
  NEO_WAKE_SELECT,
  NeoConversationWakeRepository,
} from '../../../packages/daemon/src/storage/repositories/neo-conversation-wake-repository.ts';

const [mode, portText, runText] = process.argv.slice(2);
const port = Number(portText),
  run = resolve(runText);
assert(['reproduce', 'verify'].includes(mode));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'home'), { recursive: true });
const dbPath = join(run, 'data/wake.db');
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath }),
  verbose: false,
});
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
try {
  const db = app.db.getDatabase();
  const conversation = '10000000-0000-4000-8000-000000000001',
    root = `neo:${conversation}`;
  const session = db.prepare(
    "INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,'2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','active','{}','{}')"
  );
  for (const id of [root, ...Array.from({ length: 50 }, (_, i) => `s${i}`)])
    session.run(id, 'Synthetic', join(run, 'home'));
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const put = db.prepare(
    'INSERT INTO sdk_messages (id,session_id,message_type,sdk_uuid,sdk_message,timestamp) VALUES (?,?,?,?,?,?)'
  );
  const wake = db.prepare(
    'INSERT INTO session_schedule_wakes (session_id,message_id,metadata_json,fired_at) VALUES (?,?,?,?)'
  );
  const sdkRows = 140000,
    wakeRows = sdkRows / 100;
  const body = JSON.stringify({ type: 'user', message: { content: 'synthetic '.repeat(150) } });
  db.transaction(() => {
    for (let i = 0; i < sdkRows; i++) {
      const id = i % 5 === 0 ? root : `s${i % 50}`;
      put.run(
        `m${i}`,
        id,
        i % 4 === 0 ? 'user' : 'assistant',
        `u${i}`,
        body,
        '2026-10-20T00:00:00.000Z'
      );
      if (i % 100 === 0) wake.run(id, `pending-u${i}`, JSON.stringify({scheduleId: `wake-${i}`, sourceKind: "schedule", sourceId: `s${i}`}), 1792454400000 + i);
    }
  })();
  const sql = NEO_WAKE_SELECT + ' ORDER BY at DESC, sequence DESC LIMIT ?';
  const pending = new Map<string, (data: unknown) => void>();
  const rpc = () =>
    new Promise<{ data: { wakes?: unknown[] }; ms: number }>((done, fail) => {
      const id = crypto.randomUUID(),
        at = performance.now();
      const timer = setTimeout(() => fail(new Error('snapshot timeout')), 15000);
      pending.set(id, (data) => {
        clearTimeout(timer);
        done({
          data: data as { wakes?: unknown[] },
          ms: performance.now() - at,
        });
      });
      ws.send(
        JSON.stringify({
          id,
          type: 'REQ',
          method: 'operation.invoke',
          data: { name: 'neo.snapshot', input: {} },
          sessionId: 'global',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
        })
      );
    });
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data.toString()),
      reply = pending.get(m.requestId);
    if (reply) {
      pending.delete(m.requestId);
      reply(m.data);
    }
  };
  const cases: Record<string, unknown>[] = [];
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = fail;
  });
  for (const positive of [false, true]) {
    if (positive)
      for (const i of [0, 100])
        db.prepare(
          'UPDATE session_schedule_wakes SET metadata_json=?, message_id=? WHERE session_id=? AND message_id=?'
        ).run(
          JSON.stringify({ scheduleId: `wake-${i}`, sourceKind: 'schedule', sourceId: `s${i}` }),
          `u${i}`,
          root,
          `pending-u${i}`
        );
    const result = spawnSync(
      '/usr/bin/python3',
      ['packages/daemon/tests/helpers/sqlite-query-metrics.py', dbPath, sql, conversation],
      {
        encoding: 'utf8',
        env: { HOME: join(run, 'home'), PATH: '/usr/bin:/bin' },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const cold = JSON.parse(result.stdout);
    const at = performance.now();
    const rows = new NeoConversationWakeRepository(db).latest(conversation, 7);
    const repositoryMs = performance.now() - at;
    assert.deepEqual(
      rows.map((r) => r.scheduleId),
      positive ? ['wake-0', 'wake-100'] : []
    );
    const snapshot = await rpc();
    assert.equal(snapshot.data.wakes?.length, positive ? 2 : 0);
    cases.push({
      positive,
      coldConnection: cold,
      bunPlan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all(conversation, 7),
      repositoryMs,
      snapshotMs: snapshot.ms,
      rows: rows.length,
    });
  }
  const report = {
    surface:
      'real isolated daemon neo.snapshot WebSocket plus actual Bun wake repository and query plan',
    fixture:
      '140k synthetic SDK headers with 1.5KB bodies; 1400 pending schedule-wake metadata rows; zero then two scheduled wakes; default un-analyzed indexes',
    sdkRows,
    wakeRows,
    mode,
    sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get(),
    counter:
      'SQLite public C API stmt VM_STEP and db CACHE_MISS/HIT deltas via Python linked library; page reads are SQLite cache misses, not physical disk reads; fresh connection not OS cache flush',
    workBudget: wakeRows * 40 + 1000,
    cases,
  };
  writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (mode === 'verify')
    for (const c of cases)
      assert(
        (c.coldConnection as { vmSteps: number }).vmSteps <= report.workBudget,
        'wake lookup work must scale with wake metadata, not all SDK session messages'
      );
  else
    assert(
      cases.some((c) => (c.coldConnection as { vmSteps: number }).vmSteps > report.workBudget),
      'must reproduce excessive SDK traversal'
    );
} finally {
  ws.close();
  await app.cleanup();
}
