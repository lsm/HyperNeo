import { recordStartedWork } from '../../../packages/daemon/src/storage/work-started-sessions.ts';
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createFindWorkOperation } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import { placeKey } from '../../../packages/daemon/src/lib/drivers/places.ts';
import type { PlaceGroup } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { mirrorNeoWorkspaceProjectsAsync } from '../../../packages/daemon/src/lib/neo/project-mirror-async.ts';
import { mirrorNeoWorkspaceProjects } from '../../../packages/daemon/src/lib/neo/project-mirror.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const [mode, portText, runText] = process.argv.slice(2);
const port = Number(portText),
  run = resolve(runText);
assert(['reproduce', 'verify', 'memory'].includes(mode));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!fs.existsSync(join(run, 'data')));
fs.mkdirSync(join(run, 'home'), { recursive: true });
if (mode === 'memory') process.chdir(run);
const app = await createDaemonApp({
  config: getConfig({
    port,
    host: '127.0.0.1',
    dbPath: mode === 'memory' ? ':memory:' : join(run, 'data/mirror.db'),
  }),
  verbose: false,
});
const repo = new NeoRepository(app.db.getDatabase());
const groups: PlaceGroup[] = Array.from({ length: 40 }, (_, i) => {
  const folder = join(run, 'home', `project-${i}`);
  recordStartedWork(app.db.getDatabase(), { adapter: 'fixture', id: `work-${i}` });
  fs.mkdirSync(folder);
  repo.saveProject({ id: `p${i}`, title: `Synthetic ${i}`, summary: '', context: '' }, 0);
  app.db
    .getDatabase()
    .prepare('INSERT INTO neo_project_workspaces VALUES (?,?)')
    .run(`tool:${hostname()}:t${i}`, `p${i}`);
  return {
    place: {
      machine: hostname(),
      folder,
      name: `Synthetic ${i}`,
      toolProject: { id: `t${i}`, name: `Synthetic ${i}` },
    },
    lastActivityAt: i,
    openCount: 0,
    archivedCount: 0,
    adapters: ['fixture'],
    work: [{ ref: { adapter: 'fixture', id: `work-${i}` }, title: `Synthetic ${i}`, status: 'done', lastActivityAt: i,
      place: { machine: hostname(), folder, name: `Synthetic ${i}`, toolProject: { id: `t${i}`, name: `Synthetic ${i}` } } }],
  };
});
const slowPath = groups[0].place.folder!;
const nativeFs = { ...fs };
const exists = fs.existsSync;
let armed = false,
  delayed = 0,
  concurrentEditMs: number | null = null;
mock.module('node:fs', () => ({
  ...nativeFs,
  existsSync: (path: fs.PathLike) => {
    if (armed && path === slowPath && !delayed) {
      delayed++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1400);
    }
    return exists(path);
  },
}));
const marker = join(run, 'probe-go');
const probeCode = `import { existsSync } from 'node:fs'; const ws=new WebSocket('ws://127.0.0.1:${port}/ws'); let at; ws.onopen=()=>{console.log('READY'); const timer=setInterval(()=>{if(existsSync(${JSON.stringify(marker)})){clearInterval(timer);at=performance.now();ws.send(JSON.stringify({id:'health',type:'REQ',method:'system.health',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));}},1);}; ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.requestId==='health'){console.log(JSON.stringify({ms:performance.now()-at,data:r.data}));ws.close();process.exit(0);}};`;
const workerEntry = join(run, 'mirror-worker.ts');
const workerDelay = join(run, 'worker-delay.json');
fs.writeFileSync(
  workerEntry,
  `import { mock } from 'bun:test'; import * as fs from 'node:fs'; const native={...fs}; let calls=0; mock.module('node:fs',()=>({...native,existsSync:(path)=>{if(path===${JSON.stringify(slowPath)}&&!calls){calls++;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1400);native.writeFileSync(${JSON.stringify(workerDelay)},JSON.stringify({calls}));}return native.existsSync(path);}})); import ${JSON.stringify(new URL('../../../packages/daemon/src/lib/neo/project-mirror-worker.ts', import.meta.url).href)};`
);
const probe = spawn(process.execPath, ['-e', probeCode], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});
let probeOutput = '',
  probeError = '';
probe.stdout.on('data', (data) => {
  probeOutput += data;
});
probe.stderr.on('data', (data) => {
  probeError += data;
});
const probeExit = new Promise<number | null>((done) => probe.once('exit', done));
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
let previous = performance.now(),
  maxLagMs = 0;
