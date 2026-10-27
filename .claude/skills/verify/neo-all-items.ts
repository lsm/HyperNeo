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
 await app.db.createSession({id:root,title:'Synthetic All items',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 const db=app.db.getDatabase(),repo=new NeoRepository(db);repo.reserveBinding({sessionId:root,kind:'neo',projectId:null});assert.equal(repo.conversationId(),conversationId);
 const store=new NeoAskTodoRepository(db),askId='all-items',now=Date.now();
 store.openAsk({id:askId,title:'Synthetic All items',sessionId:root,projectId:null,originMessageId:null,request:'Synthetic history only',createdAt:now});
 const full='## A settled decision\n\n'+('Synthetic context with **important choices**. ').repeat(60)+'\n\n| Choice | Outcome |\n| --- | --- |\n| Keep | Ready |\n\n[Safe source](https://example.test/decision)\n\n**Final detail 9098**';
 const draft={kind:'reply' as const,text:full,options:null,multiple:false,noLabel:null,yesLabel:null,startTodos:null,document:'Literal original versions'};
 const answered=store.askQuestion('answered-long',askId,draft,now);store.answerQuestion(answered,'Keep the decision','chat',now+1);
 const retired=store.askQuestion('retired-long',askId,{...draft,text:full.replace('A settled decision','A retired decision')},now+2);store.retireQuestion(retired,'No longer needed',null,now+3);
 const short=store.askQuestion('answered-short',askId,{...draft,text:'**Brief question**',document:undefined},now+4);store.answerQuestion(short,'Brief answer','chat',now+5);
 store.askQuestion('open-question',askId,{...draft,text:'Keep working?',document:undefined,kind:'yesno',yesLabel:'Continue',noLabel:'Wait'},now+6);
 for(let i=0;i<=25;i++){
  const todo=store.addTodo(`all-todo-${i}`,askId,{title:i===0?'Unfinished All step':`Completed All step ${i}`,doneWhen:'Observed synthetic result',check:null,instruction:null,named:null},now+i);
  if(i>0)store.updateTodo(todo,{state:'done',report:`Synthetic report ${i}`,evidence:'Observed fixture only'},now+i);
 }
 const removed=store.addTodo('all-removed',askId,{title:'Removed All step',doneWhen:'Synthetic removal',check:null,instruction:null,named:null},now);
 store.updateTodo(removed,{state:'removed',reason:'Synthetic retired work'},now);
 db.prepare('UPDATE neo_asks SET outcome=? WHERE id=?').run('## Final outcome\n\nOutcome sentinel',askId);
 const entry=await hub.request<{ok:boolean;entry:{questions:{id:string;text:string}[]}}>('operation.invoke',{name:'neo.ask.read',input:{askId}});assert(entry.ok && entry.entry.questions.some(q=>q.id==='answered-long' && q.text===full));
 const dist=resolve('packages/web/dist');assert(existsSync(join(dist,'neo/index.html')));
 front=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request,server){
  const path=new URL(request.url).pathname;
  if(path==='/ws'){if(server.upgrade(request,{data:{connectionSessionId:'global',device:await app.authenticateUpgrade(request,'127.0.0.1')}}))return;return new Response('Upgrade failed',{status:500});}
  const file=Bun.file(join(dist,path==='/neo'?'neo/index.html':path));return await file.exists()?new Response(file):new Response('Not found',{status:404});
 },websocket:createWebSocketHandlers(app.transport,app.sessionManager)});assert.notEqual(front.port,8399);
 writeFileSync(readyPath,JSON.stringify({phase,port:front.port,url:`http://127.0.0.1:${front.port}/neo`,run,pid:process.pid,askId,full},null,2));
 console.log(`Ready for attended browser: http://127.0.0.1:${front.port}/neo`);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 for(const signal of ['SIGUSR1','SIGINT','SIGTERM'] as const)process.once(signal,release);
 const timer=setTimeout(release,600000);await gate;clearTimeout(timer);
 const browser=JSON.parse(readFileSync(join(run,'evidence/browser.json'),'utf8'));assert.equal(browser.phase,phase);assert(phase==='before'?browser.baselineReproduced===true:browser.passed===true);
 evidence.browser=browser;evidence.questionSeedReadable=true;evidence.passed=true;
}finally{
 front?.stop(true);await transport.close();await app.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;
 writeFileSync(join(run,'evidence/all-items.json'),JSON.stringify(evidence,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(evidence).replaceAll(run,'<synthetic-run>'));
