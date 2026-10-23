import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { EventLoopActivity } from '../../../packages/daemon/src/lib/event-loop-activity.ts';
import { startEventLoopLagLog } from '../../../packages/daemon/src/lib/event-loop-lag.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';

const [mode, portText, runText, delivery = 'enabled', delayText = '0'] = process.argv.slice(2);
assert(['enabled', 'disabled'].includes(delivery));
const enabled = delivery === 'enabled';
const port = Number(portText),
  run = resolve(runText);
assert(['reproduce', 'verify', 'measure'].includes(mode));
const delayMs = Number(delayText);
assert([0, 8].includes(delayMs));
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
  if (i < count)
    service.todoPrs.claim(
      id,
      [{ url: `https://github.com/synthetic/feed/pull/${i + 1}`, claim: 'named' }],
      now
    );
  service.cardEvents.subscribe(id, `synthetic/${i}/a`, now);
  service.cardEvents.subscribe(id, `synthetic/${i}/b`, now);
}
let inFollow = false,
  followReads = 0;
service.readPrs = async () => [];
const activity = new EventLoopActivity();
const totals = new Map<string, { count: number; totalMs: number; maxMs: number }>();
const record = activity.record.bind(activity);
activity.record = (name, kind = 'event', durationMs) => {
  if (name === 'neo:driver:follow_topics') inFollow = kind === 'start';
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
  if (inFollow) followReads++;
  if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  return readSettings();
};
app.messageHub.onRequest('verify.follow_topics', async () => {
  await service.refreshDriverWork();
  return { followed: service.todos.listCheckable().length };
});
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
  const sweep = rpc('verify.follow_topics');
  const health = await rpc('system.health');
  const result = await sweep;
  app.db.getGlobalSettings = readSettings;
  await pause(300);
  assert.equal((health.data as { status: string }).status, 'ok');
  assert.deepEqual(result.data, { followed: count });
  const remainingTopics = service.cardEvents.listActive().length;
  assert.equal(remainingTopics, enabled ? count * 3 : 0);
  const initialMaxLagMs = maxLagMs;
  const initialTotals = Object.fromEntries(
    [...totals].map(([name, value]) => [name, { ...value }])
  );
  app.db.updateGlobalSettings({ neo: { packs: enabled ? [] : ['coding'] } });
  await rpc('verify.follow_topics');
  const nextTopics = service.cardEvents.listActive().length;
  assert.equal(nextTopics, enabled ? 0 : count);
  const report = {
    surface:
      'isolated daemon WebSocket → actual refreshDriverWork; GitHub reader is synthetic; no root session binding',
    fixture:
      '180 followed synthetic todos with named PRs and two retained topics each, one removed todo; native SQLite settings reads plus optional controlled wait; no network/model/live data',
    mode,
    delivery,
    delayMs,
    maxLagMs: initialMaxLagMs,
    healthMs: health.ms,
    sweepMs: result.ms,
    settingsReads: reads,
    followSettingsReads: followReads,
    phaseTotals: initialTotals,
    diagnostics,
    result: result.data,
    remainingTopics,
    nextRefreshSettingsEffect: { remainingTopics: nextTopics },
  };
  writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (mode === 'verify') {
    assert.equal(followReads, 1);
    assert(initialMaxLagMs < 1000, 'refresh must remain below1s lag');
    assert(health.ms < 250, 'health must remain responsive');
  } else {
    assert.equal(followReads, count);
    if (delayMs)
      assert(initialMaxLagMs >= 1000, 'controlled slow settings must reproduce follow-loop lag');
  }
} finally {
  app.db.getGlobalSettings = readSettings;
  clearInterval(heartbeat);
  stop();
  ws.close();
  service.dispose();
  await app.cleanup();
}