const heartbeat = setInterval(() => {
  const now = performance.now();
  maxLagMs = Math.max(maxLagMs, now - previous - 10);
  previous = now;
}, 10);
const originalRegistry = app.sessionManager.getOperationRegistry();
const find = createFindWorkOperation({
  adapters: () => [{ id: 'fixture', capabilities: ['find'], find: () => groups }],
  remote: { list: () => [], invoke: async () => null },
  mirrorProjects: async (found) => {
    fs.writeFileSync(marker, 'go');
    armed = mode !== 'memory';
    const started = performance.now();
    const edit = setTimeout(() => {
      const project = repo.getProject('p0')!;
      assert(repo.saveProject({ ...project, context: 'Concurrent synthetic edit' }, project.revision));
      concurrentEditMs = performance.now() - started;
    }, 200);
    try {
      if (mode !== 'reproduce')
        await mirrorNeoWorkspaceProjectsAsync(
          app.db,
          found,
          () => new Worker(workerEntry, { type: 'module' })
        );
      else mirrorNeoWorkspaceProjects(app.db.getDatabase(), found);
      await wait(mode === 'memory' ? 220 : 0);
    } finally {
      clearTimeout(edit);
      armed = false;
    }
  },
});
app.sessionManager.setOperationRegistryProvider(() =>
  createOperationRegistry([...originalRegistry.entries.filter((e) => e.name !== 'work.find'), find])
);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
try {
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = fail;
  });
  for (let i = 0; !probeOutput.includes('READY') && i < 100; i++) await wait(20);
  assert(probeOutput.includes('READY'), probeError);
  await wait(100);
  maxLagMs = 0;
  const at = performance.now();
  const reply = new Promise<{ places: unknown[] }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('find timeout')), 15000);
    ws.onmessage = (event) => {
      const r = JSON.parse(event.data.toString());
      fs.writeFileSync(join(run, 'rpc-wire.json'), JSON.stringify(r, null, 2));
      if (r.requestId === 'find') {
        clearTimeout(timer);
        if (r.error) fail(new Error(JSON.stringify(r.error)));
        else done(r.data);
      }
    };
  });
  ws.send(
    JSON.stringify({
      id: 'find',
      type: 'REQ',
      method: 'operation.invoke',
      data: { name: 'work.find', input: { localOnly: true, limit: 50 } },
      sessionId: 'global',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    })
  );
  const result = await reply,
    findMs = performance.now() - at;
  assert.equal(await probeExit, 0, probeError);
  await wait(50);
  const health = JSON.parse(probeOutput.trim().split('\n').at(-1)!);
  assert.equal(result.places.length, 40);
  assert.equal(repo.listProjects().length, 40);
  assert(!fs.existsSync(join(run, ':memory:')));
  assert.equal(repo.getProject('p0')?.context, 'Concurrent synthetic edit');
  const aliases = app.db
    .getDatabase()
    .prepare(
      "SELECT alias, project_id AS id FROM neo_project_workspaces WHERE alias LIKE 'folder:%' ORDER BY alias"
    )
    .all();
  assert.deepEqual(
    aliases,
    groups
      .map((g, i) => ({ alias: `folder:${placeKey(g.place)}`, id: `p${i}` }))
      .sort((a, b) => a.alias.localeCompare(b.alias))
  );
  const observedDelay =
    mode === 'verify' ? JSON.parse(fs.readFileSync(workerDelay, 'utf8')).calls : delayed;
  assert.equal(health.data.status, 'ok');
  const initialMaxLagMs = maxLagMs;
  const nativeAt = performance.now();
  if (mode === 'verify') await mirrorNeoWorkspaceProjectsAsync(app.db, groups);
  const nativeWorkerMs = mode === 'verify' ? performance.now() - nativeAt : null;
  const report = {
    surface:
      'actual work.find operation.invoke RPC with synthetic adapter + real mirror, external WebSocket health probe',
    mode,
    maxLagMs: initialMaxLagMs,
    nativeWorkerMs,
    concurrentEditMs,
    findMs,
    healthMs: health.ms,
    delayed: observedDelay,
    projects: repo.listProjects().length,
    groups: result.places.length,
    fixture:
      mode === 'memory'
        ? '40 synthetic tool projects, private memory DB, no injected FS wait; 220ms fixture edit barrier'
        : '40 synthetic tool projects, one1.4s controlled existsSync wait on own workspace; no live data/GitHub/model',
  };
  fs.writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(observedDelay, mode === 'memory' ? 0 : 1);
  if (mode !== 'reproduce') {
    assert(initialMaxLagMs < 1000);
    assert(health.ms < 250);
    assert(concurrentEditMs !== null && concurrentEditMs < 1000);
  } else {
    assert(initialMaxLagMs >= 1000);
    assert(health.ms >= 1000);
  }
} finally {
  clearInterval(heartbeat);
  mock.module('node:fs', () => nativeFs);
  ws.close();
  probe.kill();
  await app.cleanup();
}
