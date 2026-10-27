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
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
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
const root='neo:todo-add-activation',registry=app.sessionManager.getOperationRegistry();
const mcp=createOperationMcpHandler(registry,()=>({sessionId:root,role:'neo'}));
type Receipt={ok:false;reason:string}|{ok:true;todo?:NeoTodo;todos:NeoTodo[];records?:string[]};
const input=(title:string)=>({askId:'ask',title,check:{pack:'core',kind:'evidence',params:{path:'/synthetic/result'}},instruction:'Do the complete work',target:{verb:'start',adapter:'hyperneo'},start:false,priority:'high'});
const add=(args:ReturnType<typeof input>)=>hub.request<Receipt>('operation.invoke',{name:'neo.todo.add',input:args});
const visible=()=>hub.request<{ok:boolean;entry:{ask:NeoAsk;todos:NeoTodo[];questions:{startTodos?:string[]}[]}}>('operation.invoke',{name:'neo.ask.read',input:{askId:'ask'}});
const replay=app.db.gateway.onChanges,runCommand=app.db.gateway.run.bind(app.db.gateway);let held=false,notices=0,commands=0,lockNext=false,reached=()=>{},failNext=false;
const tables:string[]=[];app.db.gateway.onChanges=events=>{tables.push(...events.map(event=>event.table));replay(events);};
app.db.gateway.run=(async(op,args)=>{if(op.name==='neo.todoAddWrites'){commands++;if(failNext){failNext=false;throw new Error('synthetic writer failure');}if(lockNext){lockNext=false;db.exec('BEGIN IMMEDIATE');held=true;reached();}}return runCommand(op,args);}) as typeof app.db.gateway.run;
const off=hub.onEvent('neo.changed',()=>{notices++;});
const result:Record<string,unknown>={surface:'Real todo-add WebSocket RPC plus ask-open agent MCP and public Work-card RPC'};
let lastTick=performance.now(),maxLagMs=0;const lag=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-lastTick-10);lastTick=now;},10);
try{
 await app.spaceRuntimeService.ready();await app.jobProcessor.stop();await transport.initialize();
 await app.db.createSession({id:root,title:'Synthetic todo-add activation',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 store.openAsk({id:'ask',projectId:null,sessionId:root,originMessageId:null,title:'Whole add activation',request:'Preserve work',createdAt:1});
 const before=await visible();const beforeNotices=notices;
 db.exec("CREATE TRIGGER refuse_start BEFORE INSERT ON neo_questions BEGIN SELECT RAISE(ABORT,'synthetic late add rollback'); END");
 await assert.rejects(add(input('rollback')),/synthetic late add rollback/);
 assert.deepEqual(await visible(),before,'Failed add must leave the public card unchanged');assert.equal(notices,beforeNotices,'Failed add must not announce a partial card');assert.equal(tables.length,0);
 db.exec('DROP TRIGGER refuse_start');result.publicRollbackAtomic=true;
 const cached=db.prepare('SELECT COUNT(*) AS count FROM neo_todos');cached.get();record=true;assert.throws(()=>cached.get(),/Todo add SQL executed on daemon main/);record=false;assert.equal(mainSql,1);mainSql=0;result.cachedSqlGuardVerified=true;
 const text='完整工作 🦊\n'.repeat(20000),args=input('held');args.instruction=text;const reachedWriter=new Promise<void>(done=>{reached=done;});lockNext=true;record=true;
 let replied=false,error:unknown;const sent=performance.now();const pending=add(args);void pending.then(()=>{replied=true;},caught=>{error=caught;replied=true;});
 await Promise.race([reachedWriter,pending.then(()=>{throw new Error('Writer command was bypassed');})]);
 await new Promise(done=>setTimeout(done,1200));if(error)throw error;assert.equal(replied,false);assert.equal(tables.length,0);assert.equal(notices,beforeNotices);assert.deepEqual(await visible(),before);
 const healthStart=performance.now();await hub.request('system.health',{});const healthMs=performance.now()-healthStart;
 db.exec('ROLLBACK');held=false;const receipt=await pending;const affectedMs=performance.now()-sent;record=false;
 assert(receipt.ok && receipt.todo);assert.equal(receipt.todo.instruction,text);assert.equal(receipt.todo.state,'blocked');assert.equal(receipt.todo.priority,'high');assert.equal(sessions.get(receipt.todo.id)?.verb,'start');
 const card=await visible();assert.equal(card.entry.todos[0].instruction,text);assert(tables.includes('neo_questions'));assert(notices>beforeNotices,'Committed add must refresh connected clients');
 result.fullInstruction={bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(card.entry.todos[0].instruction!).digest('hex')};result.commitBeforeReply=true;result.clientNotified=true;
 result.contention={affectedMs,targetMs:250,targetMet:affectedMs<250,healthMs,maxLagMs};assert(affectedMs>=1200);assert(healthMs<250);assert(maxLagMs<1000);
 record=true;const raced=await Promise.all([add(input('one')),add(input('two'))]);record=false;assert(raced.every(item=>item.ok));const after=await visible();assert.equal(after.entry.todos.length,3);assert.equal(after.entry.questions.length,1);assert.equal(after.entry.questions[0].startTodos?.length,3);result.concurrentMembership=true;
 const prior=await visible(),count=notices;failNext=true;record=true;await assert.rejects(add(input('failed writer')),/synthetic writer failure/);record=false;assert.deepEqual(await visible(),prior);assert.equal(notices,count);result.noMainFallback=true;
 const atCommands=commands;const opened=await mcp({name:'neo.ask.open',input:{title:'MCP creation',request:'Add through the same writer',todos:[{...input('MCP todo'),askId:undefined}]}});assert(!opened.isError,JSON.stringify(opened));const openedBody=JSON.parse(opened.content[0].text) as Receipt;assert(openedBody.ok,JSON.stringify(openedBody));assert(commands>atCommands,'Ask open must use the same add writer');assert.equal(openedBody.todos[0].state,'blocked');result.askOpenUsesWriter=true;
 assert.equal(mainSql,0);result.mainSql=mainSql;result.rssBytes=process.memoryUsage().rss;result.walBytes=statSync(`${path}-wal`).size;result.verified=true;
}finally{
 record=false;if(held)db.exec('ROLLBACK');clearInterval(lag);off();SQLite.prototype.prepare=sqlitePrepare;SQLite.prototype.exec=sqliteExec;app.db.gateway.onChanges=replay;app.db.gateway.run=runCommand;
 await transport.close();await app.cleanup();globalThis.fetch=network;result.resourcesStopped=true;
 writeFileSync(join(run,'evidence/todo-add-activation.json'),JSON.stringify(result,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(result).replaceAll(run,'<synthetic-run>'));
