import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { CodingAncestryFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/ancestry-facts.ts';
import { codingAncestryReads, codingAncestryWrites } from '../../../packages/daemon/src/lib/neo/packs/coding/ancestry-facts-db.ts';
import { CodingMergeFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/merge-facts.ts';
import { CodingDeliveryFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/delivery-facts.ts';

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
const family=args[0]==='pr'&&args[1]==='view'?(args.includes('state,mergeCommit')?'merge':'work'):args[0]==='api'&&args.some(a=>a.includes('/compare/'))?'ancestry':null;
appendFileSync(join(root,'evidence/requests.jsonl'),JSON.stringify({phase,family,args})+'\n');
if(!family){process.stderr.write('Unsupported synthetic request');process.exit(2);}
if(family==='work'){
 process.stdout.write(JSON.stringify({url:args[2],state:'MERGED',headRefOid:'d'.repeat(40),reviews:[],statusCheckRollup:[]}));
}else if(family==='merge'){
 const n=Number(args[2].split('/').at(-1));process.stdout.write(JSON.stringify({state:'MERGED',mergeCommit:{oid:String.fromCharCode(97+n-7).repeat(40)}}));
}else{
 if(phase==='late'){appendFileSync(join(root,'late-start'),'ready');while(readFileSync(join(root,'late-release'),'utf8')!=='release')await Bun.sleep(10);}
 await Bun.sleep(300);
 if(['failed','retained-failure','known','known-negative','reopen'].includes(phase)){process.stderr.write('Synthetic unavailable');process.exit(1);}
 process.stdout.write(JSON.stringify({status:phase==='partial'?'invalid':phase==='behind'?'behind':'ahead'}));
}
`,{mode:0o700});
const base=(number:number)=>String.fromCharCode(97+number-7).repeat(40);
const url=(number:number)=>`https://github.com/${repo}/pull/${number}`;
const subject=(number:number)=>({repo,baseOid:base(number),headOid:build});
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
 db.prepare=((sql:string)=>{if(measuring&&(/pack_coding_ancestry_facts/.test(sql)||(sql==='SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?'&&new Error().stack?.includes('/ancestry-facts.ts'))))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
 const send=app.db.gateway.run.bind(app.db.gateway);
 app.db.gateway.run=(async(op,args)=>{const start=performance.now(),value=await send(op,args);if(op.name.startsWith('coding.ancestry.')){commands.push(op.name);gatewayMetrics.push({operation:op.name,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value))});}return value;}) as typeof app.db.gateway.run;
 ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
 await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('connect'));});
 ws.onmessage=event=>{const msg=JSON.parse(String(event.data)),id=waiting.has(msg.requestId)?msg.requestId:msg.id,held=waiting.get(id);if(!held)return;waiting.delete(id);clearTimeout(held.timer);if(msg.error)held.fail(new Error(JSON.stringify(msg.error)));else held.done(msg.data);};
}
const qa={adapter:'human',id:'synthetic-qa'},write={adapter:'human',id:'synthetic-writer'},reviewer={adapter:'human',id:'synthetic-reviewer'};
const smoke=(number:number)=>({todoId:'synthetic-todo',url:url(number),head,smoke:{actor:{kind:'human',id:qa.id},ref:qa,mergeCommit:base(number),verdict:'pass',evidence:['synthetic containment proof'],build:{daemon:hostname(),commit:build}}});
const read=(number=7,raw=false)=>new Promise<any>((done,fail)=>{
 const start=performance.now(),id=crypto.randomUUID(),timer=setTimeout(()=>{waiting.delete(id);fail(new Error('RPC timeout'));},15000);
 waiting.set(id,{done:value=>{if(measuring)rpcMetrics.push({name:raw?'system.health':'neo.coding.smoke',durationMs:performance.now()-start});done(value);},fail,timer});
 ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:raw?'system.health':'operation.invoke',data:raw?{}:{name:'neo.coding.smoke',input:smoke(number)},timestamp:new Date().toISOString(),version:'1.0.0'}));
});
const fixture=<T>(run:()=>T)=>{const previous=measuring;measuring=false;try{return run();}finally{measuring=previous;}};
const row=(number:number)=>fixture(()=>app!.db.getDatabase().prepare('SELECT * FROM pack_coding_ancestry_facts WHERE repo=? AND base_oid=? AND head_oid=?').get(repo,base(number),build) as Record<string,any>);
const requests=()=>readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const count=(phase:string)=>requests().filter(r=>r.phase===phase&&r.family==='ancestry').length;
function seed(){
 const db=app!.db.getDatabase(),at=Date.now();
 db.prepare('INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('synthetic-ask','synthetic-session','Synthetic ancestry','Synthetic',at,at);
 db.prepare('INSERT INTO neo_todos(id,ask_id,position,title,done_when,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('synthetic-todo','synthetic-ask',0,'Synthetic ancestry','Synthetic containment',at,at);
 const merge=new CodingMergeFactsRepository(db),delivery=new CodingDeliveryFactsRepository(db);
 for(const number of [7,8,9,10,11]){
  assert(merge.record(repo,number,{value:{state:'MERGED',mergeCommit:base(number)},source:'synthetic'},at,0));
  delivery.recordGate('synthetic-todo',{url:url(number),head,acceptanceContract:'synthetic containment',write,reviewer,qa,evidence:['synthetic gate']});
  const assignment={url:url(number),head,acceptanceContract:'synthetic containment',newDispatch:true,write,actor:{kind:'human',id:qa.id},ref:qa};
  db.prepare("INSERT INTO pack_facts(todo_id,pack,key,value_json) VALUES(?,'coding',?,?)").run('synthetic-todo',`assignment:${url(number)}:${head}:qa`,JSON.stringify(assignment));
 }
}
const refused={accepted:false,reason:'running_build_must_contain_merge'};
try{
 await open();seed();measuring=true;
 evidence.fanout=await Promise.all(Array.from({length:5},()=>read()));for(const result of evidence.fanout)assert.deepEqual(result,{accepted:true});
 assert.equal(count('initial'),1);evidence.first=row(7);assert.equal(evidence.first.status,'ahead');
 control('known');evidence.known=await read();assert.deepEqual(evidence.known,{accepted:true});assert.equal(count('known'),0);
 ws!.close();await app!.cleanup();app=undefined;await open();control('reopen');
 evidence.reopened=await read();assert.deepEqual(evidence.reopened,{accepted:true});assert.equal(count('reopen'),0);assert.deepEqual(row(7),evidence.first);
 control('behind');evidence.behind=await read(8);assert.deepEqual(evidence.behind,refused);assert.equal(row(8).status,'behind');assert.equal(count('behind'),1);
 control('known-negative');assert.deepEqual(await read(8),refused);assert.equal(count('known-negative'),0);
 for(const phase of ['failed','partial']){control(phase);evidence[phase]=await read(9);assert.deepEqual(evidence[phase],refused);assert.equal(row(9).status,null);assert.equal(row(9).reason,phase==='failed'?'failed':'partial');assert.equal(count(phase),1);}
 control('recovered');evidence.recovered=await read(9);assert.deepEqual(evidence.recovered,{accepted:true});assert.equal(count('recovered'),1);
 fixture(()=>app!.db.getDatabase().prepare("UPDATE pack_coding_ancestry_facts SET reason='failed' WHERE repo=? AND base_oid=? AND head_oid=?").run(repo,base(7),build));
 control('retained-failure');assert.deepEqual(await read(),refused);evidence.retainedFailure=row(7);assert.equal(evidence.retainedFailure.status,evidence.first.status);assert.equal(evidence.retainedFailure.observed_at,evidence.first.observed_at);assert.equal(evidence.retainedFailure.reason,'failed');
 control('retained-recovered');assert.deepEqual(await read(),{accepted:true});
 evidence.counts=Object.fromEntries(['initial','known','reopen','behind','known-negative','failed','partial','recovered','retained-failure','retained-recovered'].map(phase=>[phase,count(phase)]));
 assert.deepEqual(evidence.counts,{initial:1,known:0,reopen:0,behind:1,'known-negative':0,failed:1,partial:1,recovered:1,'retained-failure':1,'retained-recovered':1});
 if(mode==='verify'){
  const facts=new CodingAncestryFactsRepository(app!.db.getDatabase()),snapshot=await app!.db.gateway.call(codingAncestryReads,'read',subject(10));
  control('late');const pending=facts.refresh(subject(10));outstanding=pending;
  const until=Date.now()+5000;while(!existsSync(join(run,'late-start'))){assert(Date.now()<until,'late ancestry collector started');await new Promise(done=>setTimeout(done,10));}
  const winner=await app!.db.gateway.call(codingAncestryWrites,'observe',subject(10),{status:'behind'},Date.now(),snapshot.observationRevision);
  writeFileSync(join(run,'late-release'),'release');assert.deepEqual(await pending,winner);outstanding=undefined;assert.equal(winner.observationRevision,snapshot.observationRevision+1);
  evidence.fence={before:snapshot.observationRevision,after:winner.observationRevision,ancestry:winner.ancestry};assert.deepEqual(await read(10),refused);assert.equal(count('late'),1);
  control('held');
  lock=spawn('/usr/bin/python3',['-c',"import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()",join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
  const released=new Promise<void>((done,fail)=>{lock!.once('error',fail);lock!.once('exit',code=>code===0?done():fail(new Error('synthetic writer failed')));});
  await new Promise<void>(done=>lock!.stdout!.once('data',()=>done()));
  const start=performance.now(),held=facts.refresh(subject(11));outstanding=held;await new Promise(done=>setTimeout(done,400));
  const healthStart=performance.now();evidence.health=await read(11,true);const healthMs=performance.now()-healthStart;
  assert.equal((await held).ancestry.status,'known');outstanding=undefined;const writeMs=performance.now()-start;await released;lock=undefined;
  evidence.contention={healthMs,writeMs,affectedWriteUnder250ms:writeMs<250};assert(healthMs<250);assert(writeMs>1000);assert.deepEqual(await read(11),{accepted:true});assert.equal(count('held'),1);
  assert.equal(mainSql.length,0,'ancestry snapshot, admission, persistence and returned coverage must leave main');assert(commands.includes('coding.ancestry.observe'));assert(maxLagMs<1000);
 }else assert(mainSql.length>0,'baseline must reproduce ancestry SQL on main');
 evidence.verified=true;console.log(JSON.stringify({verified:true,counts:evidence.counts}));
}finally{
 measuring=false;writeFileSync(join(run,'late-release'),'release');lock?.kill();await outstanding?.catch(()=>{});clearInterval(timer);
 evidence.mainSql=mainSql;evidence.commands=commands;evidence.rpcMetrics=rpcMetrics;evidence.gatewayMetrics=gatewayMetrics;evidence.maxLagMs=maxLagMs;
 if(existsSync(join(run,'evidence/requests.jsonl')))evidence.requests=requests();
 writeFileSync(join(run,'evidence/coding-ancestry-db.json'),JSON.stringify(evidence,null,2));
 for(const held of waiting.values())clearTimeout(held.timer);waiting.clear();ws?.close();await app?.cleanup();globalThis.fetch=network;
}
