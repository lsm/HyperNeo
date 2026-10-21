import { strict as assert } from 'node:assert';
import { mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { startEventLoopWatchdog } from '../../../packages/daemon/src/lib/event-loop-watchdog.ts';

const [mode, portText, runText] = process.argv.slice(2);
const run = resolve(runText), port = Number(portText);
assert(['reproduce','verify','sample'].includes(mode));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
assert.equal(process.env.HN_CHECKPOINT_DB,join(run,'worker.db'));
assert(process.env.DYLD_INSERT_LIBRARIES?.startsWith(run+'/'));
assert(!existsSync(join(run,'data')));
mkdirSync(join(run,'home'),{recursive:true});
const keeper = new Database(join(run,'worker.db'));
keeper.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES(219)');
const watchdog = mode === 'sample' ? await startEventLoopWatchdog({ stackPath: join(run,'stack'), killMode:'observe' }) : null;
const app = await createDaemonApp({config:getConfig({host:'127.0.0.1',port,dbPath:join(run,'data/daemon.db')}),verbose:false});
const entry = join(run,'worker.ts');
writeFileSync(entry, `import {parentPort,workerData} from 'node:worker_threads'; import {Database} from ${JSON.stringify(mode === 'sample' ? 'bun:sqlite' : new URL('../../../packages/daemon/src/storage/sqlite-compat.ts',import.meta.url).href)};
const db=new Database(workerData.path); const retained=db.prepare('SELECT value FROM proof'); retained.get(); db.close(); globalThis.retained=retained; let usable=true; try{retained.get();}catch{usable=false;} parentPort.postMessage({usable});`);
let queryMs=0;
app.messageHub.onRequest('verify.sqlite-probe',()=>{
 const started=performance.now(); const result=app.db.getDatabase().prepare('SELECT 7966 AS checkpointProof').get(); queryMs=performance.now()-started;return result;
});
const go=join(run,'probe-go');
const probe=spawn(process.execPath,['-e',`import {existsSync} from 'node:fs';const ws=new WebSocket('ws://127.0.0.1:${port}/ws');let at;ws.onopen=()=>{console.log('READY');const t=setInterval(()=>{if(existsSync(${JSON.stringify(go)})){clearInterval(t);at=performance.now();ws.send(JSON.stringify({id:'probe',type:'REQ',method:'verify.sqlite-probe',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));}},1);};ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.requestId==='probe'){console.log(JSON.stringify({ms:performance.now()-at,data:r.data}));ws.close();}};`],{env:process.env,stdio:['ignore','pipe','pipe']});
let output='',errors='';probe.stdout.on('data',d=>{output+=d;});probe.stderr.on('data',d=>{errors+=d;});
const exited=new Promise<number|null>((done,fail)=>{probe.once('exit',done);probe.once('error',fail);});
const wait=(ms:number)=>new Promise(done=>setTimeout(done,ms));
let last=performance.now(),maxLagMs=0;
const heartbeat=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-last-10);last=now;},10);
let worker:Worker|undefined;
let fallback:ReturnType<typeof setTimeout>|undefined;
try{
 for(let i=0;!output.includes('READY')&&i<100;i++)await wait(20);
 assert(output.includes('READY'),errors);
 await wait(50);maxLagMs=0;
 worker=new Worker(entry,{workerData:{path:join(run,'worker.db')}});
 const receipt=await new Promise<{usable:boolean}>((done,fail)=>{worker!.once('message',done);worker!.once('error',fail);});
 const terminateAt=Date.now();
 const stopped=worker.terminate();
 fallback=setTimeout(()=>writeFileSync(go,'probe'),150);
 await stopped;clearTimeout(fallback);writeFileSync(go,'probe');
 assert.equal(await exited,0,errors);const recoveredAt=Date.now();await wait(mode === 'sample' ? 1600 : 30);
 const response=JSON.parse(output.trim().split('\n').at(-1)!);
 assert.deepEqual(response.data,{checkpointProof:7966});
 assert.deepEqual(keeper.prepare('SELECT value FROM proof').get(),{value:219});
 const checkpointTriggered=existsSync(join(run,'checkpoint-start'));
 const profiles=readdirSync(run).filter(name=>name.startsWith('stack.native-'));
 if(mode==='sample'){assert(profiles.length>0);assert(profiles.some(name=>{const at=Number(name.match(/native-(\d+)/)?.[1]);return at>=terminateAt&&at<recoveredAt&&readFileSync(join(run,name),'utf8').includes('Call graph');}));}
 const report={mode,runtime:Bun.version,profiles,terminateAt,recoveredAt,fixture:'isolated daemon RPC; synthetic worker WAL DB; native checkpoint-only1800ms delay on its path; separate main DB prepare probes process-wide lock',checkpointTriggered,retainedStatementUsableAfterClose:receipt.usable,maxLagMs,queryMs,rpcMs:response.ms};
 writeFileSync(join(run,'observed.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 if(mode==='verify'){assert(!receipt.usable);assert(!checkpointTriggered);assert(maxLagMs<250);assert(queryMs<250);assert(response.ms<250);}else{assert(receipt.usable);assert(checkpointTriggered);assert(maxLagMs>=1000);assert(queryMs>=1000);assert(response.ms>=1000);}
}finally{watchdog?.stop();clearInterval(heartbeat);if(fallback)clearTimeout(fallback);probe.kill();await worker?.terminate();keeper.close();await app.cleanup();}
