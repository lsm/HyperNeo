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
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';

const [mode,directory]=process.argv.slice(2),run=resolve(directory);
assert.equal(mode,'verify'); assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.HOME,join(run,'home')); assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const path of ['workspace','bin','evidence'])mkdirSync(join(run,path),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch; globalThis.fetch=(()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
const app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false}); assert.notEqual(app.server.port,8399);
const hub=new MessageHub({defaultSessionId:'global'}),transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`});hub.registerTransport(transport);
const db=app.db.getDatabase(),store=new NeoAskTodoRepository(db),sessions=new NeoTodoSessionRepository(db);
const prepare=db.prepare.bind(db),read=NeoTodoSessionRepository.prototype.read,registry=app.sessionManager.getOperationRegistry();
let mainSql=0,watch=false,beforeRead=()=>{},beforeStop=()=>{};
const calls:string[]=[],refused=new Set<string>(),throwing=new Set<string>();
const report='Complete stop report 🦊\n'.repeat(20000).trim();
db.prepare=((sql:string)=>{if(watch && /neo_todos|neo_asks|neo_todo_sessions/.test(sql) && new Error().stack?.includes('/lib/neo/todo-runner.ts:')){mainSql++;throw new Error('Main-thread stop context SQL');}return prepare(sql);}) as typeof db.prepare;
NeoTodoSessionRepository.prototype.read=(function(method:string,...args:unknown[]){if(method==='stopContext')beforeRead();return Reflect.apply(read,this,[method,...args]);}) as typeof read;
const scripted=createOperationRegistry(registry.entries.map(entry=>entry.name!=='work.stop'?entry:{...entry,execute:async(input)=>{
 const ref=(input as {ref:{id:string}}).ref;calls.push(ref.id); db.exec('BEGIN');db.exec('ROLLBACK');
 beforeStop();if(throwing.has(ref.id))throw new Error('Synthetic disconnected driver');
 if(refused.has(ref.id))return {ok:false,reason:'unsupported',detail:'Synthetic stop refusal'};
 await sessions.write('recordLive',ref.id.replace(/-replacement$/,''),'stopped');
 return {ok:true,value:{stopped:true}};
}}));
app.sessionManager.setOperationRegistryProvider(()=>scripted);
type Receipt={ok:false;reason:string}|{ok:true;todo:NeoTodo;records?:string[]};
const mutate=(kind:'close'|'remove',id:string)=>hub.request<Receipt>('operation.invoke',{name:`neo.todo.${kind}`,input:{todoId:id,reason:'Explicit human outcome'}});
const visible=(askId='ask')=>hub.request<{ok:true;entry:{todos:NeoTodo[]}}>('operation.invoke',{name:'neo.ask.read',input:{askId}});
const seed=(id:string,askId='ask')=>{
 store.addTodo(id,askId,{title:id,doneWhen:'Observed',check:null,instruction:null,named:null},1);
 store.updateTodo(store.getTodo(id)!,{state:'doing',report},2);
 sessions.create(id,{verb:'send',ref:{adapter:'hyperneo',id}});sessions.recordRef(id,{adapter:'hyperneo',id},2);
};
const card=(id:string)=>store.askQuestion(`${id}-card`,'ask',{kind:'reply',todoId:id,text:'Choose first',options:null,multiple:false,yesLabel:null,noLabel:null},4);
const result:Record<string,unknown>={surface:'Real close/remove RPC and Work-card reads; scripted work.stop boundary'};
try{
 await app.spaceRuntimeService.ready();await app.jobProcessor.stop();await transport.connect();
 const root='neo:10000000-0000-4000-8000-000000009077';
 await app.db.createSession({id:root,title:'Synthetic stop context',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 for(const id of ['ask','settled'])store.openAsk({id,projectId:null,sessionId:root,originMessageId:null,title:id,request:'Keep work',createdAt:1});
 seed('close');watch=true;const closed=await mutate('close','close');watch=false;
 assert(closed.ok && closed.todo.state==='closed_unverified');assert.equal(closed.todo.report,report);
 assert((await visible()).entry.todos.some(todo=>todo.id==='close' && todo.report===report));result.realClose=true;
 seed('remove');watch=true;const removed=await mutate('remove','remove');watch=false;
 assert(removed.ok && removed.todo.state==='removed');assert.equal(removed.todo.report,report);
 assert((await visible()).entry.todos.some(todo=>todo.id==='remove' && todo.state==='removed' && todo.report===report));result.realRemove=true;
 result.fullReport={bytes:Buffer.byteLength(report),sha256:createHash('sha256').update(report).digest('hex')};
 for(const kind of ['close','remove'] as const){
  const id=`failed-${kind}`;seed(id);throwing.add(id);const before=await visible();watch=true;const failed=await mutate(kind,id);watch=false;
  assert(!failed.ok && failed.reason.includes('stop_failed:') && failed.reason.includes('Synthetic disconnected driver'));assert.deepEqual(await visible(),before);
 }
 result.stopFailurePreservesCards=true;
 seed('unsupported');refused.add('unsupported');assert((await mutate('remove','unsupported')).ok);result.unsupportedNoop=true;
 seed('adopted');sessions.bind('adopted',{adapter:'hyperneo',id:'adopted'},3);const prior=calls.length;
 assert((await mutate('remove','adopted')).ok);assert.equal(calls.length,prior);result.adoptedExempt=true;
 seed('replacement');let replaced=false;
 beforeRead=()=>{if(!replaced){replaced=true;sessions.recordRef('replacement',{adapter:'hyperneo',id:'replacement-replacement'},4);}};
 assert((await mutate('remove','replacement')).ok);beforeRead=()=>{};
 assert.equal(calls.at(-1),'replacement-replacement');result.currentReplacement=true;
 seed('late-card');beforeStop=()=>{card('late-card');};const late=await mutate('close','late-card');beforeStop=()=>{};
 assert(!late.ok && late.reason.startsWith('card_unanswered:'));assert.equal(store.getTodo('late-card')!.state,'doing');assert.equal(store.getTodo('late-card')!.report,report);result.lateCardRefusesClose=true;
 seed('needs-human');card('needs-human');store.updateTodo(store.getTodo('needs-human')!,{state:'blocked',blockedBy:'needs-human',blockedReason:'Answer first'},5);
 const refresh=()=>app.db.gateway.call(neoTodoRunnerWrites,'recompute','needs-human',null,{},20,{state:'no_opinion'});
 assert.equal((await refresh()).todo!.blockedBy,'needs-human');
 store.retireQuestion(store.getQuestion('needs-human-card')!,'Human no longer needs it',null,21);
 assert.notEqual((await refresh()).todo!.blockedBy,'needs-human');result.needsHumanPreserved=true;
 seed('settled-work','settled');store.settleAsk(store.getAsk('settled')!,'done','Settled',30);const settled=await visible('settled'),count=calls.length;
 for(const kind of ['close','remove'] as const){const noop=await mutate(kind,'settled-work');assert(noop.ok && noop.records?.some(line=>line.startsWith('ask_settled:')));}
 assert.deepEqual(await visible('settled'),settled);assert.equal(calls.length,count);result.settledNoops=true;
 assert.equal(mainSql,0);result.stopMainSql=mainSql;result.driverOutsideTransaction=true;result.verified=true;
}finally{
 watch=false;db.prepare=prepare;NeoTodoSessionRepository.prototype.read=read;
 await transport.close();await app.cleanup();globalThis.fetch=network;result.resourcesStopped=true;result.mainSql=mainSql;result.stopCalls=calls;
 writeFileSync(join(run,'evidence/todo-stop-context.json'),JSON.stringify(result,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(result).replaceAll(run,'<synthetic-run>'));
