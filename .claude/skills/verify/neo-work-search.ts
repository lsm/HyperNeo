import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const [phase,readyPath,directory]=process.argv.slice(2),run=resolve(directory);
assert(['before','after'].includes(phase));assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const path of ['workspace','bin','evidence'])mkdirSync(join(run,path),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
const app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});assert.notEqual(app.server.port,8399);
const hub=new MessageHub({defaultSessionId:'global'}),transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`});hub.registerTransport(transport);
let front:ReturnType<typeof Bun.serve>|undefined;
const evidence:Record<string,unknown>={phase,passed:false,syntheticOnly:true};
try{
 await app.spaceRuntimeService.ready();await app.jobProcessor.stop();await transport.connect();
 await app.db.updateGlobalSettings({language:'en'});
 const conversationId='10000000-0000-4000-8000-000000009098',root=`neo:${conversationId}`;
 await app.db.createSession({id:root,title:'Synthetic settled questions',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 const db=app.db.getDatabase(),repo=new NeoRepository(db);repo.reserveBinding({sessionId:root,kind:'neo',projectId:null});assert.equal(repo.conversationId(),conversationId);
 const store=new NeoAskTodoRepository(db),now=Date.now();
 const cases=[{id:'ask-match',title:'Needle ask'},{id:'todo-match',title:'Todo field'},{id:'status-match',title:'Status field'},{id:'report-match',title:'Report field'},{id:'cjk-match',title:'接口数据修复'}];
 for(const item of cases){
  store.openAsk({id:item.id,title:item.title,sessionId:root,projectId:null,originMessageId:null,request:item.id==='ask-match'?'requestsigil735 请求原文':'Synthetic search corpus only',createdAt:now});
  const todo=store.addTodo(`${item.id}-todo`,item.id,{title:item.id==='todo-match'?'Needle step':'Ordinary step',doneWhen:'Observed fixture result',check:null,instruction:null,named:null},now);
  if(item.id==='status-match')store.updateTodo(todo,{state:'blocked',blockedReason:'Needle status'},now+1);
  if(item.id==='report-match')store.updateTodo(todo,{report:'Needle microcipher731'},now+1);
  if(item.id==='todo-match')store.updateTodo(todo,{evidence:'evidencesigil732'},now+1);
  if(item.id==='ask-match'){const question=store.askQuestion('search-question',item.id,{kind:'reply',text:'permission734',options:null,multiple:false,noLabel:null,yesLabel:null,startTodos:null},now+1);store.answerQuestion(question,'answercipher736 回答内容','chat',now+2);}
  if(item.id==='status-match')db.prepare('UPDATE neo_asks SET outcome=? WHERE id=?').run('outcomesigil733',item.id);
 }
 const dist=resolve('packages/web/dist');assert(existsSync(join(dist,'neo/index.html')));
 let refreshSerial=0;
 front=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request,server){
  const target=new URL(request.url),path=target.pathname;
  if(path==='/__verify-refresh'){if(target.searchParams.get('changed')==='1')store.updateTodo(store.getTodo('report-match-todo')!,{report:`Needle microcipher731 refreshedsigil737 ${++refreshSerial}`},Date.now());await app.messageHub.event('neo.changed',{});return Response.json({syntheticOnly:true});}
  if(path==='/ws'){if(server.upgrade(request,{data:{connectionSessionId:'global',device:await app.authenticateUpgrade(request,'127.0.0.1')}}))return;return new Response('Upgrade failed',{status:500});}
  const file=Bun.file(join(dist,path==='/neo'?'neo/index.html':path));return await file.exists()?new Response(file):new Response('Not found',{status:404});
 },websocket:createWebSocketHandlers(app.transport,app.sessionManager)});assert.notEqual(front.port,8399);
 writeFileSync(readyPath,JSON.stringify({phase,port:front.port,url:`http://127.0.0.1:${front.port}/neo`,run,pid:process.pid,cases},null,2));
 console.log(`Ready for attended browser: http://127.0.0.1:${front.port}/neo`);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 for(const signal of ['SIGUSR1','SIGINT','SIGTERM'] as const)process.once(signal,release);
 const timer=setTimeout(release,600000);await gate;clearTimeout(timer);
 const browser=JSON.parse(readFileSync(join(run,'evidence/browser.json'),'utf8'));assert.equal(browser.phase,phase);assert(phase==='before'?browser.baselineReproduced===true:browser.passed===true);
 evidence.browser=browser;evidence.syntheticSearchCorpus=true;evidence.passed=true;
}finally{
 front?.stop(true);await transport.close();await app.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;
 writeFileSync(join(run,'evidence/work-search.json'),JSON.stringify(evidence,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(evidence).replaceAll(run,'<synthetic-run>'));
