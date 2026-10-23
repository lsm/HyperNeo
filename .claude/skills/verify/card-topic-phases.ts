import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import {
  EventLoopActivity,
  runLagPhase,
} from '../../../packages/daemon/src/lib/event-loop-activity.ts';
import { startEventLoopLagLog } from '../../../packages/daemon/src/lib/event-loop-lag.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';

const [mode, portText, runText, delivery = 'enabled'] = process.argv.slice(2);
assert(['enabled', 'disabled'].includes(delivery));
const enabled = delivery === 'enabled';
const port = Number(portText),
  run = resolve(runText);
assert(['reproduce', 'verify'].includes(mode));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'home'), { recursive: true });
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
if (!enabled) app.db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
const now = Date.now(),
  count = 180;
app.db.createSession({
  id: 'synthetic-root',
  title: 'Synthetic root',
  workspacePath: join(run, 'home'),
  createdAt: new Date(now).toISOString(),
  lastActiveAt: new Date(now).toISOString(),
  status: 'active',
  config: {},
  metadata: {
    messageCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    toolCallCount: 0,
  },
});
service.todos.openAsk({
  id: 'synthetic-ask',
  sessionId: 'synthetic-root',
  projectId: null,
  originMessageId: 'synthetic-human',
  title: 'Synthetic asks',
  request: 'Observe metadata',
  createdAt: now,
});
for (let i = 0; i <= count; i++) {
  const id = `synthetic-${i}`;
  const todo = service.todos.addTodo(
    id,
    'synthetic-ask',
    { title: id, doneWhen: 'Reported', instruction: null, check: null, named: null },
    now
  );
  service.todos.updateTodo(todo, { state: i === count ? 'removed' : 'doing' }, now);
  service.cardEvents.subscribe(id, `synthetic/${i}/a`, now);
  service.cardEvents.subscribe(id, `synthetic/${i}/b`, now);
}
const activity = new EventLoopActivity();
const totals = new Map<string, { count: number; totalMs: number; maxMs: number }>();
const record = activity.record.bind(activity);
activity.record = (name, kind = 'event', durationMs) => {
  if (kind === 'end' && durationMs !== undefined) {
    const key = name.replace(/:synthetic-\d+$/, '');
    const row = totals.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    row.count++;
    row.totalMs += durationMs;
    row.maxMs = Math.max(row.maxMs, durationMs);
    totals.set(key, row);
  }
  record(name, kind, durationMs);
};
const diagnostics: Record<string, unknown>[] = [];
const stop = startEventLoopLagLog(() => {}, {
  activity,
  onDiagnostic: (report) => diagnostics.push(report),
});
const readSettings = app.db.getGlobalSettings.bind(app.db);
let reads = 0;
app.db.getGlobalSettings = () => {
  reads++;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8);
  return readSettings();
};
app.messageHub.onRequest('verify.card_topics', () => ({
  ended: runLagPhase('neo:driver:card_topic_sweep', () => service.endUnfollowedCardTopics(now + 1)),
}));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const pending = new Map<string, (data: unknown) => void>();
const rpc = (method: string) =>
  new Promise<{ data: unknown; ms: number }>((done, fail) => {
    const id = crypto.randomUUID(),
      start = performance.now();
    const timeout = setTimeout(() => fail(new Error(`${method} timed out`)), 15_000);
    pending.set(id, (data) => {
      clearTimeout(timeout);
      done({ data, ms: performance.now() - start });
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
  const m = JSON.parse(event.data.toString()),
    reply = pending.get(m.requestId);
  if (reply) {
    pending.delete(m.requestId);
    reply(m.data);
  }
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
let previous = performance.now(),
  maxLagMs = 0;
const heartbeat = setInterval(() => {
  const at = performance.now();
  maxLagMs = Math.max(maxLagMs, at - previous - 10);
  previous = at;
}, 10);
try {
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = fail;
  });
  await pause(300);
  maxLagMs = 0;
  reads = 0;
  const sweep = rpc('verify.card_topics');
  const health = await rpc('system.health');
  const result = await sweep;
  app.db.getGlobalSettings = readSettings;
  await pause(300);
  assert.equal((health.data as { status: string }).status, 'ok');
  const endedIds = enabled ? [count] : Array.from({ length: count + 1 }, (_, i) => i);
  assert.deepEqual(result.data, {
    ended: endedIds.flatMap((id) => [
      { workId: `synthetic-${id}`, topic: `synthetic/${id}/a` },
      { workId: `synthetic-${id}`, topic: `synthetic/${id}/b` },
    ]),
  });
  const remainingTopics = service.cardEvents.listActive().length;
  assert.equal(remainingTopics, enabled ? count * 2 : 0);
  const initialMaxLagMs = maxLagMs;
  const initialTotals = Object.fromEntries(
    [...totals].map(([name, value]) => [name, { ...value }])
  );
  app.db.updateGlobalSettings({ neo: { packs: enabled ? ['life-admin'] : ['coding'] } });
  if (!enabled)
    for (let i = 0; i < count; i++)
      for (const suffix of ['a', 'b'])
        service.cardEvents.subscribe(`synthetic-${i}`, `synthetic/${i}/${suffix}`, now + 2);
  const next = await rpc('verify.card_topics');
  const nextEnded = (next.data as { ended: unknown[] }).ended.length;
  assert.equal(nextEnded, enabled ? count * 2 : 0);
  assert.equal(service.cardEvents.listActive().length, enabled ? 0 : count * 2);
  const report = {
    surface:
      'isolated daemon WebSocket → real synchronous Neo card-topic sweep → lag diagnostic phases',
    fixture:
      '180 followed synthetic todos with two topics each, one removed todo; 8ms controlled wait plus native SQLite settings SELECT per eligibility read, no live data',
    mode,
    delivery,
    maxLagMs: initialMaxLagMs,
    healthMs: health.ms,
    sweepMs: result.ms,
    settingsReads: reads,
    phaseTotals: initialTotals,
    diagnostics,
    result: result.data,
    remainingTopics,
    nextSweepSettingsEffect: { nextEnded, remainingTopics: service.cardEvents.listActive().length },
  };
  writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const pack = initialTotals['neo:packs:eligibility_read'];
  if (mode === 'verify') {
    assert(initialMaxLagMs < 1000, 'the sweep must not block the main thread for 1 s');
    assert(health.ms < 250, 'health must remain responsive');
    assert(
      pack && pack.count === 1 && reads === 1,
      'sample pack delivery eligibility once per sweep, including false'
    );
  } else {
    assert(initialMaxLagMs >= 1000, 'must reproduce the synchronous sweep cost');
    assert.equal(reads, count);
  }
} finally {
  app.db.getGlobalSettings = readSettings;
  clearInterval(heartbeat);
  stop();
  ws.close();
  service.dispose();
  await app.cleanup();
}
