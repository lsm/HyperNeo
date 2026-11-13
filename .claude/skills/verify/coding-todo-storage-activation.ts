process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { neoTodoRepository } from '../../../packages/daemon/src/lib/neo/pack-contract.ts';
import { neoTodoPolicies } from '../../../packages/daemon/src/lib/neo/packs/todo-policies.ts';
import { NeoAskTodoRepository, type NeoTodoStorageBoundary } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { SessionEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/session-event-subscription-repository.ts';
import { GitHubWatchInventory } from '../../../packages/daemon/src/lib/external-events/github/github-watch-inventory.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import type { DbOp } from '../../../packages/daemon/src/storage/db-gateway/db-op.ts';
import type { NeoAsk, NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run=resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const folder of ['workspace','bin','evidence','data'])mkdirSync(join(run,folder),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const root='neo:10000000-0000-4000-8000-000000000052',path=join(run,'data/daemon.db');
const seed=new Database(path);runMigrations(seed,()=>{});createTables(seed);
seed.exec("ALTER TABLE neo_todos ADD COLUMN repo TEXT;DELETE FROM migration_markers WHERE key='migration_492'");
const legacy:NeoTodoStorageBoundary={insert:(commit,[id,askId,draft,now])=>commit(id,askId,draft,now)};
const old=new NeoAskTodoRepository(seed,undefined,undefined,undefined,undefined,legacy);
const draft={title:'Historical',doneWhen:'Observed',check:null,named:null,instruction:null};
for(const [id,peers] of [['historical-zero',0],['historical-many',4]] as const){
 old.openAsk({id,title:id,request:'Keep historical association',sessionId:root,projectId:null,originMessageId:null,createdAt:1});seed.prepare('UPDATE neo_asks SET repo=? WHERE id=?').run('github.com/synthetic/history',id);
 old.addTodo(id,id,draft,1);
 for(let n=0;n<peers;n++){old.addTodo(`${id}-${n}`,id,draft,1);seed.prepare('UPDATE neo_todos SET repo=? WHERE id=?').run(`github.com/synthetic/peer-${n}`,`${id}-${n}`);}
}
seed.exec('DROP TABLE pack_coding_todos');seed.close();
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
const result:Record<string,unknown>={runtimeCutover:true,surface:'Actual MCP add/edit and public Work-card RPC, real DB reader/writer workers, watcher inventory and isolated daemon reopen'};
let expected:{id:string;repo:string|null}[]=[];
async function phase(reopen:boolean){
 const app=await createDaemonApp({config:getConfig({host:'127.0.0.1',port:0,dbPath:path}),verbose:false});
 const db=app.db.getDatabase(),store=new NeoAskTodoRepository(db),hub=new MessageHub({defaultSessionId:'global'});
 const transport=new WebSocketClientTransport({createSocket:createLocalSocket,url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);
 const command=<T>(name:string,mode:'read'|'write',args:unknown)=>app.db.gateway.run({name,mode,run:()=>{throw new Error('Command ran on main');}} as DbOp<unknown,T>,args);
 const method=<T>(name:string,mode:'read'|'write',method:string,args:unknown[])=>command<T>(name,mode,{method,args});
 const visible=()=>hub.request<{ok:true;entry:{ask:NeoAsk;todos:NeoTodo[]}}>('operation.invoke',{name:'neo.ask.read',input:{askId:'work'}});
 let held=false,recording=false,listeningForFact=false,committedFact=false,deliveredFact=false;const tables:string[]=[];
 const offFact=hub.onEvent('neo.changed',()=>{if(listeningForFact&&committedFact)deliveredFact=true;});const replay=app.db.gateway.onChanges;
 app.db.gateway.onChanges=changes=>{if(listeningForFact&&changes.some(change=>change.table==='pack_coding_todos'))committedFact=true;if(recording)tables.push(...changes.map(change=>change.table).filter(table=>['neo_asks','neo_todos','pack_coding_todos'].includes(table)));replay(changes);};
 try{
  assert.notEqual(app.server.port,8399);await app.spaceRuntimeService.ready();await app.jobProcessor.stop();await transport.connect();
  assert(db.prepare("SELECT name FROM sqlite_master WHERE name='pack_coding_todos'").get());
  for(const id of ['historical-zero','historical-many']){
   const todo=await method<NeoTodo>('neo.todoReads','read','getTodo',[id]);const ask=store.getAsk(id);
   assert.equal(neoTodoRepository(todo,neoTodoPolicies(db),{ask,todo}),'github.com/synthetic/history');
   assert.equal(db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get(id),null);
  }
  result.historicalFallbackPreserved=true;
  const recorded=(id:string)=>(db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get(id) as {repo:string|null}|null)?.repo??null;
  const cards=async()=>(await visible()).entry.todos.map(({id})=>({id,repo:recorded(id)})).sort((a,b)=>a.id.localeCompare(b.id));
  if(reopen){
   assert.deepEqual(await cards(),expected);
   result.reopenAndRepeatBackfill=true;return;
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pack_coding_todos').get() as {n:number}).n,4);
  assert(!(db.prepare('PRAGMA table_info(neo_todos)').all() as {name:string}[]).some(column=>column.name==='repo'));
  result.backfillBeforeFirstRead=true;result.legacyTodoColumnDropped=true;
  await app.db.createSession({id:root,title:'Synthetic repository activation',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
  new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
  store.openAsk({id:'work',title:'Multi-repository work',request:'Keep canonical facts',sessionId:root,projectId:null,originMessageId:null,createdAt:2});
  const mcp=createOperationMcpHandler(app.sessionManager.getOperationRegistry(),()=>({sessionId:root,role:'neo'}));
  const input=(title:string,repo?:string)=>({ after: [],askId:'work',title,check:{pack:'core',kind:'evidence',params:{}},...(repo?{named:{repository:repo}}:{})});
  const call=async(name:string,input:unknown)=>{const reply=await mcp({name,input});assert(!reply.isError,JSON.stringify(reply));const receipt=JSON.parse(reply.content[0].text);assert(receipt.ok,JSON.stringify(receipt));return receipt;};
  const first=(await call('neo.todo.add',input('First','synthetic/one'))).todo as NeoTodo;
  assert.equal(recorded(first.id),'github.com/synthetic/one');assert(!('repo' in first));
  const second=(await call('neo.todo.add',input('Inherit one'))).todo as NeoTodo;assert.equal(recorded(second.id),recorded(first.id));
  const third=(await call('neo.todo.add',input('Other','synthetic/two'))).todo as NeoTodo;assert.equal(recorded(third.id),'github.com/synthetic/two');
  const unknown=(await call('neo.todo.add',input('No guess'))).todo as NeoTodo;assert.equal(recorded(unknown.id),null);
  assert.deepEqual(db.prepare('SELECT repo FROM neo_asks WHERE id=?').get('work'),{repo:null});
  const reads=[
   await method<NeoTodo>('neo.todoReads','read','getTodo',[first.id]),
   (await method<{todos:NeoTodo[]}>('neo.askSettlementReads','read','snapshot',['work'])).todos.find(t=>t.id===first.id)!,
   (await method<{todo:NeoTodo}>('neo.todoMutationReads','read','plan',[{kind:'edit',todoId:first.id,title:'Updated'},10,[]])).todo,
   (await method<{todo:NeoTodo}>('neo.todoSessionReads','read','stopContext',[first.id])).todo,
   (await method<{todo:NeoTodo}>('neo.todoRunnerWrites','write','recompute',[first.id,first.check,{},10,{state:'no_opinion'}])).todo,
  ];assert(reads.every(todo=>todo.id===first.id&&!('repo' in todo)));assert.equal(neoTodoRepository(first,neoTodoPolicies(db),{ask:{id:'work'},todo:first}),recorded(first.id));
  const edited=await call('neo.todo.edit',{todoId:first.id,title:'Updated'});assert(!('repo' in edited.todo));assert.equal(recorded(first.id),'github.com/synthetic/one');
  assert(!('repo' in (await visible()).entry.todos.find(t=>t.id===first.id)!));
  result.publicReceiptsAndIndependentGatewayReaders=true;result.homogeneousInheritanceAndNoDualWrites=true;
  const watched=(await call('neo.todo.add',{ after: [],askId:'work',title:'Watch canonical',check:{pack:'coding',kind:'pr_merged',params:{urls:['https://github.com/synthetic/watch/pull/1']}}})).todo as NeoTodo;
  const inventory=new GitHubWatchInventory(db,new SessionEventSubscriptionRepository(db));assert(inventory.references('synthetic','watch'));assert(!inventory.references('synthetic','stale'));result.watcherUsesPackFact=true;
  const before=await visible();db.exec("CREATE TRIGGER refuse_pack BEFORE INSERT ON pack_coding_todos BEGIN SELECT RAISE(ABORT,'late pack failure'); END");
  recording=true;const failed=await mcp({name:'neo.todo.add',input:input('Fail after core insert','synthetic/failure')});recording=false;
  assert(failed.isError);assert.equal(tables.length,0);assert.deepEqual(await visible(),before);db.exec('DROP TRIGGER refuse_pack');result.publicAddRollbackBeforeNotification=true;
  db.exec('BEGIN IMMEDIATE');held=true;recording=true;let replied=false;
  const pending=command<{ok:true;todo:NeoTodo}>('neo.todoAddWrites','write',{askId:'work',todoId:'held',draft:{...input('Held','synthetic/held'),instruction:null,named:{repository:'synthetic/held'},check:{pack:'core',kind:'evidence',params:{path:'/synthetic/result'}}},now:Date.now()});void pending.then(()=>{replied=true;},()=>{replied=true;});
  await new Promise(done=>setTimeout(done,500));assert(!replied);assert.equal(tables.length,0);assert.deepEqual(await visible(),before);await hub.request('system.health',{});
  db.exec('ROLLBACK');held=false;const committed=await pending;recording=false;assert.equal(recorded(committed.todo.id),'github.com/synthetic/held');assert(tables.includes('pack_coding_todos'));result.gatewayWriterCommitBeforeReceiptUnderContention=true;
  listeningForFact=true;await method('coding.todoStorageWrites','write','record',[first.id,null]);await visible();assert(committedFact&&deliveredFact,'canonical fact changes must publish neo.changed after commit');listeningForFact=false;result.factUpdatesNotifyAfterCommit=true;await method('coding.todoStorageWrites','write','prepare',[]);
  assert.equal(recorded(first.id),null);assert.equal(neoTodoRepository(first,neoTodoPolicies(db),{ask:{id:'work'},todo:first}),null);result.explicitNullSurvivesPreparation=true;
  expected=await cards();
 }finally{
  if(held)db.exec('ROLLBACK');recording=false;app.db.gateway.onChanges=replay;offFact();await transport.close();hub.cleanup();await app.cleanup();
 }
}
try{await phase(false);await phase(true);result.verified=true;}finally{globalThis.fetch=network;result.resourcesStopped=true;writeFileSync(join(run,'evidence/coding-todo-storage-activation.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify(result));
