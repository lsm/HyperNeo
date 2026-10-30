import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';
const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home')); assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace','evidence','bin']) mkdirSync(join(run,name),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableGoalProcessing:true},verbose:false});
assert.notEqual(app.server.port,8399);
await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); await waitForSdkBodyCopy(app.db.getDatabase());
const service=createNeoService(app.db,app.sessionManager,app.messageHub,app.internalEventBus);
const ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
await new Promise<void>((done,fail)=>{ws.onopen=()=>done();ws.onerror=()=>fail(new Error('RPC unavailable'));});
const rpc=(name:string,input:unknown)=>new Promise<unknown>((done,fail)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>fail(new Error(name+' timed out')),10000);ws.onmessage=e=>{const r=JSON.parse(String(e.data));if(r.id!==id&&r.requestId!==id)return;clearTimeout(timer);if(r.error)fail(new Error(JSON.stringify(r.error)));else done(r.data);};ws.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'operation.invoke',data:{name,input},timestamp:new Date().toISOString(),version:'1.0.0'}));});
const report:Record<string,unknown>={cases:[]};
const root='neo:00000000-0000-4000-8000-000000009502';
const seed=(id:string)=>app.db.createSession({id,title:'Synthetic blocker report',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
try {
 await seed(root);new NeoRepository(app.db.getDatabase()).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 for(const [kind,message] of [['needs_human','Work paused.\nBlocked (needs_human): Awaiting synthetic approval'],['environment','Work paused.\nBlocked (environment): Synthetic network unavailable'],['ordinary','Blocked (needs_human): Quoted example\nOrdinary final line']] as const){
  const worker='synthetic-'+kind, id='todo-'+kind,at=Date.now();await seed(worker);
  const ask=service.todos.openAsk({id:kind,sessionId:root,projectId:null,originMessageId:null,title:kind,request:'Observe blocker',createdAt:at});
  const todo=service.todos.addTodo(id,ask.id,{title:kind,doneWhen:'Synthetic evidence exists',check:{pack:'core',kind:'evidence',params:{path:join(run,'missing-'+kind)}},instruction:'Synthetic assigned work',named:null},at);
  const ref={adapter:'hyperneo',id:worker};service.todoSessions.create(id,{verb:'send',ref});service.todoSessions.recordRef(id,ref,at);
  service.todoSessions.recordSent(id,{inputBefore:at,opening:'Synthetic assigned work',receipt:{executionId:worker,inputId:worker+'-input'}});
  service.todos.updateTodo(todo,{state:'doing',startedAt:at},at);
  const dispatch=await service.todoSessions.inputs.accept(id,root,{verb:'send',ref},'Synthetic assigned work',at);
  await service.todoSessions.inputs.recordOutcome(dispatch,{ref,receipt:{executionId:worker,inputId:worker+'-input'}},at);
  await app.db.saveUserMessage(worker,{type:'user',uuid:worker+'-input',session_id:worker,parent_tool_use_id:null,message:{role:'user',content:'Synthetic assigned work'}} as SDKMessage,'consumed');
  await new Promise(done=>setTimeout(done,5));
  await app.db.saveSDKMessage(worker,{type:'result',subtype:'success',uuid:crypto.randomUUID(),parent_tool_use_id:null,is_error:false,result:message,duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},modelUsage:{},permission_denials:[]} as SDKMessage);
  const status=await rpc('work.status',{ref,since:at});
  await service.refreshDriverWork();
  const current=service.todos.getTodo(id),questions=service.todos.listQuestions(ask.id).filter(q=>q.todoId===id&&q.state==='open');
  (report.cases as unknown[]).push({kind,status,todo:current,questions});
  if(kind!=='ordinary'){assert.equal(current?.blockedBy,kind==='needs_human'?'needs-human':'environment');assert.equal(questions.length,0);}
  else assert.notEqual(current?.blockedBy,'needs-human');
 }
 report.snapshot=await rpc('neo.snapshot',{});
 const jobs=app.db.getDatabase().prepare("SELECT payload FROM job_queue WHERE queue='mailbox'").all();
 report.neoWake=jobs;
 assert(JSON.stringify(jobs).includes('If you can answer this, reply to the worker'));
 const originalNow=Date.now;Date.now=()=>originalNow()+60*60_000;
 try {await service.refreshDriverWork();} finally {Date.now=originalNow;}
 report.afterDeadline={todo:service.todos.getTodo('todo-needs_human'),nudge:service.todoSessions.readNudge('todo-needs_human'),questions:service.todos.listQuestions('needs_human')};
 const humanQuestion=service.todos.listQuestions('needs_human').find(q=>q.state==='open')!;
 assert(humanQuestion);
 report.answer=await rpc('neo.question.answer',{questionId:humanQuestion.id,answer:'Synthetic approval granted'});
 await service.refreshDriverWork();
 const after=service.todos.getTodo('todo-needs_human');
 assert.notEqual(after?.blockedBy,'needs-human');
 assert.equal(service.todos.listQuestions('needs_human').filter(q=>q.state==='open').length,0);
 report.afterAnswer={todo:after,routes:service.todos.questionAnswers.list(humanQuestion.id)};
 assert(JSON.stringify(report.snapshot).includes('Awaiting synthetic approval'));
 report.passed=true;
} catch(error){report.error=String(error);throw error;}
finally{ws.close();await service.dispose();await app.cleanup();report.resourcesClosed=true;writeFileSync(join(run,'evidence/blocker-lines.json'),JSON.stringify(report,null,2));}
