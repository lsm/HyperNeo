process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { CodingWorkFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/work-facts.ts';
import { codingWorkWrites } from '../../../packages/daemon/src/lib/neo/packs/coding/work-facts-db.ts';
import type { NeoWorkPr } from '../../../packages/shared/src/types/neo-snapshot.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const [mode,directory]=process.argv.slice(2);assert(['before','verify'].includes(mode));
const run=resolve(directory);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));
assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const dir of ['home','bin','evidence'])mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const original=readFileSync(fileURLToPath(new URL('./github-ledger-gh.ts',import.meta.url)),'utf8');
assert(original.includes("if (phase === 'failed')"));
const stub=original.replace("phase === 'changed' ? 'b'", "['changed','detail-failed','reopen'].includes(phase) ? 'b'")
  .replace("appendFileSync(join(root, 'evidence'", "if(family==='work-detail')await Bun.sleep(300);\nappendFileSync(join(root, 'evidence'")
  .replace("process.stderr.write('unsupported synthetic request'); process.exit(2);", "appendFileSync(join(root,'evidence','requests.jsonl'),JSON.stringify({phase,family:'unsupported',args})+String.fromCharCode(10));process.stderr.write('unsupported synthetic request');process.exit(2);")
  .replace('JSON.stringify({ phase, family, graphqlCost:', 'JSON.stringify({ phase, family, args, graphqlCost:')
  .replace("if (phase === 'failed')", "if (phase === 'failed' || (phase === 'detail-failed' && family === 'work-detail'))");
