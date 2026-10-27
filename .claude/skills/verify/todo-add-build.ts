import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { Database as SQLite } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { DbGateway } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import type { DbOp } from '../../../packages/daemon/src/storage/db-gateway/db-op.ts';
import type { neoTodoAddWrites } from '../../../packages/daemon/src/storage/repositories/neo-todo-add-write.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoAsk, NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';

const [mode,directory]=process.argv.slice(2),run=resolve(directory);
assert.equal(mode,'verify');assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const path of ['workspace','bin','evidence'])mkdirSync(join(run,path),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
let record=false,mainSql=0;
const sqlitePrepare=SQLite.prototype.prepare,sqliteExec=SQLite.prototype.exec;
const targetSql=/neo_asks|neo_todos|neo_questions|neo_todo_sessions|neo_session_bindings/;
SQLite.prototype.prepare=function(...args){
 const statement=Reflect.apply(sqlitePrepare,this,args);
 if(!targetSql.test(args[0]))return statement;
 return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...values:unknown[])=>{
  if(record&&['get','all','iterate','run','values'].includes(String(key))){mainSql++;throw new Error('Todo add SQL executed on daemon main');}
  return Reflect.apply(value,target,values);
 };}});
};
SQLite.prototype.exec=function(sql:string){if(record&&targetSql.test(sql)){mainSql++;throw new Error('Todo add SQL executed on daemon main');}return Reflect.apply(sqliteExec,this,[sql]);};
const path=join(run,'data/daemon.db');
const app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:path}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});assert.notEqual(app.server.port,8399);
const hub=new MessageHub({defaultSessionId:'global'}),transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);
const db=app.db.getDatabase(),store=new NeoAskTodoRepository(db),sessions=new NeoTodoSessionRepository(db);
type Input=Parameters<typeof neoTodoAddWrites.run>[1];type Receipt=ReturnType<typeof neoTodoAddWrites.run>;
const op={name:'neo.todoAddWrites',mode:'write',run:()=>{throw new Error('Todo add must execute in writer worker');}} as DbOp<Input,Receipt>;
const input=(id:string):Input=>({askId:'ask',todoId:id,now:123,split:false,draft:{title:id,check:{pack:'core',kind:'evidence',params:{path:'/synthetic/result'}},instruction:'Do the complete work',target:{verb:'start',adapter:'hyperneo'},named:null,start:false,priority:'high'}});
const call=(args:Input)=>app.db.gateway.run(op,args);
const visible=()=>hub.request<{ok:boolean;entry:{ask:NeoAsk;todos:NeoTodo[];questions:unknown[]}}>('operation.invoke',{name:'neo.ask.read',input:{askId:'ask'}});
const replay=app.db.gateway.onChanges;let held=false;const tables:string[]=[];
app.db.gateway.onChanges=events=>{if(record)tables.push(...events.map(event=>event.table));replay(events);};
const result:Record<string,unknown>={runtimeCallersMoved:false};const ghosts:DbGateway[]=[];
let lastTick=performance.now(),maxLagMs=0;const lag=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-lastTick-10);lastTick=now;},10);
try{
 await app.spaceRuntimeService.ready();await app.jobProcessor.stop();await transport.initialize();
 const root='neo:todo-add-build';
 await app.db.createSession({id:root,title:'Synthetic todo add',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 store.openAsk({id:'ask',projectId:null,sessionId:root,originMessageId:null,title:'Build whole todo add',request:'Preserve work',createdAt:1});
 const cached=db.prepare('SELECT COUNT(*) AS count FROM neo_todos');cached.get();record=true;assert.throws(()=>cached.get(),/Todo add SQL executed on daemon main/);record=false;assert.equal(mainSql,1);mainSql=0;result.cachedSqlGuardVerified=true;
 const before=await visible();
 db.exec("CREATE TRIGGER refuse_start BEFORE INSERT ON neo_questions BEGIN SELECT RAISE(ABORT,'synthetic late add rollback'); END");
 record=true;await assert.rejects(call(input('rollback')),/synthetic late add rollback/);record=false;
 assert.equal(tables.length,0);assert.deepEqual(await visible(),before);assert.equal(sessions.get('rollback'),null);db.exec('DROP TRIGGER refuse_start');result.rollbackAtomic=true;
 const text='完整工作 🦊\n'.repeat(20000),args=input('held');args.draft.instruction=text;
 db.exec('BEGIN IMMEDIATE');held=true;record=true;let replied=false,error:unknown;const sent=performance.now();const pending=call(args);void pending.then(()=>{replied=true;},caught=>{error=caught;replied=true;});
 await new Promise(done=>setTimeout(done,1200));if(error)throw error;assert.equal(replied,false);assert.equal(tables.length,0);assert.deepEqual(await visible(),before);
 const healthStart=performance.now();await hub.request('system.health',{});const healthMs=performance.now()-healthStart;
 db.exec('ROLLBACK');held=false;const receipt=await pending;const affectedMs=performance.now()-sent;record=false;
 assert(receipt.ok && receipt.todo);assert.equal(receipt.todo.instruction,text);assert.equal(receipt.todo.state,'blocked');assert.equal(receipt.todo.priority,'high');assert.equal(sessions.get('held')?.verb,'start');
 const card=await visible();assert.equal(card.entry.todos[0].instruction,text);assert(tables.includes('neo_questions'));assert.equal(store.listQuestions('ask').length,1);
 result.fullInstruction={bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(card.entry.todos[0].instruction!).digest('hex')};result.commitBeforeReply=true;
 result.contention={affectedMs,targetMs:250,targetMet:affectedMs<250,healthMs,maxLagMs};assert(affectedMs>=1200);assert(healthMs<250);assert(maxLagMs<1000);
 record=true;const raced=await Promise.all([call(input('one')),call(input('two'))]);record=false;assert(raced.every(item=>item.ok));
 assert.deepEqual(store.listQuestions('ask').map(card=>card.startTodos),[['held','one','two']]);result.concurrentQuestionMembership=true;
 const start=input('start');start.draft.start=true;record=true;const intent=await call(start);record=false;assert(intent.ok && intent.start==='start');assert.equal(store.listQuestions('ask')[0].startTodos?.includes('start'),false);result.dispatchDeferred=true;
 const bound=input('bound');bound.draft.target={verb:'bind',ref:{adapter:'hyperneo',id:'existing-worker'}};record=true;const bind=await call(bound);record=false;assert(bind.ok && bind.todo?.state==='doing');assert.deepEqual(sessions.readRef('bound'),{adapter:'hyperneo',id:'existing-worker'});result.bindAtomic=true;
 const count=tables.length;const invalid=input('invalid');invalid.draft.check={pack:'missing',kind:'unknown',params:{}};record=true;const rejected=await call(invalid);record=false;assert(!rejected.ok);assert.equal(tables.length,count);assert.equal(store.getTodo('invalid'),null);result.refusalQuiet=true;
 record=true;await assert.rejects(call(args),/UNIQUE constraint/);record=false;assert.equal(tables.length,count);assert.equal(store.listTodos('ask').filter(todo=>todo.id==='held').length,1);result.noReplayDuplicateId=true;
 const ghost=(phase:'before'|'after')=>{
  const gateway=new DbGateway(path,null,undefined,()=>{
   const raw=new Worker(new URL('../../../packages/daemon/src/storage/db-gateway/db-gateway-worker.ts',import.meta.url).toString(),{type:'module'});
   const proxy={onmessage:null as ((event:MessageEvent)=>void)|null,onerror:null as ((event:ErrorEvent)=>void)|null,postMessage:(request:unknown)=>{if(phase==='before'){raw.terminate();queueMicrotask(()=>proxy.onerror?.({message:'synthetic worker failed before dispatch',preventDefault(){}} as ErrorEvent));}else raw.postMessage(request);},terminate:()=>raw.terminate()};
   raw.onmessage=event=>{if(phase==='after' && 'id' in event.data)return;proxy.onmessage?.(event);};raw.onerror=event=>proxy.onerror?.(event);return proxy as unknown as Worker;
  },1500);ghosts.push(gateway);return gateway;
 };
 record=true;await assert.rejects(ghost('before').run(op,input('before-death')),/synthetic worker failed before dispatch/);record=false;assert.equal(store.getTodo('before-death'),null);result.workerFailureNoFallback=true;
 record=true;await assert.rejects(ghost('after').run(op,input('lost')),/outcome unknown/);record=false;
 assert.equal((await visible()).entry.todos.filter(todo=>todo.id==='lost').length,1);
 record=true;await assert.rejects(call(input('lost')),/UNIQUE constraint/);record=false;
 assert.equal(store.listTodos('ask').filter(todo=>todo.id==='lost').length,1);result.lostReply={reported:'outcome unknown',persistedOnce:true,automaticReplay:false};
 assert.equal(mainSql,0);result.mainSql=mainSql;result.rssBytes=process.memoryUsage().rss;result.walBytes=statSync(`${path}-wal`).size;result.verified=true;
}finally{
 record=false;if(held)db.exec('ROLLBACK');clearInterval(lag);SQLite.prototype.prepare=sqlitePrepare;SQLite.prototype.exec=sqliteExec;app.db.gateway.onChanges=replay;
 await Promise.all(ghosts.map(gateway=>gateway.close()));await transport.close();await app.cleanup();globalThis.fetch=network;result.resourcesStopped=true;
 writeFileSync(join(run,'evidence/todo-add-build.json'),JSON.stringify(result,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(result).replaceAll(run,'<synthetic-run>'));
