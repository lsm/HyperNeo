import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { neoTodoRunnerWrites } from '../../../packages/daemon/src/storage/repositories/neo-todo-runner-state.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoAsk, NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';

const [mode,directory]=process.argv.slice(2),run=resolve(directory);
assert.equal(mode,'verify');assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const path of ['workspace','bin','evidence'])mkdirSync(join(run,path),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
const app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});assert.notEqual(app.server.port,8399);
const hub=new MessageHub({defaultSessionId:'global'}),transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`});hub.registerTransport(transport);
const db=app.db.getDatabase(),store=new NeoAskTodoRepository(db),sessions=new NeoTodoSessionRepository(db),gateway=app.db.gateway;
const prepare=db.prepare.bind(db),call=gateway.call.bind(gateway),replay=gateway.onChanges,registry=app.sessionManager.getOperationRegistry();
const root='neo:10000000-0000-4000-8000-000000009078',report='Full settlement activation report 🦊\n'.repeat(15000).trim();
let watch=false,held=false,mainSql=0,notices=0,tableEvents=0,lockNext=false,reached=()=>{},beforeWrite=(_method:string,_args:unknown[])=>{},onStop=async(_id:string)=>{};
const calls:string[]=[],commands:string[]=[],refused=new Set<string>();
db.prepare=((sql:string)=>{if(watch && /neo_asks|neo_todos|neo_questions|neo_todo_sessions/.test(sql) && new Error().stack?.includes('/lib/neo/ask-record-operations.ts:')){mainSql++;throw new Error('Main-thread settlement SQL');}return prepare(sql);}) as typeof db.prepare;
gateway.call=(async(op,method,...args)=>{
 if(op.name==='neo.askSettlementWrites'){
  commands.push(method);const traced=watch;watch=false;try{beforeWrite(method,args);}finally{watch=traced;}
  if(lockNext){lockNext=false;db.exec('BEGIN IMMEDIATE');held=true;reached();}
 }
 return Reflect.apply(call,gateway,[op,method,...args]);
}) as typeof gateway.call;
gateway.onChanges=changes=>{tableEvents+=changes.filter(change=>['neo_asks','neo_todos','neo_questions'].includes(change.table)).length;replay(changes);};
const off=hub.onEvent('neo.changed',()=>{notices++;});
const scripted=createOperationRegistry(registry.entries.map(entry=>entry.name!=='work.stop'?entry:{...entry,execute:async(input)=>{
 const id=(input as {ref:{id:string}}).ref.id;calls.push(id);const traced=watch;watch=false;
 try{db.exec('BEGIN');db.exec('ROLLBACK');await onStop(id);if(refused.has(id))return {ok:false,reason:'busy',detail:'Synthetic driver refusal'};
 await sessions.write('recordLive',id.replace(/-replacement$/,''),'stopped',undefined);return {ok:true,value:{stopped:true}};
 }finally{watch=traced;}
}}));app.sessionManager.setOperationRegistryProvider(()=>scripted);
const mcp=createOperationMcpHandler(scripted,()=>({sessionId:root,role:'neo'}));
type Receipt={ok:false;reason:string}|{ok:true;ask:NeoAsk;todos:NeoTodo[];records?:string[]};
const settle=(askId:string,status:'done'|'dropped'='done')=>hub.request<Receipt>('operation.invoke',{name:'neo.ask.settle',input:{askId,status,outcome:'Explicitly ended'}});
const visible=(askId:string)=>hub.request<{ok:true;entry:{ask:NeoAsk;todos:NeoTodo[];questions:unknown[];doneCount:number}}>('operation.invoke',{name:'neo.ask.read',input:{askId}});
const stable=async(askId:string)=>{const {entry}=await visible(askId);return {ask:entry.ask,todos:entry.todos.map(({id,state,report,reason,evidence})=>({id,state,report,reason,evidence})),questions:entry.questions};};
const ask=(id:string,parentId:string|null=null)=>store.openAsk({id,parentId,repo:parentId?'github.com/fixture/child':null,projectId:null,sessionId:root,originMessageId:null,title:id,request:'Keep full work',createdAt:1});
const seed=(id:string,askId:string,adopted=false)=>{
 store.addTodo(id,askId,{title:id,doneWhen:'Observed outcome',check:null,instruction:null,named:null},1);
 store.updateTodo(store.getTodo(id)!,{state:'doing',report,reason:'Prior diagnostic'},2);
 if(adopted)sessions.bind(id,{adapter:'hyperneo',id},2);else{sessions.create(id,{verb:'send',ref:{adapter:'hyperneo',id}});sessions.recordRef(id,{adapter:'hyperneo',id},2);}sessions.recordLive(id,'running',undefined);
};
const card=(id:string,askId:string,todoId:string|null)=>store.askQuestion(id,askId,{kind:'reply',...(todoId?{todoId}:{}),text:'Choose first',options:null,multiple:false,yesLabel:null,noLabel:null},3);
const split=async(id:string)=>{const result=await mcp({name:'neo.ask.open',input:{title:id,request:'Keep full work',todos:[]}});assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text) as Receipt;};
const result:Record<string,unknown>={surface:'Real WebSocket settle/Work-card RPCs and actual agent MCP handler; scripted work.stop boundary'};
try{
 await app.spaceRuntimeService.ready();await app.jobProcessor.stop();await transport.connect();
 await app.db.createSession({id:root,title:'Synthetic settlement activation',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 ask('atomic');seed('atomic-worker','atomic');card('atomic-card','atomic','atomic-worker');
 const before=await stable('atomic');db.exec("CREATE TRIGGER fail_atomic_card BEFORE UPDATE ON neo_questions WHEN OLD.ask_id='atomic' BEGIN SELECT RAISE(ABORT, 'synthetic late settlement rollback'); END");
 watch=true;await assert.rejects(settle('atomic'),/synthetic late settlement rollback/);watch=false;
 assert.deepEqual(await stable('atomic'),before);assert.equal(notices,0);assert.equal(tableEvents,0);db.exec('DROP TRIGGER fail_atomic_card');result.atomicRollback=true;
 const atWrite=new Promise<void>(resolve=>{reached=resolve;});lockNext=true;watch=true;
 let replied=false,error:unknown;const pending=settle('atomic');void pending.then(()=>{replied=true;},caught=>{replied=true;error=caught;});
 await Promise.race([atWrite,pending]);if(error)throw error;assert(held,'Settlement must reach the writer');
 await new Promise(resolve=>setTimeout(resolve,80));assert.equal(replied,false);assert.equal(notices,0);assert.equal(tableEvents,0);assert.deepEqual(await stable('atomic'),before);await hub.request('system.health',{});
 db.exec('ROLLBACK');held=false;const receipt=await pending;watch=false;assert(receipt.ok && receipt.ask.status==='done');assert(receipt.records?.[0].includes('todos_unfinished:'));assert.equal(receipt.todos[0].state,'closed_unverified');assert.equal(receipt.todos[0].report,report);assert(receipt.todos[0].reason?.includes('Prior diagnostic'));
 const after=await visible('atomic');assert.equal(after.entry.todos[0].report,report);assert.equal(after.entry.doneCount,0);assert.equal(store.getQuestion('atomic-card')!.state,'retired');assert.equal(store.getQuestion('atomic-card')!.answer,null);await hub.request('system.health',{});assert.equal(notices,1);assert(tableEvents>0);
 result.commitBeforeReply=true;result.notificationsAfterCommit=true;result.fullReport={bytes:Buffer.byteLength(report),sha256:createHash('sha256').update(report).digest('hex')};
 const prior=notices;assert(!(await settle('atomic')).ok);assert(!(await settle('missing')).ok);await hub.request('system.health',{});assert.equal(notices,prior);result.staleNoopsQuiet=true;
 for(const status of ['done','dropped'] as const){
  const id=`failed-${status}`;ask(id);seed(`${id}-one`,id);seed(`${id}-two`,id);refused.add(`${id}-two`);const before=await stable(id),n=notices,t=tableEvents;
  watch=true;const failure=await settle(id,status);watch=false;assert(!failure.ok && failure.reason.includes('Synthetic driver refusal') && failure.reason.includes(`stopped: ${id}-one`));assert.deepEqual(await stable(id),before);await hub.request('system.health',{});assert.equal(notices,n);assert.equal(tableEvents,t);
 }result.failedStopsLeaveAskOpen=true;
 ask('adopted');seed('adopted-worker','adopted',true);const count=calls.length;const adopted=await settle('adopted','dropped');assert(adopted.ok && adopted.todos[0].state==='removed');assert.equal(calls.length,count);result.adoptedExempt=true;
 ask('racing');seed('racing-one','racing');seed('racing-two','racing');let injected=false;
 onStop=async id=>{if(id==='racing-two' && !injected){injected=true;seed('racing-late','racing');sessions.recordRef('racing-one',{adapter:'hyperneo',id:'racing-one-replacement'},4);sessions.recordLive('racing-one','running',undefined);}};
 const raceCalls=calls.length;watch=true;const raced=await settle('racing');watch=false;onStop=async()=>{};
 assert(raced.ok && raced.todos.length===3 && raced.todos.every(todo=>todo.state==='closed_unverified' && todo.report===report));assert(raced.records?.[0].includes('racing-late'));assert.deepEqual(calls.slice(raceCalls),['racing-one','racing-two','racing-one-replacement','racing-late']);result.lateStartAndReplacementCleanup=true;
 ask('competing');seed('competing-worker','competing');beforeWrite=(method,args)=>{if(method==='settle' && (args[0] as {askId:string}).askId==='competing')store.settleAsk(store.getAsk('competing')!,'dropped','Other actor',8);};
 const n=notices;const competing=await settle('competing');beforeWrite=()=>{};assert(!competing.ok && competing.reason.includes('ask_settled:'));assert.equal(store.getAsk('competing')!.outcome,'Other actor');await hub.request('system.health',{});assert.equal(notices,n);result.competingCommitPreserved=true;
 ask('stop-race');seed('stop-race-worker','stop-race');refused.add('stop-race-worker');onStop=async id=>{if(id==='stop-race-worker')store.settleAsk(store.getAsk('stop-race')!,'dropped','Other actor ended it',9);};
 const stopRaceNotice=notices;const stopRace=await settle('stop-race');onStop=async()=>{};assert(!stopRace.ok && stopRace.reason==='ask_settled: this ask is dropped.');assert.equal(store.getAsk('stop-race')!.outcome,'Other actor ended it');await hub.request('system.health',{});assert.equal(notices,stopRaceNotice);result.concurrentStopFailureTruthful=true;
 ask('human');seed('human-worker','human');card('human-card','human','human-worker');store.updateTodo(store.getTodo('human-worker')!,{state:'blocked',blockedBy:'needs-human',blockedReason:'Choose'},4);
 const recompute=()=>gateway.call(neoTodoRunnerWrites,'recompute','human-worker',null,{},5,{state:'no_opinion'});
 assert.equal((await recompute()).todo!.blockedBy,'needs-human');store.retireQuestion(store.getQuestion('human-card')!,'Retired',null,6);assert.notEqual((await recompute()).todo!.blockedBy,'needs-human');
 card('pending-card','human','human-worker');store.questionAnswers.bind('pending-card','human-worker',{adapter:'hyperneo',id:'human-worker'});store.answerQuestion(store.getQuestion('pending-card')!,'yes','button',7);store.updateTodo(store.getTodo('human-worker')!,{state:'blocked',blockedBy:'needs-human',blockedReason:'Deliver answer'},8);assert.equal((await recompute()).todo!.blockedBy,'needs-human');
 const human=await settle('human');assert(human.ok && human.todos[0].state==='closed_unverified');result.needsHumanPreserved=true;
 ask('parent');ask('child','parent');seed('child-worker','child');card('child-card','child','child-worker');const child=await stable('child'),c=calls.length;
 const splitBefore=notices,commandBefore=commands.length;const parent=await split('parent');assert(parent.ok && parent.ask.status==='done');assert.deepEqual(await stable('child'),child);assert.equal(calls.length,c);assert(commands.slice(commandBefore).includes('splitParent'));await hub.request('system.health',{});assert.equal(notices,splitBefore+1);
 await split('parent');await hub.request('system.health',{});assert.equal(notices,splitBefore+1);result.splitParentChildIsolation=true;
 ask('root-race');ask('root-child','root-race');beforeWrite=(method,args)=>{if(method==='splitParent' && args[0]==='root-race')seed('late-root','root-race');};const rootNotice=notices;const rootRace=await split('root-race');beforeWrite=()=>{};assert(rootRace.ok && rootRace.ask.status==='open');assert.equal(store.getTodo('late-root')!.state,'doing');await hub.request('system.health',{});assert.equal(notices,rootNotice);result.splitRechecksRootWork=true;
 ask('split-competing');ask('split-peer','split-competing');beforeWrite=(method,args)=>{if(method==='splitParent' && args[0]==='split-competing')store.settleAsk(store.getAsk('split-competing')!,'dropped','Competing parent outcome',10);};const splitCompetingNotice=notices;const splitCompeting=await split('split-competing');beforeWrite=()=>{};assert(splitCompeting.ok && splitCompeting.ask.status==='dropped' && splitCompeting.ask.outcome==='Competing parent outcome');await hub.request('system.health',{});assert.equal(notices,splitCompetingNotice);result.splitConcurrentSettlementPreserved=true;
 ask('split-rollback');ask('rollback-child','split-rollback');card('parent-card','split-rollback',null);const splitState=await stable('split-rollback'),rollbackNotice=notices;db.exec("CREATE TRIGGER fail_parent_card BEFORE UPDATE ON neo_questions WHEN OLD.ask_id='split-rollback' BEGIN SELECT RAISE(ABORT, 'split rollback'); END");
 const failedSplit=await mcp({name:'neo.ask.open',input:{title:'split-rollback',request:'Keep full work',todos:[]}});assert(failedSplit.isError);assert.deepEqual(await stable('split-rollback'),splitState);db.exec('DROP TRIGGER fail_parent_card');await hub.request('system.health',{});assert.equal(notices,rollbackNotice);result.splitRollback=true;
 assert.equal(mainSql,0);result.settlementMainSql=mainSql;result.driverOutsideTransactions=true;result.verified=true;
}finally{
 watch=false;if(held)db.exec('ROLLBACK');off();db.prepare=prepare;gateway.call=call;gateway.onChanges=replay;await transport.close();await app.cleanup();globalThis.fetch=network;result.resourcesStopped=true;result.mainSql=mainSql;result.commands=commands;result.stopCalls=calls;
 writeFileSync(join(run,'evidence/ask-settlement-activation.json'),JSON.stringify(result,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(result).replaceAll(run,'<synthetic-run>'));
