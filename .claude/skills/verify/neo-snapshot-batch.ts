import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import {
  observeNeoSnapshotQueries,
  seedNeoSnapshotFixture,
} from '../../../packages/daemon/tests/helpers/neo-snapshot-fixture.ts';

const [mode, portText, directory] = process.argv.slice(2);
const port = Number(portText), run = resolve(directory);
assert(['reproduce', 'verify'].includes(mode));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'home'), { recursive: true });
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/snapshot.db') }),
  verbose: false,
});
seedNeoSnapshotFixture(app.db.getDatabase());
const marker = join(run, 'first-read'), go = join(run, 'start-burst');
const counter = observeNeoSnapshotQueries(app.db.getDatabase(), 4, () => writeFileSync(marker, 'go'));
const envelope = `{type:'REQ',sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}`;
const snapshotClient = `
import { existsSync } from 'node:fs';
const ws=new WebSocket('ws://127.0.0.1:${port}/ws'), results=[];
ws.onopen=()=>{console.log('READY');const timer=setInterval(()=>{
 if(!existsSync(${JSON.stringify(go)}))return; clearInterval(timer);
 for(let i=0;i<4;i++)ws.send(JSON.stringify({...${envelope},id:'s'+i,method:'operation.invoke',data:{name:'neo.snapshot',input:{}}}));
},1);};
ws.onmessage=event=>{const reply=JSON.parse(event.data);if(!reply.requestId?.startsWith('s'))return;
 if(reply.error)throw new Error(JSON.stringify(reply.error));
 const value=reply.data,todos=value.todoAsks.flatMap(entry=>entry.todos);
 results.push({asks:value.todoAsks.length,todos:todos.length,questions:value.todoAsks.flatMap(entry=>entry.questions).length,
 link:todos.find(todo=>todo.id==='todo-230')?.link,bytes:Buffer.byteLength(JSON.stringify(value))});
 if(results.length===4){console.log(JSON.stringify({results}));ws.close();process.exit(0);}
};`;
const healthClient = `
import { existsSync } from 'node:fs';
const ws=new WebSocket('ws://127.0.0.1:${port}/ws');let at;
ws.onopen=()=>{console.log('READY');const timer=setInterval(()=>{
 if(!existsSync(${JSON.stringify(marker)}))return;clearInterval(timer);at=performance.now();
 ws.send(JSON.stringify({...${envelope},id:'health',method:'system.health',data:{}}));
},1);};
ws.onmessage=event=>{const r=JSON.parse(event.data);if(r.requestId!=='health')return;
 console.log(JSON.stringify({ms:performance.now()-at,data:r.data}));ws.close();process.exit(0);};`;
function start(code: string) {
  const child = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { error += data; });
  const exited = new Promise<number | null>(done => child.once('exit', done));
  return { child, exited, output: () => output, error: () => error };
}
const reader = start(snapshotClient), probe = start(healthClient);
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
let previous = performance.now(), maxLagMs = 0;
const heartbeat = setInterval(() => {
  const now = performance.now();maxLagMs = Math.max(maxLagMs, now-previous-10);previous=now;
},10);
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  for(let i=0;i<200 && (!reader.output().includes('READY') || !probe.output().includes('READY'));i++)await wait(10);
  assert(reader.output().includes('READY'), reader.error());
  assert(probe.output().includes('READY'), probe.error());
  await wait(50);counter.reset();maxLagMs=0;previous=performance.now();
  const at=performance.now();writeFileSync(go,'go');
  await Promise.race([
    Promise.all([reader.exited,probe.exited]).then(codes => assert.deepEqual(codes,[0,0],reader.error()+probe.error())),
    new Promise((_,fail)=>{deadline=setTimeout(()=>fail(new Error('RPC proof timed out')),25000);}),
  ]);
  clearTimeout(deadline);await wait(50);
  const snapshots=JSON.parse(reader.output().trim().split('\n').at(-1)!).results;
  const health=JSON.parse(probe.output().trim().split('\n').at(-1)!);
  assert.equal(snapshots.length,4);
  for(const snapshot of snapshots) {
    assert.equal(snapshot.asks,50);assert.equal(snapshot.todos,231);assert.equal(snapshot.questions,mode === 'reproduce' ? 66 : 0);
    assert.equal(snapshot.link,'/session/synthetic-230');
  }
  assert.equal(health.data.status,'ok');
  const report={mode,surface:'real isolated daemon neo.snapshot operation.invoke RPC from external clients',
    fixture:'181 asks / top50 with231 todos and66 questions; four overlapping RPC reads; controlled4ms wait per child/link statement; no live rows/model/provider',
    snapshotBuilds:counter.queries.filter(q=>q.build).length,
    childLinkReads:counter.queries.filter(q=>q.child).length,totalReads:counter.queries.length,
    maxLagMs,healthMs:health.ms,burstMs:performance.now()-at,responseBytes:snapshots.map(s=>s.bytes)};
  writeFileSync(join(run,'observed.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  if(mode==='verify'){
    assert.equal(report.snapshotBuilds,1);assert.equal(report.childLinkReads,3);
    assert(maxLagMs<1000);assert(health.ms<250);
  } else {
    assert.equal(report.snapshotBuilds,4);assert.equal(report.childLinkReads,1324);
    assert(maxLagMs>=1000);assert(health.ms>=1000);
  }
} finally {
  clearTimeout(deadline);clearInterval(heartbeat);counter.restore();
  reader.child.kill();probe.child.kill();await app.cleanup();
}
