import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createFindWorkOperation } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { mirrorNeoWorkspaceProjectsAsync } from '../../../packages/daemon/src/lib/neo/project-mirror-async.ts';
import { delayedWorktree, syntheticCodex } from '../../../packages/daemon/tests/helpers/worktree-delay.ts';

const [mode, portText, runText] = process.argv.slice(2);
const port = Number(portText), run = resolve(runText);
assert(['reproduce', 'verify'].includes(mode));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'home'), { recursive: true });
const fixture = delayedWorktree(join(run, 'home'));
const adapter = syntheticCodex(join(run, 'home'), fixture.folder, fixture.project);
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/test.db') }), verbose: false });
const original = app.sessionManager.getOperationRegistry();
const find = createFindWorkOperation({
  adapters: () => [adapter], remote: { list: () => [], invoke: async () => null },
  mirrorProjects: (groups) => mirrorNeoWorkspaceProjectsAsync(app.db, groups).then(() => {}),
});
app.sessionManager.setOperationRegistryProvider(() => createOperationRegistry([
  ...original.entries.filter((entry) => entry.name !== 'work.find'), find,
]));
const probe = spawn(process.execPath, ['-e', `import { existsSync } from 'node:fs'; const ws=new WebSocket('ws://127.0.0.1:${port}/ws'); let at; ws.onopen=()=>{console.log('READY');const t=setInterval(()=>{if(existsSync(${JSON.stringify(fixture.marker)})){clearInterval(t);at=performance.now();ws.send(JSON.stringify({id:'health',type:'REQ',method:'system.health',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));}},1);}; ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.requestId==='health'){console.log(JSON.stringify({ms:performance.now()-at,data:r.data}));ws.close();}};`], { stdio: ['ignore','pipe','pipe'], env: process.env });
let output = '', errors = '';
probe.stdout.on('data', (data) => { output += data; });
probe.stderr.on('data', (data) => { errors += data; });
const exited = new Promise<number | null>((done) => probe.once('exit', done));
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
let previous = performance.now(), maxLagMs = 0;
const timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; },10);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
try {
  await fixture.ready;
  await new Promise<void>((done, fail) => { ws.onopen=()=>done(); ws.onerror=fail; });
  for(let i=0;!output.includes('READY')&&i<100;i++) await wait(20);
  assert(output.includes('READY'),errors);
  await wait(50);
  maxLagMs=0;
  const started = performance.now();
  const result = await new Promise<{places: {place:{folder:string};work:{ref:{id:string};place:{folder:string}}[]}[]}>((done,fail)=>{
    const timeout=setTimeout(()=>fail(new Error('find timed out')),15000);
    ws.onmessage=(event)=>{const r=JSON.parse(event.data.toString());if(r.requestId==='find'){clearTimeout(timeout);if(r.error)fail(new Error(JSON.stringify(r.error)));else done(r.data);}};
    ws.send(JSON.stringify({id:'find',type:'REQ',method:'operation.invoke',data:{name:'work.find',input:{localOnly:true,limit:20}},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));
  });
  const findMs=performance.now()-started;
  assert.equal(await fixture.closed,0);
  assert.equal(await exited,0,errors);
  await wait(20);
  assert.equal(result.places.length,1);
  assert.equal(result.places[0].place.folder,fixture.project);
  assert.equal(result.places[0].work[0].ref.id,'thread');
  assert.equal(result.places[0].work[0].place.folder,fixture.folder);
  const health=JSON.parse(output.trim().split('\n').at(-1)!);
  assert.equal(health.data.status,'ok');
  const report={mode,surface:'real isolated daemon work.find RPC + real Codex adapter and synthetic Codex SQLite state; external WebSocket health probe',fixture:'one .git FIFO, independently released 1400ms after reader opens it; owned temporary HOME/data only',maxLagMs,healthMs:health.ms,findMs,groups:result.places.length,worktree:fixture.folder,project:fixture.project};
  writeFileSync(join(run,'observed.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(mode==='verify'){assert(maxLagMs<250);assert(health.ms<250);}else{assert(maxLagMs>=1000);assert(health.ms>=1000);}
} finally {
  clearInterval(timer);ws.close();probe.kill();fixture.writer.kill();await app.cleanup();
}