const gated=stub.replace("if(family==='work-detail')await Bun.sleep(300);", "if(phase==='late'&&family==='work-detail'){appendFileSync(join(root,'late-start'),'ready');while(readFileSync(join(root,'late-release'),'utf8')!=='release')await Bun.sleep(10);};if(family==='work-detail')await Bun.sleep(300);");
writeFileSync(join(run,'late-release'),'waiting');
const withCliReads = gated.replace(
  "if (args[0] === 'api' &&",
  `if (args[0] === 'pr' && args[1] === 'view' && args.includes('number,title,state')) {
  family = 'skill-pr';
  body = pr;
} else if (args[0] === 'issue' && args[1] === 'view') {
  family = 'skill-issue';
  body = {
    number: 3,
    title: 'Synthetic issue',
    state: 'CLOSED',
    url: 'https://github.com/synthetic/ledger/issues/3',
  };
} else if (args[0] === 'api' &&`
);
writeFileSync(join(run,'bin/gh'),withCliReads,{mode:0o700});
const execFileAsync = promisify(execFile);
const githubRead = async (kind: 'pr' | 'issue', readUrl: string) => {
  const result = await execFileAsync('gh', [kind, 'view', readUrl, '--json', 'number,title,state']);
  return JSON.parse(result.stdout);
};
const now=Date.now(),url='https://github.com/synthetic/ledger/pull/7';
const control=(phase:string)=>writeFileSync(join(run,'fixture.json'),JSON.stringify({phase,scenario:'head',now}));
control('initial');
const evidence:Record<string,any>={mode};
let measuring=false,maxLagMs=0,last=performance.now();
const mainSql:string[]=[],commands:string[]=[],readMetrics:{name:string;durationMs:number}[]=[];
const timer=setInterval(()=>{const t=performance.now();if(measuring)maxLagMs=Math.max(maxLagMs,t-last-10);last=t;},10);
let outstanding:Promise<unknown>|undefined,lock:ReturnType<typeof spawn>|undefined;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined;
const waiting=new Map<string,{done:(value:any)=>void,fail:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('No real HTTP in synthetic proof');}) as typeof fetch;
async function open(){
  app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
  await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
  const db=app.db.getDatabase(),prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{if(measuring&&(/pack_coding_work_facts/.test(sql)||(sql==='SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?'&&new Error().stack?.includes('/work-facts.ts'))))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
  const send=app.db.gateway.run.bind(app.db.gateway);
  app.db.gateway.run=(async(op,args)=>{const result=await send(op,args);if(op.name.startsWith('coding.work.'))commands.push(op.name);return result;}) as typeof app.db.gateway.run;
  ws=createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('connect'));});
  ws.onmessage=event=>{const msg=JSON.parse(String(event.data)),id=waiting.has(msg.requestId)?msg.requestId:msg.id,held=waiting.get(id);if(!held)return;waiting.delete(id);clearTimeout(held.timer);if(msg.error)held.fail(new Error(JSON.stringify(msg.error)));else held.done(msg.data);};
}
const read=(readUrl=url,raw=false)=>{
  if(!raw){
    const started=performance.now();
    return new CodingWorkFactsRepository(app!.db.getDatabase()).refresh(readUrl).then(fact=>{
      if(measuring)readMetrics.push({name:'coding.work.refresh',durationMs:performance.now()-started});
      return fact.view.status==='known'?fact.view.value:null;
    });
  }
  return new Promise<any>((done,fail)=>{
  const started=performance.now(),id=crypto.randomUUID(),timer=setTimeout(()=>{waiting.delete(id);fail(new Error('RPC timeout'));},15000);
  waiting.set(id,{done:(value)=>{if(measuring)readMetrics.push({name:'system.health',durationMs:performance.now()-started});done(value);},fail,timer});
  ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'system.health',data:{},timestamp:new Date().toISOString(),version:'1.0.0'}));
});
};
const requests=()=>readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const stored=()=>{const was=measuring;measuring=false;try{return app!.db.getDatabase().prepare('SELECT * FROM pack_coding_work_facts').get();}finally{measuring=was;}};
try{
  await open();
  control('skill');
  evidence.github={pr:await githubRead('pr',url),issue:await githubRead('issue','https://github.com/synthetic/ledger/issues/3')};
  assert.equal(evidence.github.pr.number,7);assert.equal(evidence.github.pr.state,'OPEN');
  assert.equal(evidence.github.issue.number,3);assert.equal(evidence.github.issue.state,'CLOSED');
  control('initial');measuring=true;evidence.fanout=await Promise.all(Array.from({length:5},()=>read()));
  for(const result of evidence.fanout){assert(result);assert.equal(result.url,url);assert.equal(result.state,'OPEN');assert.equal(result.checks,'passing');assert.equal(result.review,'approved');assert.deepEqual(result.blockers,['1 unresolved review thread']);assert.equal(result.title,'Synthetic shared fact');}
  evidence.initialRequests=requests();evidence.workLookups=evidence.initialRequests.filter((r:any)=>r.family==='work-detail').length;
  assert.equal(evidence.workLookups,1,'Concurrent work-fact reads must share one ledger acquisition');
  evidence.referenceLookups=evidence.initialRequests.filter((r:any)=>r.family==='ask-reference').length;
  assert.equal(evidence.referenceLookups,0,'PR URLs must not acquire a separate reference view');
  evidence.firstStored=stored();
  control('changed');evidence.changed=await read();assert.equal(evidence.changed.review,'none');assert.deepEqual(evidence.changed.blockers,['1 unresolved review thread']);
  evidence.changedStored=stored();
  control('detail-failed');evidence.failed=await read();assert.equal(evidence.failed,null);
  evidence.failedStored=stored();assert.equal(evidence.failedStored.value_json,evidence.changedStored.value_json);assert.equal(evidence.failedStored.reason,'failed');
  ws!.close();await app!.cleanup();app=undefined;control('reopen');await open();evidence.retained=stored();assert.equal(evidence.retained.value_json,evidence.failedStored.value_json);
  evidence.reopened=await read();assert.equal(evidence.reopened.review,'none');assert.deepEqual(evidence.reopened.blockers,['1 unresolved review thread']);evidence.reopenedStored=stored();assert.equal(evidence.reopenedStored.reason,null);
  evidence.requests=requests();evidence.counts=Object.fromEntries(['initial','changed','detail-failed','reopen'].map(phase=>[phase,evidence.requests.filter((r:any)=>r.phase===phase&&r.family==='work-detail').length]));
  assert.equal(evidence.requests.filter((r:any)=>r.family==='ask-reference'||r.family==='issue-reference').length,0);
  assert.equal(evidence.requests.filter((r:any)=>r.family==='skill-pr'||r.family==='skill-issue').length,2);
  assert.deepEqual(evidence.counts,{initial:1,changed:1,'detail-failed':1,reopen:1});
  if(mode==='verify'){
    control('late');const facts=new CodingWorkFactsRepository(app!.db.getDatabase());
    const snapshot=await facts.readCurrent(url);
    const pending=facts.refresh(url);outstanding=pending;
    const until=Date.now()+5000;while(!existsSync(join(run,'late-start'))){assert(Date.now()<until,'late work collector started');await new Promise(done=>setTimeout(done,10));}
    const value:NeoWorkPr={url,state:'OPEN',checks:'passing',review:'none',head:'c'.repeat(40)};
    const winner=await app!.db.gateway.call(codingWorkWrites,'observe',url,snapshot.observationRevision,value,Date.now());
    writeFileSync(join(run,'late-release'),'release');const late=await pending;outstanding=undefined;
    assert.deepEqual(late,winner);assert.equal(winner.observationRevision,snapshot.observationRevision+1);
    evidence.fence={before:snapshot.observationRevision,after:winner.observationRevision,winningValue:winner.view.status==='known'?winner.view.value:null};
    control('held');
    lock=spawn('/usr/bin/python3',['-c',"import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()",join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
    const released=new Promise<void>((done,fail)=>{lock!.once('error',fail);lock!.once('exit',code=>code===0?done():fail(new Error('synthetic writer failed')));});
    await new Promise<void>(done=>lock!.stdout!.once('data',()=>done()));
    const start=performance.now(),held=facts.refresh(url);outstanding=held;
    await new Promise(done=>setTimeout(done,400));
    const healthStart=performance.now();evidence.health=await read(url,true);const healthMs=performance.now()-healthStart;
    assert.equal((await held).view.status,'known');outstanding=undefined;const writeMs=performance.now()-start;await released;lock=undefined;
    evidence.contention={healthMs,writeMs,affectedWriteUnder250ms:writeMs<250};assert(healthMs<250);assert(writeMs>1000);
    assert.equal(mainSql.length,0,'work snapshots, admission, persistence and returned coverage must leave main');assert(commands.includes('coding.work.observe'));assert(maxLagMs<1000);
  }else assert(mainSql.length>0,'baseline must reproduce work SQL on main');
  evidence.mainSql=mainSql;evidence.commands=commands;evidence.readMetrics=readMetrics;evidence.maxLagMs=maxLagMs;evidence.verified=true;
  console.log(JSON.stringify({verified:true,counts:evidence.counts,path:join(run,'evidence/coding-work-db.json')}));
}finally{
  measuring=false;writeFileSync(join(run,'late-release'),'release');lock?.kill();await outstanding?.catch(()=>{});clearInterval(timer);
  evidence.mainSql=mainSql;evidence.commands=commands;evidence.readMetrics=readMetrics;evidence.maxLagMs=maxLagMs;
  if(existsSync(join(run,'evidence/requests.jsonl')))evidence.requests=requests();
  writeFileSync(join(run,'evidence/coding-work-db.json'),JSON.stringify(evidence,null,2));
  for(const held of waiting.values())clearTimeout(held.timer);waiting.clear();ws?.close();await app?.cleanup();globalThis.fetch=network;
}
