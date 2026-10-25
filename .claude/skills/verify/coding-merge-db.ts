import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { codingMergeWrites } from '../../../packages/daemon/src/lib/neo/packs/coding/merge-facts-db.ts';
import { CodingMergeFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/merge-facts.ts';
import { CodingDeliveryFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/delivery-facts.ts';

import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../packages/daemon/src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-run-repository.ts';
import { WorkflowHookStateRepository } from '../../../packages/daemon/src/storage/repositories/workflow-hook-state-repository.ts';
import { SessionRepository } from '../../../packages/daemon/src/storage/repositories/session-repository.ts';


const [mode,directory]=process.argv.slice(2);assert(['before','verify'].includes(mode));
const run=resolve(directory),repo='synthetic/ledger',head='d'.repeat(40),build=BUILD_METADATA.commit;
assert.match(build,/^[0-9a-f]{40}$/);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));
assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const dir of ['home','bin','evidence'])mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
writeFileSync(join(run,'late-release'),'waiting');
writeFileSync(join(run,'bin/gh'),String.raw`#!/usr/bin/env bun
import {appendFileSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const root=dirname(dirname(process.argv[1])),args=process.argv.slice(2),phase=readFileSync(join(root,'phase'),'utf8');
const family=args[0]==='pr'&&args[1]==='view'?(args.includes('state,mergeCommit')?'merge':'work'):null;
appendFileSync(join(root,'evidence/requests.jsonl'),JSON.stringify({phase,family,args})+'\n');
if(!family){process.stderr.write('Unsupported synthetic request');process.exit(2);}
if(family==='work'){
 process.stdout.write(JSON.stringify({url:args[2],state:'MERGED',headRefOid:'d'.repeat(40),reviews:[],statusCheckRollup:[]}));
}else{
 if(phase==='late'){appendFileSync(join(root,'late-start'),'ready');while(readFileSync(join(root,'late-release'),'utf8')!=='release')await Bun.sleep(10);}
 await Bun.sleep(300);
 if(['failed','known','reopen','known-negative','task-known','task-failed'].includes(phase)){process.stderr.write('Synthetic unavailable');process.exit(1);}
 const state=['partial','task-partial'].includes(phase)?undefined:phase==='task-open'?'OPEN':phase==='closed'?'CLOSED':'MERGED';
 process.stdout.write(JSON.stringify({state,mergeCommit:phase==='no-commit'||state!=='MERGED'?null:{oid:'c'.repeat(40)}}));
}
`,{mode:0o700});
const merge='c'.repeat(40);
const url=(number:number)=>`https://github.com/${repo}/pull/${number}`;
const control=(phase:string)=>writeFileSync(join(run,'phase'),phase);
control('initial');
const evidence:Record<string,any>={mode,build};
let measuring=false,maxLagMs=0,last=performance.now();
const mainSql:string[]=[],commands:string[]=[],rpcMetrics:Record<string,unknown>[]=[],gatewayMetrics:Record<string,unknown>[]=[];
const timer=setInterval(()=>{const t=performance.now();if(measuring)maxLagMs=Math.max(maxLagMs,t-last-10);last=t;},10);
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined;
let outstanding:Promise<unknown>|undefined,lock:ReturnType<typeof spawn>|undefined;
const waiting=new Map<string,{done:(value:any)=>void;fail:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('No real HTTP in synthetic proof');}) as typeof fetch;
async function open(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
 await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const db=app.db.getDatabase(),prepare=db.prepare.bind(db);
 db.prepare=((sql:string)=>{if(measuring&&(/pack_coding_merge_facts/.test(sql)||(sql==='SELECT canonical FROM pack_coding_repo_aliases WHERE alias = ?'&&new Error().stack?.includes('/merge-facts.ts'))))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
 const send=app.db.gateway.run.bind(app.db.gateway);
 app.db.gateway.run=(async(op,args)=>{const start=performance.now(),value=await send(op,args);if(op.name.startsWith('coding.merge.')){commands.push(op.name);gatewayMetrics.push({operation:op.name,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value))});}return value;}) as typeof app.db.gateway.run;
 ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
 await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('connect'));});
 ws.onmessage=event=>{const msg=JSON.parse(String(event.data)),id=waiting.has(msg.requestId)?msg.requestId:msg.id,held=waiting.get(id);if(!held)return;waiting.delete(id);clearTimeout(held.timer);if(msg.error)held.fail(new Error(JSON.stringify(msg.error)));else held.done(msg.data);};
}
const qa={adapter:'human',id:'synthetic-qa'},write={adapter:'human',id:'synthetic-writer'},reviewer={adapter:'human',id:'synthetic-reviewer'};
const smoke=(number:number)=>({todoId:'synthetic-todo',url:url(number),head,smoke:{actor:{kind:'human',id:qa.id},ref:qa,mergeCommit:merge,verdict:'pass',evidence:['synthetic containment proof'],build:{daemon:hostname(),commit:build}}});
const read=(number=7,raw=false)=>new Promise<any>((done,fail)=>{
 const start=performance.now(),id=crypto.randomUUID(),timer=setTimeout(()=>{waiting.delete(id);fail(new Error('RPC timeout'));},15000);
 waiting.set(id,{done:value=>{if(measuring)rpcMetrics.push({name:raw?'system.health':'neo.coding.smoke',durationMs:performance.now()-start});done(value);},fail,timer});
 ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:raw?'system.health':'operation.invoke',data:raw?{}:{name:'neo.coding.smoke',input:smoke(number)},timestamp:new Date().toISOString(),version:'1.0.0'}));
});
const fixtureSql=<T>(run:()=>T)=>{const previous=measuring;measuring=false;try{return run();}finally{measuring=previous;}};
const row=(number:number)=>fixtureSql(()=>app!.db.getDatabase().prepare('SELECT * FROM pack_coding_merge_facts WHERE repo=? AND number=?').get(repo,number) as Record<string,any>);
const requests=()=>readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const count=(phase:string)=>requests().filter(r=>r.phase===phase&&r.family==='merge').length;
function seed(){
 const db=app!.db.getDatabase(),at=Date.now();
 db.prepare('INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('synthetic-ask','synthetic-session','Synthetic merge','Synthetic',at,at);
 db.prepare('INSERT INTO neo_todos(id,ask_id,position,title,done_when,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('synthetic-todo','synthetic-ask',0,'Synthetic merge','Synthetic containment',at,at);
 db.prepare('INSERT INTO pack_coding_ancestry_facts VALUES(?,?,?,?,?,?,?,?,?)').run(repo,merge,build,'ahead',1,1,at,at,null);
 const delivery=new CodingDeliveryFactsRepository(db);
 for(const number of [7,8,13,14]){
  delivery.recordGate('synthetic-todo',{url:url(number),head,acceptanceContract:'synthetic containment',write,reviewer,qa,evidence:['synthetic gate']});
  const assignment={url:url(number),head,acceptanceContract:'synthetic containment',newDispatch:true,write,actor:{kind:'human',id:qa.id},ref:qa};
  db.prepare("INSERT INTO pack_facts(todo_id,pack,key,value_json) VALUES(?,'coding',?,?)").run('synthetic-todo',`assignment:${url(number)}:${head}:qa`,JSON.stringify(assignment));
 }
}
const refused={accepted:false,reason:'matching_merge_commit_required'};
try{
 await open();seed();measuring=true;
 evidence.fanout=await Promise.all(Array.from({length:5},()=>read()));for(const result of evidence.fanout)assert.deepEqual(result,{accepted:true});
 assert.equal(count('initial'),1);evidence.first=row(7);assert.equal(JSON.parse(evidence.first.value_json).mergeCommit,merge);
 control('known');evidence.known=await read();assert.deepEqual(evidence.known,{accepted:true});assert.equal(count('known'),0);
 fixtureSql(()=>app!.db.getDatabase().prepare('UPDATE pack_coding_merge_facts SET observed_at=? WHERE repo=? AND number=7').run(Date.now()-180000,repo));
 const before=row(7);
 for(const phase of ['failed','partial']){control(phase);evidence[phase]=await read();assert.deepEqual(evidence[phase],refused);const saved=row(7);assert.equal(saved.value_json,before.value_json);assert.equal(saved.observed_at,before.observed_at);assert.equal(saved.reason,phase==='failed'?'failed':'partial');assert.equal(count(phase),1);}
 control('recovered');evidence.recovered=await read();assert.deepEqual(evidence.recovered,{accepted:true});const recovered=row(7);
 ws!.close();await app!.cleanup();app=undefined;await open();control('reopen');
 evidence.reopened=await read();assert.deepEqual(evidence.reopened,{accepted:true});assert.equal(count('reopen'),0);assert.deepEqual(row(7),recovered);
 control('closed');evidence.closed=await read(8);assert.deepEqual(evidence.closed,refused);assert.equal(JSON.parse(row(8).value_json).state,'CLOSED');assert.equal(count('closed'),1);
 control('known-negative');assert.deepEqual(await read(8),refused);assert.equal(count('known-negative'),0);
 const db=app.db.getDatabase(),tasks=new SpaceTaskRepository(db),sessions=new SessionRepository(db);
 const space=new SpaceRepository(db).createSpace({name:'Synthetic completion',slug:'synthetic-completion',workspacePath:join(run,'home')});
 const workflow=new SpaceWorkflowRepository(db).createWorkflow({spaceId:space.id,name:'Synthetic coding',nodes:[],templateName:'Coder-Only Workflow'});
 function taskFixture(number:number){
  const pinned=new SpaceWorkflowRunRepository(db).createPinnedRun({spaceId:space.id,workflowId:workflow.id,title:'Synthetic run',rawWorkflow:workflow});
  new WorkflowHookStateRepository(db).ensure(pinned.id,'__pr_ready_validated_identity__',{pr_url:`https://github.com/synthetic/ledger/pull/${number}`});
  const task=tasks.createTask({spaceId:space.id,title:'Synthetic task',status:'approved',workflowRunId:pinned.id});
  const sessionId=`synthetic:task:${task.id}:post-approval:worker`,at=new Date().toISOString();
  sessions.createSession({id:sessionId,title:'Synthetic worker',workspacePath:join(run,'home'),type:'worker',context:{spaceId:space.id,taskId:task.id},status:'active',createdAt:at,lastActiveAt:at,config:{model:'unregistered',maxTokens:8192,temperature:1},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}},{enforceWorkspaceOwnership:false});
  db.prepare('UPDATE space_tasks SET post_approval_session_id=? WHERE id=?').run(sessionId,task.id);
  const invoke=createOperationMcpHandler(()=>app!.sessionManager.getOperationRegistry(),()=>({sessionId,spaceId:space.id,role:'workflow_worker'}));
  return {id:task.id,complete:async()=>{const response=await invoke({name:'task.transition',input:{taskId:task.id,status:'done'}});assert(!response.isError,JSON.stringify(response));return JSON.parse(response.content[0].text);}};
 }

 control('task-known');const known=taskFixture(7);evidence.taskKnown=await known.complete();assert.equal(tasks.getTask(known.id)?.status,'done');assert.equal(count('task-known'),0);
 control('task-open');const openTask=taskFixture(9);evidence.taskOpen=await openTask.complete();assert.equal(tasks.getTask(openTask.id)?.status,'approved');assert.match(evidence.taskOpen.detail,/OPEN/);
 control('task-merged');const newlyMerged=taskFixture(9);evidence.taskMerged=await newlyMerged.complete();assert.equal(tasks.getTask(newlyMerged.id)?.status,'done');
 const wasClosed=taskFixture(8);evidence.taskWasClosed=await wasClosed.complete();assert.equal(tasks.getTask(wasClosed.id)?.status,'done');assert.equal(count('task-merged'),2);
 control('no-commit');evidence.noCommit=[];for(let i=0;i<2;i++){const task=taskFixture(12);evidence.noCommit.push(await task.complete());assert.equal(tasks.getTask(task.id)?.status,'done');}assert.equal(count('no-commit'),2);
 for(const [number,phase] of [[10,'task-failed'],[11,'task-partial']] as const){control(phase);const task=taskFixture(number);const result=await task.complete();assert.equal(tasks.getTask(task.id)?.status,'approved');assert.match(result.detail,/could not verify/);evidence[phase]=result;}
 control('task-recovered');const taskRecovered=taskFixture(11);evidence.taskRecovered=await taskRecovered.complete();assert.equal(tasks.getTask(taskRecovered.id)?.status,'done');
 evidence.counts=Object.fromEntries(['initial','known','failed','partial','recovered','reopen','closed','known-negative','task-known','task-open','task-merged','no-commit','task-failed','task-partial','task-recovered'].map(phase=>[phase,count(phase)]));
 assert.deepEqual(evidence.counts,{initial:1,known:0,failed:1,partial:1,recovered:1,reopen:0,closed:1,'known-negative':0,'task-known':0,'task-open':1,'task-merged':2,'no-commit':2,'task-failed':1,'task-partial':1,'task-recovered':1});
 if(mode==='verify'){
  const facts=new CodingMergeFactsRepository(app!.db.getDatabase()),snapshot=await facts.readCurrent(repo,13,Date.now(),120000);
  control('late');const pending=facts.refresh(repo,13);outstanding=pending;
  const until=Date.now()+5000;while(!existsSync(join(run,'late-start'))){assert(Date.now()<until,'late merge collector started');await new Promise(done=>setTimeout(done,10));}
  const winner=await app!.db.gateway.call(codingMergeWrites,'observe',repo,13,{value:{state:'CLOSED',mergeCommit:null},source:'synthetic-winner'},Date.now(),snapshot.observationRevision);
  assert(winner.accepted);writeFileSync(join(run,'late-release'),'release');assert.deepEqual(await pending,winner.facts);outstanding=undefined;assert.equal(winner.facts.observationRevision,snapshot.observationRevision+1);
  const loser=await facts.observeCurrent(repo,13,{reason:'failed'},Date.now(),snapshot.observationRevision);assert.equal(loser.accepted,false);assert.deepEqual(loser.facts,winner.facts);
  evidence.fence={before:snapshot.observationRevision,after:winner.facts.observationRevision,merge:winner.facts.merge,loserAccepted:loser.accepted};assert.deepEqual(await read(13),refused);assert.equal(count('late'),1);
  control('held');
  lock=spawn('/usr/bin/python3',['-c',"import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()",join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
  const released=new Promise<void>((done,fail)=>{lock!.once('error',fail);lock!.once('exit',code=>code===0?done():fail(new Error('synthetic writer failed')));});
  await new Promise<void>(done=>lock!.stdout!.once('data',()=>done()));
  const start=performance.now(),held=facts.refresh(repo,14);outstanding=held;await new Promise(done=>setTimeout(done,400));
  const healthStart=performance.now();evidence.health=await read(14,true);const healthMs=performance.now()-healthStart;
  assert.equal((await held).merge.status,'known');outstanding=undefined;const writeMs=performance.now()-start;await released;lock=undefined;
  evidence.contention={healthMs,writeMs,affectedWriteUnder250ms:writeMs<250};assert(healthMs<250);assert(writeMs>1000);assert.deepEqual(await read(14),{accepted:true});assert.equal(count('held'),1);
  assert.equal(mainSql.length,0,'merge snapshot, admission, persistence and returned coverage must leave main');assert(commands.includes('coding.merge.observe'));assert(maxLagMs<1000);
 }else assert(mainSql.length>0,'baseline must reproduce merge SQL on main');
 assert.equal(requests().filter(r=>!r.family).length,0,'No unsupported synthetic requests');
 evidence.verified=true;console.log(JSON.stringify({verified:true,counts:evidence.counts}));}finally{
 measuring=false;writeFileSync(join(run,'late-release'),'release');lock?.kill();await outstanding?.catch(()=>{});clearInterval(timer);
 evidence.mainSql=mainSql;evidence.commands=commands;evidence.rpcMetrics=rpcMetrics;evidence.gatewayMetrics=gatewayMetrics;evidence.maxLagMs=maxLagMs;
 if(existsSync(join(run,'evidence/requests.jsonl')))evidence.requests=requests();
 writeFileSync(join(run,'evidence/coding-merge-db.json'),JSON.stringify(evidence,null,2));
 for(const held of waiting.values())clearTimeout(held.timer);waiting.clear();ws?.close();await app?.cleanup();globalThis.fetch=network;
}
