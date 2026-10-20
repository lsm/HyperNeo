import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  delayedFeedAsync,
  delayedFeedSync,
} from '../../../packages/daemon/tests/helpers/delayed-feed-fs';

const [mode, portText, runText] = process.argv.slice(2);
const port = Number(portText);
const run = resolve(runText);
assert(['reproduce', 'verify'].includes(mode));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!fs.existsSync(join(run, 'data')));
const delay = { path: '', operation: '', ms: 1400 };
const nativeFs = { ...fs };
const nativePromises = { ...promises };
mock.module('node:fs', () => delayedFeedSync(nativeFs, delay));
mock.module('node:fs/promises', () => delayedFeedAsync(nativePromises, delay));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { runCodexFeed, codexFeedSource } = await import(
  '../../../packages/daemon/src/lib/drivers/codex-feed.ts'
);
const { runClaudeFeed } = await import('../../../packages/daemon/src/lib/drivers/claude-feed.ts');
const { pruneVanishedFeeds } = await import(
  '../../../packages/daemon/src/lib/drivers/work-feed.ts'
);
const { readWorkFeedOffsets, saveWorkFeedChunk } = await import(
  '../../../packages/daemon/src/storage/work-feed.ts'
);
const codex = join(run, 'home/.codex/sessions');
const claude = join(run, 'home/.claude/projects');
fs.mkdirSync(join(codex, '2026'), { recursive: true });
fs.mkdirSync(join(claude, 'project'), { recursive: true });
const codexPath = join(codex, '2026/rollout-11111111-1111-1111-1111-111111111111.jsonl');
const claudePath = join(claude, 'project/session.jsonl');
const stamp = '2026-10-20T05:00:00.000Z';
fs.writeFileSync(
  codexPath,
  [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: '11111111-1111-1111-1111-111111111111', cwd: '/synthetic/project' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: stamp,
      payload: {
        type: 'message',
        id: 'u1',
        role: 'user',
        content: [{ type: 'input_text', text: 'synthetic codex request' }],
      },
    }),
    '',
  ].join('\n')
);
const transcript =
  JSON.stringify({
    type: 'user',
    uuid: 'claude-u1',
    timestamp: stamp,
    cwd: '/synthetic/project',
    message: { content: 'synthetic claude request' },
  }) + '\n';
fs.writeFileSync(claudePath, transcript);
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const db = app.db.getDatabase();
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const pending = new Map<string, (data: unknown) => void>();
const rpc = (method: string) =>
  new Promise<{ data: unknown; ms: number }>((done, fail) => {
    const id = crypto.randomUUID();
    const start = performance.now();
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 15_000);
    pending.set(id, (data) => {
      clearTimeout(timer);
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
  const message = JSON.parse(event.data.toString());
  const reply = pending.get(message.requestId);
  if (reply) {
    pending.delete(message.requestId);
    reply(message.data);
  }
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
let work: () => Promise<unknown> = async () => null;
app.messageHub.onRequest('verify.feed', () => work());
let last = performance.now();
let maxLagMs = 0;
const timer = setInterval(() => {
  const now = performance.now();
  maxLagMs = Math.max(maxLagMs, now - last - 10);
  last = now;
}, 10);
const cases: Record<string, unknown>[] = [];
try {
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = fail;
  });
  const measure = async (
    name: string,
    path: string,
    operation: string,
    action: () => Promise<unknown>
  ) => {
    work = action;
    delay.path = path;
    delay.operation = operation;
    await pause(30);
    maxLagMs = 0;
    const feed = rpc('verify.feed');
    const health = await rpc('system.health');
    const result = await feed;
    delay.path = '';
    await pause(30);
    assert.equal((health.data as { status: string }).status, 'ok');
    cases.push({ name, maxLagMs, healthMs: health.ms, durationMs: result.ms, result: result.data });
  };
  await measure('codex listing', codex, 'list', () =>
    runCodexFeed(app.jobQueue, db, codex, Date.now())
  );
  await measure('claude listing', claude, 'list', () =>
    runClaudeFeed(app.jobQueue, db, claude, Date.now())
  );
  const beforePrune = [...readWorkFeedOffsets(db)];
  await measure('retained path prune', codexPath, 'prune', () =>
    pruneVanishedFeeds(db, codex, codexFeedSource)
  );
  assert.deepEqual([...readWorkFeedOffsets(db)], beforePrune);
  const old = join(claude, 'project/old.jsonl');
  fs.writeFileSync(old, transcript.replaceAll('claude-u1', 'claude-old'));
  fs.utimesSync(old, 1, 1);
  saveWorkFeedChunk(db, 'claude', '', [], old, { offset: 0, size: -1, mtime: 1000 });
  await measure('unfinished known path', old, 'known', () =>
    runClaudeFeed(app.jobQueue, db, claude, Date.now())
  );
  const rows = db
    .prepare(
      "SELECT kind,source_id,body FROM message_search_content WHERE kind IN ('codex','claude') ORDER BY kind,source_id"
    )
    .all();
  assert.deepEqual(rows, [
    { kind: 'claude', source_id: 'claude-old', body: 'synthetic claude request' },
    { kind: 'claude', source_id: 'claude-u1', body: 'synthetic claude request' },
    {
      kind: 'codex',
      source_id: '11111111-1111-1111-1111-111111111111:u1',
      body: 'synthetic codex request',
    },
  ]);
  const offsets = [...readWorkFeedOffsets(db)].map(([path, offset]) => {
    assert.equal(offset.offset, fs.statSync(path).size);
    assert.equal(offset.size, fs.statSync(path).size);
    assert.equal(offset.mtime, Math.floor(fs.statSync(path).mtimeMs));
    return { path: relative(run, path), ...offset };
  });
  const report = {
    surface:
      'actual daemon feed pipelines over WebSocket, real synthetic files and SQLite, system.health in parallel',
    fixture:
      '1.4 s injected only into each selected synthetic path metadata call; sync Atomics.wait vs async timer, identical underlying native filesystem',
    mode,
    cases,
    rows,
    offsets,
  };
  fs.writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const entry of cases) {
    if (mode === 'verify') {
      assert(Number(entry.maxLagMs) < 1000, `${entry.name}: main thread must remain responsive`);
      assert(Number(entry.healthMs) < 250, `${entry.name}: health must respond during I/O`);
    } else
      assert(Number(entry.maxLagMs) >= 1000, `${entry.name}: must reproduce a main-thread stall`);
  }
} finally {
  delay.path = '';
  clearInterval(timer);
  ws.close();
  await app.cleanup();
}
