import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '@hyperneo/shared';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readGithubBranchPrs } from '../../../packages/daemon/src/lib/neo/packs/coding/branch-prs.ts';
import { createCodingBranchPrReader } from '../../../packages/daemon/src/lib/neo/packs/coding/branch-reader.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';

const run=resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV,'test'); assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
assert(!existsSync(join(run,'data/daemon.db')));
for(const dir of ['home','data','bin','evidence']) mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const host=process.argv[3]?.startsWith('enterprise')?'ghe.example':'github.com',repo=host==='github.com'?'synthetic/ledger':`${host}/synthetic/ledger`;
const url=`https://${host}/synthetic/ledger/pull/7`;
writeFileSync(join(run,'phase'),'watch');
writeFileSync(join(run,'bin/gh'),`#!/usr/bin/env bun
import {appendFileSync,readFileSync} from 'node:fs';
const run=${JSON.stringify(run)},args=process.argv.slice(2);
appendFileSync(run+'/evidence/requests.jsonl',JSON.stringify({phase:readFileSync(run+'/phase','utf8'),args})+'\\n');
if(args[0]!=='pr'||args[1]!=='list'||!args.includes('--head'))process.exit(1);
await Bun.sleep(100);console.log(JSON.stringify([{url:${JSON.stringify(url)}}]));
`,{mode:0o700});
const checkout=(name:string)=>{
  const cwd=join(run,name);mkdirSync(cwd);
  execFileSync('git',['init','-b','feature'],{cwd,stdio:'pipe'});
  execFileSync('git',['remote','add','origin',`https://${host}${process.argv[3]==='enterprise-port'?':8443':''}/synthetic/ledger.git`],{cwd,stdio:'pipe'});
  return {cwd,branch:'feature'};
};
const queries=[checkout('one'),checkout('two')];
const evidence:Record<string,any>={host,repo};
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined;
const network=globalThis.fetch;
globalThis.fetch=(()=>{throw new Error('No real HTTP in synthetic proof');}) as typeof fetch;
async function open(){
  app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
  await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
  ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('connect'));});
}
const rpc=(name:string,input:unknown={})=>new Promise<any>((done,fail)=>{
  const id=crypto.randomUUID(),timer=setTimeout(()=>fail(new Error(`RPC timed out: ${name}`)),15000);
  ws!.onmessage=event=>{const msg=JSON.parse(String(event.data));if(msg.id!==id&&msg.requestId!==id)return;clearTimeout(timer);if(msg.error)fail(new Error(JSON.stringify(msg.error)));else done(msg.data);};
  ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'operation.invoke',data:{name,input},timestamp:new Date().toISOString(),version:'1.0.0'}));
});
async function watch(){
  const db=app!.db.getDatabase();
  const job=db.prepare("SELECT id FROM job_queue WHERE queue='neo.work.driver.refresh' AND status='pending' ORDER BY run_at LIMIT 1").get() as {id:string}|null;
  assert(job,'Actual driver refresh must be scheduled');app!.jobQueue.reschedulePending(job.id,Date.now());
  await app!.jobProcessor.start();
  for(let i=0;i<150;i++){
    const row=db.prepare('SELECT status FROM job_queue WHERE id=?').get(job.id) as {status:string}|null;
    if(row?.status==='completed')break;
    if(i===149)throw new Error('Actual driver refresh did not complete');
    await Bun.sleep(100);
  }
  await app!.jobProcessor.stop();
  return db.prepare('SELECT status FROM job_queue WHERE id=?').get(job.id);
}
try{
  await open();const root=await rpc('neo.open');assert(root.sessionId);
  for(const [i,q] of queries.entries()){
    const at=new Date().toISOString();
    app!.db.createSession({id:`synthetic-worker-${i}`,title:`Branch worker ${i}`,workspacePath:q.cwd,createdAt:at,lastActiveAt:at,status:'active',config:{model:'claude-sonnet-4-5-20250929',maxTokens:8192,temperature:1},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0},worktree:{isWorktree:true,worktreePath:q.cwd,mainRepoPath:q.cwd,branch:q.branch}} as Session);
  }
  evidence.work=await rpc('work.find',{localOnly:true,limit:30});
  evidence.worker=await rpc('work.status',{ref:{adapter:'hyperneo',id:'synthetic-worker-0'}});
  evidence.watch=await watch();
  evidence.snapshot=await rpc('neo.snapshot');
  evidence.fact=new CodingPrLedgerRepository(app!.db.getDatabase()).branchFacts.read(repo,'feature');
  assert.equal(evidence.fact.membership.status,'known','The real session watcher must collect branch coverage');
  assert.deepEqual(evidence.fact.membership.urls,[url]);
  const read=createCodingBranchPrReader(()=>app!.db.getDatabase());
  assert.deepEqual(await read(checkout('three')),[url]);
  writeFileSync(join(run,'phase'),'legacy');
  evidence.legacy=await Promise.all(queries.map(q=>readGithubBranchPrs(q)));
  writeFileSync(join(run,'phase'),'reopen');ws!.close();await app!.cleanup();app=undefined;
  await open();evidence.reopenedWatch=await watch();
  evidence.reopenedFact=new CodingPrLedgerRepository(app!.db.getDatabase()).branchFacts.read(repo,'feature');
  assert.deepEqual(evidence.reopenedFact,evidence.fact);
  const requests=readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  evidence.requests=requests;
  evidence.counts=Object.fromEntries(['watch','legacy','reopen'].map(phase=>[phase,requests.filter(row=>row.phase===phase&&row.args[0]==='pr').length]));
  assert.deepEqual(evidence.counts,{watch:1,legacy:2,reopen:0});
  evidence.verified=true;
  console.log(JSON.stringify({verified:true,counts:evidence.counts,path:join(run,'evidence/branch-ledger.json')}));
}finally{
  if (existsSync(join(run,'evidence/requests.jsonl'))) evidence.requests=readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  writeFileSync(join(run,'evidence/branch-ledger.json'),JSON.stringify(evidence,null,2));
  ws?.close();await app?.cleanup();globalThis.fetch=network;
}
