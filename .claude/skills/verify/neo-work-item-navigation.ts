import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';
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
 await app.db.createSession({id:root,title:'Synthetic All items',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 const db=app.db.getDatabase(),repo=new NeoRepository(db);repo.reserveBinding({sessionId:root,kind:'neo',projectId:null});assert.equal(repo.conversationId(),conversationId);
 const store=new NeoAskTodoRepository(db),now=Date.now(),doneAsk='nav-done',historyAsk='nav-history';
 const open=(id:string,title:string,at=now)=>store.openAsk({id,title,sessionId:root,projectId:null,originMessageId:null,request:'Synthetic navigation only',createdAt:at});
 open(doneAsk,'Completed navigation card');
 for(let i=1;i<=25;i++){const todo=store.addTodo(`nav-done-${i}`,doneAsk,{title:`Completed navigation step ${i}`,doneWhen:'Observed synthetic result',check:null,instruction:null,named:null},now+i);store.updateTodo(todo,{state:'done',report:`Navigation report ${i}`},now+i);}
 open(historyAsk,'Stored navigation card',now-10000);
 const draft={kind:'reply' as const,options:null,multiple:false,noLabel:null,yesLabel:null,startTodos:null};
 const answered=store.askQuestion('nav-answered',historyAsk,{...draft,text:'Saved answered reference'},now-9999);store.answerQuestion(answered,'Saved decision','chat',now-9998);
 const retired=store.askQuestion('nav-retired',historyAsk,{...draft,text:'Saved retired reference'},now-9997);store.retireQuestion(retired,'Context retained',null,now-9996);
 store.settleAsk(store.getAsk(historyAsk)!,'done','Synthetic archived card',now-9995);
 for(let i=0;i<12;i++){const id=`nav-newer-${i}`;open(id,`Newer archived card ${i}`,now+i);store.settleAsk(store.getAsk(id)!,'done','Synthetic newer outcome',now+i);}
 const ask=new NeoConversationAskRepository(db),requestId=crypto.randomUUID();assert(ask.append({conversationId,requestId,askOrigin:{sessionId:root,messageId:requestId},content:'Discuss completed work',replyTo:{kind:'todo',id:'nav-done-25',excerpt:'Completed target quote'}}).accepted);
 const publications=[];
 for(const [questionId,title] of [['nav-answered','Saved answered reference'],['nav-retired','Saved retired reference']]){const publicationId=crypto.randomUUID();const item={conversationId,publicationId,shortText:`I replied · View card · ${title}`,fullText:'Synthetic card navigation',links:[],cardReply:{askId:historyAsk,questionId,mutationId:crypto.randomUUID(),sourceMessageIds:[crypto.randomUUID()]}};db.prepare('INSERT INTO neo_publications(conversation_id,publication_id,payload_json,created_at) VALUES (?,?,?,?)').run(conversationId,publicationId,JSON.stringify(item),new Date().toISOString());publications.push(item);}
 const snapshot=await hub.request<{ok:boolean;todoAsks:{ask:{id:string}}[]}>('operation.invoke',{name:'neo.snapshot',input:{}});assert(snapshot.ok && !snapshot.todoAsks.some(entry=>entry.ask.id===historyAsk));
 const exact=await hub.request<{ok:boolean;entry:{ask:{id:string}}}>('operation.invoke',{name:'neo.ask.read',input:{todoId:'nav-done-25'}});assert(exact.ok && exact.entry.ask.id===doneAsk);
 const dist=resolve('packages/web/dist');assert(existsSync(join(dist,'neo/index.html')));
 front=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request,server){
  const path=new URL(request.url).pathname;
  if(path==='/ws'){if(server.upgrade(request,{data:{connectionSessionId:'global',device:await app.authenticateUpgrade(request,'127.0.0.1')}}))return;return new Response('Upgrade failed',{status:500});}
  const file=Bun.file(join(dist,path==='/neo'?'neo/index.html':path));return await file.exists()?new Response(file):new Response('Not found',{status:404});
 },websocket:createWebSocketHandlers(app.transport,app.sessionManager)});assert.notEqual(front.port,8399);
 writeFileSync(readyPath,JSON.stringify({phase,port:front.port,url:`http://127.0.0.1:${front.port}/neo`,run,pid:process.pid,doneAsk,historyAsk,publications},null,2));
 console.log(`Ready for attended browser: http://127.0.0.1:${front.port}/neo`);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 for(const signal of ['SIGUSR1','SIGINT','SIGTERM'] as const)process.once(signal,release);
 const timer=setTimeout(release,600000);await gate;clearTimeout(timer);
 const browser=JSON.parse(readFileSync(join(run,'evidence/browser.json'),'utf8'));assert.equal(browser.phase,phase);assert(phase==='before'?browser.baselineReproduced===true:browser.passed===true);
 evidence.browser=browser;evidence.exactReadersVerified=true;evidence.passed=true;
}finally{
 front?.stop(true);await transport.close();await app.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;
 writeFileSync(join(run,'evidence/all-items.json'),JSON.stringify(evidence,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(evidence).replaceAll(run,'<synthetic-run>'));
