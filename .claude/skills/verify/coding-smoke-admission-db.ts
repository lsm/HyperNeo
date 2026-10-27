import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { CodingAssignmentsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/assignments.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingDeliveryFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/delivery-facts.ts';
const [mode,directory]=process.argv.slice(2),run=resolve(directory);
assert(['before','verify'].includes(mode));assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const name of ['home','bin','evidence'])mkdirSync(join(run,name),{recursive:true});process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const url='https://github.com/synthetic/smoke/pull/7',head='a'.repeat(40),merge='c'.repeat(40),write={adapter:'fixture',id:'author'},ref={adapter:'fixture',id:'qa',daemon:'synthetic-qa'};
const actor={kind:'agent' as const,id:ref.id,harness:ref.adapter,model:'synthetic-model'},base={url,head,acceptanceContract:'artifact:contract',newDispatch:true as const,write};
const large='artifact:'+('甲乙🙂'.repeat(6000));
const smoke={actor,ref,verdict:'pass' as const,mergeCommit:merge,build:{daemon:hostname(),commit:BUILD_METADATA.commit},evidence:[large]};
const gate={url,head,acceptanceContract:base.acceptanceContract,write,qa:ref,reviewer:'bot',evidence:['artifact:qa']};
writeFileSync(join(run,'pr.json'),JSON.stringify({url,state:'MERGED',headRefOid:head,mergeCommit:{oid:merge},mergeStateStatus:'CLEAN',baseRefName:'dev',reviews:[{state:'APPROVED',commit:{oid:head},author:{login:'bot'}}],statusCheckRollup:[{state:'SUCCESS'}]}));
writeFileSync(join(run,'bin/gh'),`#!/bin/sh\nprintf '%s\\n' "$*" >> '${run}/evidence/gh.log'\nif [ "$1" = pr ] && [ "$2" = view ]; then cat '${run}/pr.json'; elif [ "$1" = api ]; then case "$2" in repos/synthetic/smoke/compare/*) printf '{"status":"ahead"}' ;; *) exit 1 ;; esac; else exit 1; fi\n`,{mode:0o700});
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,measuring=0,park=false,arrived:()=>void=()=>{},release:()=>void=()=>{};
const mainSql:string[]=[],commands:unknown[]=[],events:unknown[]=[];
const evidence:Record<string,any>={mode,verified:false,consumer:'Actual neo.coding.smoke public WebSocket RPC',limitation:'Synthetic GitHub merge/build containment and QA assignment; no real deployment, merge, model, browser or live daemon. Other coding SQL is outside this slice.'};
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
async function open(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const db=app.db.getDatabase(),prepare=db.prepare.bind(db),send=app.db.gateway.run.bind(app.db.gateway);
 db.prepare=((sql:string)=>{if(measuring&&/pack_facts|pack_coding_delivery_facts/.test(sql))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
 app.db.gateway.run=(async(op,args)=>{if(park&&op.name==='coding.smoke.commands'&&(args as {method:string}).method==='assignedRecord'){park=false;arrived();await new Promise<void>(done=>{release=done;});}const start=performance.now(),reply=await send(op,args);if(op.name.startsWith('coding.smoke.'))commands.push({name:op.name,method:(args as {method:string}).method,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(reply)??'null')});return reply;}) as typeof app.db.gateway.run;
}
async function record(value:Record<string,unknown>=smoke){
 const ws=new WebSocket(`ws://127.0.0.1:${app!.server.port}/ws`);measuring++;
 try{await new Promise<void>((done,fail)=>{ws.onopen=()=>done();ws.onerror=()=>fail(new Error('RPC connect failed'));});return await new Promise<any>((done,fail)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>fail(new Error('Smoke RPC timed out')),15000);ws.onmessage=event=>{const reply=JSON.parse(String(event.data));if(reply.id!==id&&reply.requestId!==id)return;clearTimeout(timer);if(reply.error)fail(new Error(JSON.stringify(reply.error)));else{events.push({verdict:value.verdict,result:reply.data});done(reply.data);}};ws.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'operation.invoke',data:{name:'neo.coding.smoke',input:{todoId:'todo',url,head,smoke:value}},timestamp:new Date().toISOString(),version:'1.0.0'}));});}finally{measuring--;ws.close();}
}
function fixture<T>(fn:()=>T):T{const prior=measuring;measuring=0;try{return fn();}finally{measuring=prior;}}
const stored=()=>fixture(()=>new CodingDeliveryFactsRepository(app!.db.getDatabase()).read('todo',url,head));
const ghCalls=()=>readFileSync(join(run,'evidence/gh.log'),'utf8').trim().split('\n').length;
try{
 await open();const db=app!.db.getDatabase();db.exec("INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES('ask','fixture','Smoke','Smoke',1,1);INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES('todo','ask',1,'Smoke','Observed','doing',1,1)");
 new CodingPrLedgerRepository(db).stageFacts.observeHead(url,head,Date.now());const assignments=new CodingAssignmentsRepository(db);assert(await assignments.recordLater('todo','review',{...base,bot:'bot'}));assert(await assignments.recordLater('todo','qa',{...base,ref,actor}));await new CodingDeliveryFactsRepository(db).write('recordGate','todo',gate);
 assert.deepEqual(await record(),{accepted:true});assert.deepEqual(stored()?.smoke,smoke);
 const calls=ghCalls();assert.deepEqual(await record({...smoke,ref:write,actor:{...actor,id:write.id}}),{accepted:false,reason:'stage_assignment_mismatch'});assert.equal(ghCalls(),calls,'Unassigned actor must refuse before deployment reads');
 assert.deepEqual(await record({...smoke,mergeCommit:'b'.repeat(40)}),{accepted:false,reason:'matching_merge_commit_required'});
 assert.deepEqual(await record({...smoke,build:{daemon:'absent',commit:BUILD_METADATA.commit}}),{accepted:false,reason:'running_build_must_contain_merge'});
 assert.deepEqual(await record({...smoke,verdict:'inapplicable',build:undefined}),{accepted:false,reason:'inapplicability_reason_required'});
 assert.deepEqual(await record({...smoke,verdict:'inapplicable',build:undefined,reason:'Synthetic docs-only explanation.'}),{accepted:true});
 assert.deepEqual(await record({...smoke,verdict:'fail'}),{accepted:true});const retained=stored();assert.equal(retained?.smoke?.verdict,'fail');
 await app!.cleanup();app=undefined;await open();assert.deepEqual(stored(),retained);assert.deepEqual(await record(),{accepted:true});
 if(mode==='verify'){
  const ready=new Promise<void>(done=>{arrived=done;});park=true;const pending=record({...smoke,verdict:'fail'});
  await Promise.race([ready,new Promise<never>((_,fail)=>setTimeout(()=>fail(new Error('Smoke command did not reach writer boundary')),5000))]);
  fixture(()=>app!.db.getDatabase().prepare("DELETE FROM pack_facts WHERE todo_id='todo' AND key LIKE '%:qa'").run());release();assert.deepEqual(await pending,{accepted:false,reason:'stage_assignment_mismatch'});assert.equal(stored()?.smoke?.verdict,'pass');
  assert(await new CodingAssignmentsRepository(app!.db.getDatabase()).recordLater('todo','qa',{...base,ref,actor}));
  const gateReady=new Promise<void>(done=>{arrived=done;});park=true;const missing=record({...smoke,verdict:'fail'});
  await Promise.race([gateReady,new Promise<never>((_,fail)=>setTimeout(()=>fail(new Error('Gate test did not reach writer boundary')),5000))]);fixture(()=>app!.db.getDatabase().prepare("DELETE FROM pack_coding_delivery_facts WHERE todo_id='todo'").run());release();assert.deepEqual(await missing,{accepted:false,reason:'matching_merge_gate_required'});assert.equal(stored(),null);
  assert.deepEqual(mainSql,[],'Smoke assignment, merge receipt and write SQL must leave main');
 }else assert(mainSql.length>0,'Baseline must reproduce smoke SQL on main');
 evidence.largeEvidenceBytes=Buffer.byteLength(large);evidence.largeEvidenceSha256=createHash('sha256').update(large).digest('hex');evidence.events=events;evidence.verified=true;
}finally{release();evidence.mainSql=mainSql;evidence.commands=commands;writeFileSync(join(run,'evidence/coding-smoke-admission-db.json'),JSON.stringify(evidence,null,2));await app?.cleanup();globalThis.fetch=network;}
