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
import type { DbOp } from '../../../packages/daemon/src/storage/db-gateway/db-op.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoAsk, NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';

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
const prepare=db.prepare.bind(db),replay=app.db.gateway.onChanges;
let record=false,mainSql=0,held=false,neoEvents=0;
const tables:string[]=[];
db.prepare=((sql:string)=>{if(record && /neo_todos|neo_asks|neo_questions|neo_todo_sessions|pack_coding_pr_claims/.test(sql)) mainSql++; return prepare(sql);}) as typeof db.prepare;
app.db.gateway.onChanges=changes=>{if(record) tables.push(...changes.map(change=>change.table)); replay(changes);};
const off=hub.onEvent('neo.changed',()=>{neoEvents++;});
type State={todo:NeoTodo|null;startNext:string|null;changed:boolean;records?:string[]};
type Claim={ok:false;reason:string;changed:boolean}|{ok:true;todo:NeoTodo;ask?:NeoAsk;target?:{ref?:{id:string}};changed:boolean;records?:string[]};
const runCommand=<T>(method:string,args:unknown[])=>app.db.gateway.run({name:'neo.todoRunnerWrites',mode:'write',run:()=>{throw new Error('Runner command must run in the writer worker');}} as DbOp<object,T>,{method,args});
const visible=(askId='ask')=>hub.request<{ok:true;entry:{todos:NeoTodo[]}}>('operation.invoke',{name:'neo.ask.read',input:{askId}});
const effects:{name:string;input?:Record<string,unknown>}[]=[];
const runner=createNeoTodoRunner({store,sessions,...{write:app.db.gateway.run.bind(app.db.gateway)},packs:()=>[],
  changed:()=>{effects.push({name:'changed'});},tell:async()=>{effects.push({name:'tell'});},
  invoke:async(_caller,name,input)=>{effects.push({name,input});return {kind:'completed',value:{ok:true,value:{delivered:true,ref:{adapter:'hyperneo',id:'synthetic-worker'}}}};}
});
const result:Record<string,unknown>={runtimeCallersMoved:true};
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); await transport.connect();
  const root='neo:10000000-0000-4000-8000-000000009040';
  await app.db.createSession({id:root,title:'Synthetic runner build',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
  new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
  store.openAsk({id:'ask',projectId:null,sessionId:root,originMessageId:null,title:'Ordered work',request:'Keep full work',createdAt:1,repo:'github.com/synthetic/base'});
  for(const id of ['state','claim']) {
    store.addTodo(id,'ask',{title:id,doneWhen:'Observed',check:null,instruction:'Continue work',named:null},1);
    sessions.create(id,{verb:'send',ref:{adapter:'hyperneo',id:'old-worker'}});
  }
  const text='Stored runner report 🦊\n'.repeat(20000).trim();
  prepare("UPDATE neo_todos SET state='doing',started_at=2,report=? WHERE id='state'").run(text);
  store.askQuestion('start','ask',{kind:'start',text:'Start?',startTodos:['state'],options:null,multiple:false,yesLabel:null,noLabel:null},2);
  const before=await visible();
  const sessionCount=()=>prepare('SELECT COUNT(*) AS n FROM sessions').get() as {n:number};
  const originalSessions=sessionCount();
  db.exec("CREATE TRIGGER refuse_stamp BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END");
  record=true;
  await assert.rejects(runner.recompute(store.getTodo('state')!,{},10,{state:'done',evidence:'Complete'}),/synthetic rollback/);
  record=false; assert.equal(tables.length,0); assert.deepEqual(await visible(),before);
  db.exec('DROP TRIGGER refuse_stamp'); result.verified=true;
} finally {
  if(held) db.exec('ROLLBACK'); off(); db.prepare=prepare; app.db.gateway.onChanges=replay;
  await transport.close(); await app.cleanup(); globalThis.fetch=network; result.resourcesStopped=true;
  writeFileSync(join(run,'evidence/todo-runner-activation.json'),JSON.stringify(result,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(result).replaceAll(run,'<synthetic-run>'));
