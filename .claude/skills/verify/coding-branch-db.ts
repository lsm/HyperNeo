import assert from 'node:assert/strict';
import { spawn as spawnChild, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '@hyperneo/shared';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readGithubBranchPrs } from '../../../packages/daemon/src/lib/neo/packs/coding/branch-prs.ts';
import { createCodingBranchPrReader } from '../../../packages/daemon/src/lib/neo/packs/coding/branch-reader.ts';
import { codingBranchWrites } from '../../../packages/daemon/src/lib/neo/packs/coding/branch-facts-db.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';

const [mode,directory]=process.argv.slice(2);
assert(['before','verify'].includes(mode));
const run=resolve(directory);
assert.equal(process.env.NODE_ENV,'test'); assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
assert(!existsSync(join(run,'data/daemon.db')));
for(const dir of ['home','data','bin','evidence']) mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const host=process.argv[4]?.startsWith('enterprise')?'ghe.example':'github.com',repo=host==='github.com'?'synthetic/ledger':`${host}/synthetic/ledger`;
const url=`https://${host}/synthetic/ledger/pull/7`;
writeFileSync(join(run,'phase'),'watch');writeFileSync(join(run,'late-release'),'waiting');
writeFileSync(join(run,'bin/gh'),`#!/usr/bin/env bun
import {appendFileSync,readFileSync} from 'node:fs';
const run=${JSON.stringify(run)},args=process.argv.slice(2);
appendFileSync(run+'/evidence/requests.jsonl',JSON.stringify({phase:readFileSync(run+'/phase','utf8'),args})+'\\n');
if(args[0]!=='pr'||args[1]!=='list'||!args.includes('--head'))process.exit(1);
if(args[args.indexOf('--head')+1]==='late'){appendFileSync(run+'/late-start','ready');while(!readFileSync(run+'/late-release','utf8').includes('release'))await new Promise(done=>setTimeout(done,10));}
await new Promise(done=>setTimeout(done,100));console.log(JSON.stringify([{url:${JSON.stringify(url)}}]));
`,{mode:0o700});
const checkout=(name:string)=>{
  const cwd=join(run,name);mkdirSync(cwd);
  execFileSync('git',['init','-b','feature'],{cwd,stdio:'pipe'});
  execFileSync('git',['remote','add','origin',`https://${host}${process.argv[4]==='enterprise-port'?':8443':''}/synthetic/ledger.git`],{cwd,stdio:'pipe'});
  return {cwd,branch:'feature'};
};
const queries=[checkout('one'),checkout('two')];
const evidence:Record<string,any>={host,repo,mode};
let measuring=false, maxLagMs=0, last=performance.now();
const mainSql:string[]=[],commands:string[]=[],rpcMetrics:{name:string;durationMs:number}[]=[];
let outstanding:Promise<unknown>|undefined;
const timer=setInterval(()=>{const t=performance.now();if(measuring)maxLagMs=Math.max(maxLagMs,t-last-10);last=t;},10);
let lock:ReturnType<typeof spawnChild>|undefined;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined;
const network=globalThis.fetch;
globalThis.fetch=(()=>{throw new Error('No real HTTP in synthetic proof');}) as typeof fetch;
async function open(){
  app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
  const db=app.db.getDatabase(),prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{if(measuring&&(/pack_coding_branch_facts/.test(sql)||sql==='SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?'))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
  const send=app.db.gateway.run.bind(app.db.gateway);
  app.db.gateway.run=(async(op,args)=>{const result=await send(op,args);if(op.name.startsWith('coding.branch.'))commands.push(op.name);return result;}) as typeof app.db.gateway.run;
  ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('connect'));});
}
const rpc=(name:string,input:unknown={},raw=false)=>new Promise<any>((done,fail)=>{
  const started=performance.now();
  const id=crypto.randomUUID(),timer=setTimeout(()=>fail(new Error(`RPC timed out: ${name}`)),15000);
  ws!.onmessage=event=>{const msg=JSON.parse(String(event.data));if(msg.id!==id&&msg.requestId!==id)return;clearTimeout(timer);if(measuring)rpcMetrics.push({name,durationMs:performance.now()-started});if(msg.error)fail(new Error(JSON.stringify(msg.error)));else done(msg.data);};
  ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:raw?name:'operation.invoke',data:raw?input:{name,input},timestamp:new Date().toISOString(),version:'1.0.0'}));
});
async function watch(){
  const db=app!.db.getDatabase();
  const job=db.prepare("SELECT id FROM job_queue WHERE queue='neo.work.driver.refresh' AND status='pending' ORDER BY run_at LIMIT 1").get() as {id:string}|null;
  assert(job,'Actual driver refresh must be scheduled');await app!.jobQueue.reschedulePending(job.id,Date.now());
  await app!.jobProcessor.start();
  for(let i=0;i<150;i++){
    const row=db.prepare('SELECT status FROM job_queue WHERE id=?').get(job.id) as {status:string}|null;
    if(row?.status==='completed')break;
    if(i===149)throw new Error('Actual driver refresh did not complete');
    await new Promise(done=>setTimeout(done,100));
  }
  await app!.jobProcessor.stop();
  return db.prepare('SELECT status FROM job_queue WHERE id=?').get(job.id);
}
try{
  await open();
  app!.db.getDatabase().prepare("UPDATE neo_pack_preferences SET value_json = ? WHERE pack = 'coding' AND key = 'watchedRepos'").run(JSON.stringify([repo]));
  const root=await rpc('neo.open');assert(root.sessionId);
  for(const [i,q] of queries.entries()){
    const at=new Date().toISOString();
    await app!.db.createSession({id:`synthetic-worker-${i}`,title:`Branch worker ${i}`,workspacePath:q.cwd,createdAt:at,lastActiveAt:at,status:'active',config:{model:'claude-sonnet-4-5-20250929',maxTokens:8192,temperature:1},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0},worktree:{isWorktree:true,worktreePath:q.cwd,mainRepoPath:q.cwd,branch:q.branch}} as Session);
  }
  measuring=true;
  evidence.work=await rpc('work.find',{localOnly:true,limit:30});
  evidence.worker=await rpc('work.status',{ref:{adapter:'hyperneo',id:'synthetic-worker-0'}});
  evidence.watch=await watch();
  evidence.snapshot=await rpc('neo.snapshot');
  measuring=false;
  evidence.fact=new CodingPrLedgerRepository(app!.db.getDatabase()).branchFacts.read(repo,'feature');
  assert.equal(evidence.fact.membership.status,'known','The real session watcher must collect branch coverage');
  assert.deepEqual(evidence.fact.membership.urls,[url]);
  const read=createCodingBranchPrReader(()=>app!.db.getDatabase());
  measuring=true;
  assert.deepEqual(await read(checkout('three')),[url]);
  measuring=false;
  writeFileSync(join(run,'phase'),'legacy');
  evidence.legacy=await Promise.all(queries.map(q=>readGithubBranchPrs(q)));
  writeFileSync(join(run,'phase'),'reopen');ws!.close();await app!.cleanup();app=undefined;
  await open();measuring=true;evidence.reopenedWatch=await watch();
  measuring=false;
  evidence.reopenedFact=new CodingPrLedgerRepository(app!.db.getDatabase()).branchFacts.read(repo,'feature');
  assert.deepEqual(evidence.reopenedFact,evidence.fact);
  const requests=readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  evidence.requests=requests;
  evidence.counts=Object.fromEntries(['watch','legacy','reopen'].map(phase=>[phase,requests.filter(row=>row.phase===phase&&row.args[0]==='pr').length]));
  assert.deepEqual(evidence.counts,{watch:1,legacy:2,reopen:0});
  if(mode==='verify'){
    measuring=true;writeFileSync(join(run,'phase'),'fenced');
    const facts=new CodingPrLedgerRepository(app!.db.getDatabase()).branchFacts;
    const late=facts.refresh(repo,'late');outstanding=late;
    const until=Date.now()+5000;
    while(!existsSync(join(run,'late-start'))){assert(Date.now()<until,'synthetic collection started');await new Promise(done=>setTimeout(done,10));}
    const changed=url.replace('/7','/8');
    const winner=await app!.db.gateway.call(codingBranchWrites,'observe',repo,'late',0,{urls:[changed]},Date.now());
    writeFileSync(join(run,'late-release'),'release');
    const retained=await late;outstanding=undefined;
    assert.deepEqual(retained.membership,winner.membership);assert.equal(retained.observationRevision,1);
    evidence.revisionFence={observationRevision:retained.observationRevision,urls:retained.membership.status==='known'?retained.membership.urls:[]};
    writeFileSync(join(run,'phase'),'held');
    lock=spawnChild('/usr/bin/python3',['-c',"import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()",join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
    const released=new Promise<void>((done,fail)=>{lock!.once('error',fail);lock!.once('exit',code=>code===0?done():fail(new Error('synthetic writer failed')));});
    await new Promise<void>(done=>lock!.stdout!.once('data',()=>done()));
    const start=performance.now(),held=facts.refresh(repo,'held');
    await new Promise(done=>setTimeout(done,150));
    const healthStart=performance.now();await rpc('system.health',{},true);const healthMs=performance.now()-healthStart;
    assert.equal((await held).membership.status,'known');const writeMs=performance.now()-start;await released;lock=undefined;
    evidence.contention={healthMs,writeMs,affectedWriteUnder250ms:writeMs<250};assert(healthMs<250);assert(writeMs>1000);
    measuring=false;
  }
  evidence.rpcMetrics=rpcMetrics;
  evidence.mainSql=mainSql; evidence.commands=commands;evidence.maxLagMs=maxLagMs;
  if(mode==='before')assert(mainSql.length>0,'baseline must reproduce branch SQL on main');
  else {assert.equal(mainSql.length,0,'branch snapshot and fenced persistence must leave main');assert(commands.some(name=>name==='coding.branch.observe'));assert(maxLagMs<1000);}
  evidence.verified=true;
  console.log(JSON.stringify({verified:true,counts:evidence.counts,path:join(run,'evidence/coding-branch-db.json')}));
}finally{
  writeFileSync(join(run,'late-release'),'release');await outstanding?.catch(()=>{});
  if (existsSync(join(run,'evidence/requests.jsonl'))) evidence.requests=readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  writeFileSync(join(run,'evidence/coding-branch-db.json'),JSON.stringify(evidence,null,2));
  lock?.kill();clearInterval(timer);ws?.close();await app?.cleanup();globalThis.fetch=network;
}
