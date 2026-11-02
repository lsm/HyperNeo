import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run=resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data')));
for(const key of ['GH_TOKEN','GITHUB_TOKEN','ANTHROPIC_API_KEY','OPENAI_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'])assert.equal(process.env[key],undefined);
for(const dir of ['workspace','evidence','bin'])mkdirSync(join(run,dir),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 2\n',{mode:0o700});process.env.PATH=join(run,'bin')+':'+process.env.PATH;
const conversationId='10000000-0000-4000-8000-000000000008',root='neo:'+conversationId;
const app=await createDaemonApp({config:getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),verbose:false});
const evidence:Record<string,unknown>={};let transport:InstanceType<typeof WebSocketClientTransport>|undefined;
try{
 await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 await app.db.createSession({id:root,title:'Synthetic quote',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 const db=app.db.getDatabase();await waitForSdkBodyCopy(db);new NeoRepository(db).reserveBinding({sessionId:root,projectId:null,kind:'neo'});
 const store=new NeoAskTodoRepository(db);store.openAsk({id:'synthetic-ask',projectId:null,sessionId:root,originMessageId:null,title:'Synthetic work card',request:'Synthetic',createdAt:1});
 const q={kind:'choice' as const,options:['Keep','Change'],multiple:false,noLabel:null,yesLabel:null,startTodos:null};
 store.askQuestion('old-card','synthetic-ask',{...q,text:'Earlier choice'},1);store.askQuestion('new-card','synthetic-ask',{...q,text:'Replacement choice'},2);db.prepare("UPDATE neo_questions SET state='retired',replaced_by='new-card' WHERE id='old-card'").run();
 const ledger=new NeoConversationAskRepository(db),legacyId=crypto.randomUUID();ledger.append({conversationId,requestId:legacyId,askOrigin:{sessionId:root,messageId:legacyId},content:'Legacy saved reply',replyTo:{kind:'question',id:'old-card'}});
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 const invoke=<T>(name:string,input:unknown)=>hub.request<T>('operation.invoke',{name,input});
 const requestId=crypto.randomUUID();const sent=await invoke<{ok:boolean}>('neo.message.send',{sessionId:root,requestId,content:'Keep',replyTo:{kind:'question',id:'new-card'}});assert(sent.ok);
 const askReplyId=crypto.randomUUID();assert((await invoke<{ok:boolean}>('neo.message.send',{sessionId:root,requestId:askReplyId,content:'About this matter',replyTo:{kind:'ask',id:'synthetic-ask'}})).ok);
 const page=await invoke<{ok:boolean;items:{requestId:string;replyTo?:{kind:string;id:string;author?:string;excerpt?:string}}[]}>('neo.conversation.asks.read',{conversationId,imageRefs:true});evidence.page=page;assert(page.ok);
 assert.deepEqual(page.items.find(item=>item.requestId===requestId)?.replyTo,{kind:'question',id:'new-card',author:'neo',excerpt:'Replacement choice'});
 assert.deepEqual(page.items.find(item=>item.requestId===legacyId)?.replyTo,{kind:'question',id:'old-card',author:'neo',excerpt:'Earlier choice'});
 assert.deepEqual(ledger.find(conversationId,legacyId)?.replyTo,{kind:'question',id:'old-card'});
 if(process.env.VERIFY_BROWSER){
  const {createWebSocketHandlers}=await import('../../../packages/daemon/src/routes/setup-websocket.ts');const dist=resolve('packages/web/dist');
  const front=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request,server){const path=new URL(request.url).pathname;if(path==='/ws'){if(server.upgrade(request,{data:{connectionSessionId:'global',device:await app.authenticateUpgrade(request,'127.0.0.1')}}))return;return new Response('Upgrade failed',{status:500});}const file=Bun.file(join(dist,path==='/neo'?'neo/index.html':path));return await file.exists()?new Response(file):new Response('Not found',{status:404});},websocket:createWebSocketHandlers(app.transport,app.sessionManager)});
  try{const child=Bun.spawn(['node','.claude/skills/verify/neo-card-quote-web.mjs',String(front.port),run],{stdout:'inherit',stderr:'inherit'});assert.equal(await child.exited,0);evidence.webVerified=true;}finally{front.stop(true);}
 }
 assert.deepEqual(page.items.find(item=>item.requestId===askReplyId)?.replyTo,{kind:'ask',id:'synthetic-ask',author:'neo',excerpt:'Synthetic work card'});
 evidence.pass=true;evidence.newReplyId=requestId;evidence.legacyReplyId=legacyId;evidence.legacyPayloadUnchanged=true;
 console.log('PASS actual sent and historical card quotes survive replacement/answer without the original card loaded');
}finally{await transport?.close();await app.cleanup();writeFileSync(join(run,'evidence/card-quote.json'),JSON.stringify(evidence,null,2));}
