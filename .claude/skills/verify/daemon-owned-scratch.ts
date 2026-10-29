import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { installClaudeNativeWrites } from '../../../packages/daemon/src/lib/drivers/claude-native-writes.ts';
import { workerWorkLocations } from '../../../packages/daemon/src/lib/work-locations.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
const install: (root: string, roots: string[], daemonOwned?: boolean) => Promise<void> = installClaudeNativeWrites;
const ownerPath = (root: string) => join(run, 'data/work/scratch-owners', `${basename(workerWorkLocations(root).scratch)}.json`);
async function fixture(name: string, owned = true) {
  const root = join(run, 'workers', name);
  mkdirSync(join(root, '.git'), { recursive: true });
  await install(root, [root], owned);
  writeFileSync(join(workerWorkLocations(root).scratch, 'synthetic-temp.txt'), name);
  return root;
}
const config = () => getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: config(), verbose: false });
  assert.notEqual(app.server.port, 8399);
  const sdk = await fixture('sdk');
  const desktop = await fixture('desktop', false);
  assert(existsSync(ownerPath(sdk)), 'SDK scratch must have an authoritative owner record');
  assert(!existsSync(ownerPath(desktop)), 'Desktop scratch must remain unclaimed');
  const now = new Date().toISOString();
  await app.db.createSession({ id: 'synthetic-scratch', title: 'Scratch proof', workspacePath: sdk, createdAt: now, lastActiveAt: now, status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const reply = await new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('archive timeout')), 30000);
    ws!.onmessage = (event) => {
      const response = JSON.parse(String(event.data));
      if (response.id !== id && response.requestId !== id) return;
      clearTimeout(timer); done(response);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'session.archive', data: { sessionId: 'synthetic-scratch', confirmed: true }, timestamp: now, version: '1.0.0' }));
  });
  assert(!reply.error, JSON.stringify(reply));
  assert(!existsSync(workerWorkLocations(sdk).scratch));
  evidence.archive = reply;
  ws.close(); ws = undefined;
  const shutdown = await fixture('shutdown');
  await app.cleanup(); app = undefined;
  assert(!existsSync(workerWorkLocations(shutdown).scratch), 'daemon shutdown must remove its own scratch');
  assert(existsSync(workerWorkLocations(desktop).scratch), 'daemon shutdown must retain Desktop scratch');
  evidence.shutdown = { ownRemoved: true, desktopRetained: true };
  const stale = await fixture('stale');
  const recent = await fixture('recent');
  const live = await fixture('live');
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(dead.status, 0);
  for (const root of [stale, recent, live]) {
    const path = ownerPath(root);
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    owner.pid = root === live ? process.pid : dead.pid;
    owner.createdAt = Date.now() - (root === recent ? 1000 : 25 * 60 * 60 * 1000);
    writeFileSync(path, JSON.stringify(owner));
  }
  app = await createDaemonApp({ config: config(), verbose: false });
  assert(!existsSync(workerWorkLocations(stale).scratch), 'startup must reclaim old scratch with a dead owner');
  assert(existsSync(workerWorkLocations(recent).scratch), 'startup must retain recent scratch');
  assert(existsSync(workerWorkLocations(live).scratch), 'startup must retain scratch with a live owner');
  assert(existsSync(workerWorkLocations(desktop).scratch), 'startup must retain unmarked Desktop scratch');
  evidence.startup = { staleDeadRemoved: true, recentRetained: true, liveRetained: true, desktopRetained: true };
  evidence.passed = true;
  console.log('PASS archive RPC, normal daemon shutdown, stale-dead startup recovery and live/recent/Desktop retention');
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/daemon-owned-scratch.json'), JSON.stringify(evidence, null, 2));
}
process.exit(0);
