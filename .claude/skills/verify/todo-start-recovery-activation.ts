import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';

const [mode,directory]=process.argv.slice(2),run=resolve(directory);
assert.equal(mode,'verify'); assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.HOME,join(run,'home')); assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const path of ['workspace','bin','evidence']) mkdirSync(join(run,path),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch;
globalThis.fetch=(()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
const app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
assert.notEqual(app.server.port,8399);
const hub=new MessageHub({defaultSessionId:'global'}), transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`});
hub.registerTransport(transport);
const db=app.db.getDatabase(),store=new NeoAskTodoRepository(db),sessions=new NeoTodoSessionRepository(db);
const prepare=db.prepare.bind(db),replay=app.db.gateway.onChanges,read=sessions.read.bind(sessions);
let admission=false,mainSql=0,held=false,watchTables=false;
const tables:string[]=[],effects:string[]=[],notes:string[]=[],warnings:string[]=[],calls:string[]=[];
db.prepare=((sql:string)=>{if(admission && /neo_todos|neo_asks|neo_questions|neo_todo_sessions/.test(sql)) mainSql++; return prepare(sql);}) as typeof db.prepare;
app.db.gateway.onChanges=changes=>{if(watchTables) tables.push(...changes.map(change=>change.table)); replay(changes);};
const visible=()=>hub.request<{ok:true;entry:{todos:NeoTodo[]}}>('operation.invoke',{name:'neo.ask.read',input:{askId:'ask'}});
const runner=createNeoTodoRunner({store,sessions,write:async(op,args)=>{
  try { return await app.db.gateway.run(op,args); }
  finally { if((args as {method?:string}).method==='recover') admission=false; }
},packs:()=>[],changed:()=>{effects.push('changed');},
  tell:async(_ask,todo,note)=>{
    assert.equal(sessions.readStartInterrupted(todo.id),true);
    assert((await visible()).entry.todos.some(card=>card.id===todo.id && card.state===todo.state && card.report===todo.report));
    effects.push('tell'); notes.push(note);
  },
  invoke:async(_caller,name)=>{
    calls.push(name); assert.equal(name,'work.status','Recovery must never dispatch work');
    return {kind:'completed',value:{ok:true,value:{status:'running',lastActivityAt:4}}};
  }
});
const refresh=()=>runner.refresh((_message,error)=>{warnings.push(String(error));});
const result:Record<string,unknown>={runtimeRecoveryActivated:true};
const seed=(id:string)=>{
  store.addTodo(id,'ask',{title:id,doneWhen:'Observed',check:null,instruction:'Continue work',named:null},1);
  sessions.create(id,{verb:'start',adapter:'hyperneo',place:{machine:'synthetic',name:'Fixture',folder:join(run,'workspace')}});
  store.claimStart(store.getTodo(id)!,2);
};
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); await transport.connect();
  const root='neo:10000000-0000-4000-8000-000000009069';
  await app.db.createSession({id:root,title:'Synthetic recovery activation',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
  new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
  store.openAsk({id:'ask',projectId:null,sessionId:root,originMessageId:null,title:'Recover full work',request:'Keep full work',createdAt:1});
  seed('recover');
  const report='Complete recovery report 🦊\n'.repeat(20000).trim();
  prepare('UPDATE neo_todos SET report=? WHERE id=?').run(report,'recover');
  store.askQuestion('stale-start','ask',{kind:'start',text:'Start?',startTodos:['recover'],options:null,multiple:false,yesLabel:null,noLabel:null},3);
  const before=await visible();
  db.exec("CREATE TRIGGER refuse_stamp BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic recovery rollback'); END");
  admission=true; watchTables=true; await refresh(); admission=false; watchTables=false;
  assert(warnings.some(line=>line.includes('synthetic recovery rollback')));
  assert.equal(sessions.readStartInterrupted('recover'),false,'Refused recovery must not forbid retry');
  assert.deepEqual(await visible(),before); assert.deepEqual(effects,[]); assert.deepEqual(tables,[]);
  db.exec('DROP TRIGGER refuse_stamp'); warnings.length=0; result.rollbackPreservesFlagAndCard=true;
  db.exec('BEGIN IMMEDIATE'); held=true; admission=true; watchTables=true;
  let replied=false,error:unknown;
  const pending=refresh(); void pending.then(()=>{replied=true;},caught=>{error=caught;replied=true;});
  await new Promise(resolve=>setTimeout(resolve,80)); if(error) throw error;
  assert.equal(replied,false); assert.equal(tables.length,0); assert.deepEqual(effects,[]);
  assert.deepEqual(await visible(),before); await hub.request('system.health',{});
  db.exec('ROLLBACK'); held=false;
  await pending; admission=false; watchTables=false;
  assert.deepEqual(warnings,[]); assert.deepEqual(effects,['changed','tell']);
  assert((await visible()).entry.todos.some(todo=>todo.id==='recover' && todo.state==='failed' && todo.report===report));
  assert.equal(sessions.readStartInterrupted('recover'),true); assert(tables.includes('neo_todo_sessions'));
  assert(notes[0].includes('Start was interrupted')); result.commitBeforeReply=true; result.postCommitNotice=true;
  result.fullReport={bytes:Buffer.byteLength(report),sha256:createHash('sha256').update(report).digest('hex')};
  const prior=effects.length; await refresh(); await refresh(); assert.equal(effects.length,prior); result.repeatedRecoveryQuiet=true;
  const retry=await hub.request<{ok:boolean;reason:string}>('operation.invoke',{name:'neo.todo.retry',input:{todoId:'recover'}});
  assert(!retry.ok && retry.reason.startsWith('start_uncertain:')); result.retryWarnsOfUncertainStart=true;
  seed('late'); const stale=await read('unrecordedStarts'); assert(stale.includes('late'));
  sessions.recordRef('late',{adapter:'hyperneo',id:'bound-worker'},4);
  sessions.read=((method:string,...args:unknown[])=>method==='unrecordedStarts'?Promise.resolve(stale):Reflect.apply(read,sessions,[method,...args])) as typeof sessions.read;
  admission=true; await refresh(); admission=false; sessions.read=read;
  assert.equal(sessions.readStartInterrupted('late'),false); assert.equal(store.getTodo('late')!.state,'doing');
  assert.equal(notes.length,1); assert.deepEqual(warnings,[]); result.lateBindingPreserved=true;
  assert.equal(mainSql,0); result.recoveryAdmissionMainSql=mainSql; result.noDispatch=calls.every(name=>name==='work.status'); result.verified=true;
} finally {
  if(held) db.exec('ROLLBACK'); db.prepare=prepare; app.db.gateway.onChanges=replay; sessions.read=read;
  await transport.close(); await app.cleanup(); globalThis.fetch=network; result.resourcesStopped=true;
  writeFileSync(join(run,'evidence/todo-start-recovery-activation.json'),JSON.stringify(result,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(result).replaceAll(run,'<synthetic-run>'));
