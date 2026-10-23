import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { startEventLoopLagLog } from '../../../packages/daemon/src/lib/event-loop-lag.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [mode,phase,directory]=process.argv.slice(2), run=resolve(directory);
assert(['reproduce','verify'].includes(mode));assert(['open','prepare'].includes(phase));
assert(run.startsWith('/private/tmp/hn-sqlite-phase-'));
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
assert.equal(process.env.HN_PHASE_DB,phase==='open'?join(run,'phase-open.db'):join(run,'data/daemon.db'));
assert.equal(process.env.HN_PHASE,phase);assert.equal(process.env.DYLD_INSERT_LIBRARIES,join(run,'delay.dylib'));
assert(!existsSync(join(run,'data')));
const options={slowThresholdMs:250,summaryIntervalMs:0,maxQueryGroups:50,summaryQueryLimit:10};
const report:Record<string,unknown>={mode,phase,runtime:Bun.version,syntheticOnly:true,nativeDelayMs:1400};
const events:unknown[]=[], diagnostics:unknown[]=[];
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined, probe:ReturnType<typeof spawn>|undefined;
let stop:(()=>void)|undefined;
let measuring=false;
const off=subscribeToStructuredLogs(event=>{if(measuring&&event.module==='hyperneo:daemon:sqlite.query')events.push(event);});
try{
  app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db'),workspaceRoot:run}),disableWorktrees:true,disableGoalProcessing:true,sqlQueryObservability:options},verbose:false});
  await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
  const db=app.db.getDatabase();
  const cached=db.prepare('SELECT ? AS cached_phase_bench');cached.get(219);
  let at=performance.now();for(let i=0;i<10000;i++)db.prepare('SELECT ? AS cached_phase_bench').get(219);
  const cachedMs=performance.now()-at;
  at=performance.now();for(let i=0;i<2000;i++)db.prepare(`SELECT ${i} AS uncached_phase_bench`).get();
  report.benchmark={cachedReads:10000,cachedMs,uncachedPrepares:2000,uncachedMs:performance.now()-at};
  app.messageHub.onRequest('verify.sqlite-phase',()=>{
    const start=performance.now();let value;
    if(phase==='prepare')value=db.prepare("SELECT 219 AS phase_prepare_probe, 'private-phase-literal' AS hidden").get();
    else{
      const opened=new Database(join(run,'phase-open.db'),{queryObservability:options});
      try{value=opened.prepare('SELECT 219 AS phase_open_probe').get();}finally{opened.close();}
    }
    report.callMs=performance.now()-start;
    return value;
  });
  stop=startEventLoopLagLog(()=>{},{onDiagnostic:record=>diagnostics.push(record)});
  await Bun.sleep(300);measuring=true;
  const url=`ws://127.0.0.1:${app.server.port}/ws`;
  probe=spawn(process.execPath,['-e',`const ws=new WebSocket(${JSON.stringify(url)});let at;ws.onopen=()=>{at=performance.now();ws.send(JSON.stringify({id:'phase',type:'REQ',method:'verify.sqlite-phase',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));};ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.requestId!=='phase')return;if(r.error)throw Error(JSON.stringify(r.error));console.log(JSON.stringify({ms:performance.now()-at,data:r.data}));ws.close();};setTimeout(()=>process.exit(2),30000).unref();`],{env:process.env,stdio:['ignore','pipe','pipe']});
  let output='',errors='';probe.stdout!.on('data',d=>{output+=String(d);});probe.stderr!.on('data',d=>{errors+=String(d);});
  const exited=await new Promise((done,fail)=>{probe!.once('exit',done);probe!.once('error',fail);});assert.equal(exited,0,errors);
  await Bun.sleep(300);measuring=false;
  const response=JSON.parse(output.trim().split('\n').at(-1)!);report.rpc=response;report.events=events;report.diagnostics=diagnostics;
  assert.equal(response.data[phase==='prepare'?'phase_prepare_probe':'phase_open_probe'],219);
  assert(Number(report.callMs)>=1000);assert(response.ms>=1000);
  assert(diagnostics.some((d:unknown)=>Number((d as {lagMs?:number}).lagMs)>=1000));
  const phaseEvents=(events as {message:string;metadata:Record<string,unknown>}[]).filter(e=>e.message==='sqlite.phase.slow'&&e.metadata.operation===phase);
  report.matchingPhaseEvents=phaseEvents.length;
  assert(!JSON.stringify(events).includes('private-phase-literal'));
  assert(!JSON.stringify(events).includes(run));
  console.log(JSON.stringify({run,phase,callMs:report.callMs,rpcMs:response.ms,phaseEvents:phaseEvents.length,benchmark:report.benchmark}));
  if(mode==='verify'){assert.equal(phaseEvents.length,1);assert(Number(phaseEvents[0].metadata.durationMs)>=1000);assert.equal(phaseEvents[0].metadata.outcome,'ok');}
  else assert.equal(phaseEvents.length,0);
}finally{stop?.();probe?.kill();await app?.cleanup();off();writeFileSync(join(run,'observed.json'),JSON.stringify(report,null,2));}
