import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
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
 const sessions=[
  {adapter:'codex-desktop',id:'codex-worker',name:'Codex worker',provider:'Codex',link:'codex://threads/synthetic-open-check'},
  {adapter:'claude-desktop',id:'claude-worker',name:'Claude worker',provider:'Claude',link:'claude://claude.ai/epitaxy/synthetic-open-check'},
  {adapter:'copilot-cli',id:'copilot-worker',name:'Copilot worker',provider:'Copilot',link:'ghapp://synthetic-open-check'},
  {adapter:'hyperneo',id:'local-worker',name:'Local worker',provider:'Anthropic',link:'/session/local-worker'},
 ];
 const links=new NeoTodoSessionRepository(db);
 for(const source of sessions){
  await app.db.createSession({id:source.id,title:source.name,workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
  const askId=`open-${source.id}`,session={...source,label:source.name};
  store.openAsk({id:askId,title:`Review ${source.name}`,sessionId:root,projectId:null,originMessageId:null,request:'Synthetic open control check',createdAt:now});
  store.focusAsk(askId,session,now);
  store.askQuestion(`question-${source.id}`,askId,{kind:'yesno',text:`Review the ${source.name} decision?`,options:null,multiple:false,noLabel:'Wait',yesLabel:'Continue',startTodos:null,sourceSession:session},now);
  const todo=store.addTodo(`todo-${source.id}`,askId,{title:`Follow ${source.name}`,doneWhen:'Observed result',check:null,instruction:null,named:null},now);
  links.bind(todo.id,{adapter:source.adapter,id:source.id},now);
  links.recordRef(todo.id,{adapter:source.adapter,id:source.id},now,source.link);
 }
 const retained={...sessions[3],label:'Local worker'};
 store.openAsk({id:'retired-focus',title:'Retired focused discussion',sessionId:root,projectId:null,originMessageId:null,request:'Synthetic retained navigation',createdAt:now+1});
 store.focusAsk('retired-focus',retained,now+1);
 const retired=store.askQuestion('retired-focus-question','retired-focus',{kind:'reply',text:'Prepared focused context',options:null,multiple:false,noLabel:null,yesLabel:null,startTodos:null,sourceSession:retained},now+1);
 store.retireQuestion(retired,'Discuss directly',null,now+2);
 store.openAsk({id:'start-focus',title:'Focused start selection',sessionId:root,projectId:null,originMessageId:null,request:'Synthetic start navigation',createdAt:now+3});
 store.focusAsk('start-focus',retained,now+3);
 const selected=store.addTodo('focused-start-todo','start-focus',{title:'Selected focused worker',doneWhen:'Observed result',check:null,instruction:null,named:null},now+3);links.bind(selected.id,{adapter:retained.adapter,id:retained.id},now+3);links.recordRef(selected.id,{adapter:retained.adapter,id:retained.id},now+3,retained.link);
 store.askQuestion('focused-start-question','start-focus',{kind:'start',text:'Start focused work?',options:null,multiple:false,noLabel:null,yesLabel:null,startTodos:[selected.id]},now+3);
 const entry=await hub.request<{ok:boolean;entry:{questions:{sourceSession?:unknown}[]}}>('operation.invoke',{name:'neo.ask.read',input:{askId:'open-codex-worker'}});assert(entry.ok && entry.entry.questions[0].sourceSession);
 const dist=resolve('packages/web/dist');assert(existsSync(join(dist,'neo/index.html')));
 front=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request,server){
  const path=new URL(request.url).pathname;
  if(path==='/ws'){if(server.upgrade(request,{data:{connectionSessionId:'global',device:await app.authenticateUpgrade(request,'127.0.0.1')}}))return;return new Response('Upgrade failed',{status:500});}
  const file=Bun.file(join(dist,path==='/neo'?'neo/index.html':path));return await file.exists()?new Response(file):new Response('Not found',{status:404});
 },websocket:createWebSocketHandlers(app.transport,app.sessionManager)});assert.notEqual(front.port,8399);
 writeFileSync(readyPath,JSON.stringify({phase,port:front.port,url:`http://127.0.0.1:${front.port}/neo`,run,pid:process.pid,sessions},null,2));
 console.log(`Ready for attended browser: http://127.0.0.1:${front.port}/neo`);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 for(const signal of ['SIGUSR1','SIGINT','SIGTERM'] as const)process.once(signal,release);
 const timer=setTimeout(release,600000);await gate;clearTimeout(timer);
 const browser=JSON.parse(readFileSync(join(run,'evidence/browser.json'),'utf8'));assert.equal(browser.phase,phase);assert(phase==='before'?browser.baselineReproduced===true:browser.passed===true);
 evidence.browser=browser;evidence.sourceSeedReadable=true;evidence.passed=true;
}finally{
 front?.stop(true);await transport.close();await app.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;
 writeFileSync(join(run,'evidence/open-controls.json'),JSON.stringify(evidence,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(evidence).replaceAll(run,'<synthetic-run>'));
