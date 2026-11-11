process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { seedNeoWake } from '../../../packages/daemon/tests/helpers/neo-wake-corpus.ts';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';

const run=resolve(process.argv.at(-1)!),phase='after',readyPath=join(run,'browser-fixture.json');
assert(['before','after'].includes(phase));assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const path of ['workspace','bin','evidence'])mkdirSync(join(run,path),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
const app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});assert.notEqual(app.server.port,8399);
const hub=new MessageHub({defaultSessionId:'global'}),transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,createSocket:url=>createLocalSocket(url,join(run,'data/local-rpc.credential'))});hub.registerTransport(transport);
let front:ReturnType<typeof Bun.serve>|undefined;
const evidence:Record<string,unknown>={phase,passed:false,syntheticOnly:true};
try{
 assert(app.spaceRuntimeService);await app.spaceRuntimeService.ready();await app.jobProcessor.stop();await transport.connect();
 await app.db.updateGlobalSettings({language:'en'});
 const conversationId='10000000-0000-4000-8000-000000009088',root=`neo:${conversationId}`;
 await app.db.createSession({id:root,title:'Synthetic message copy',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 const db=app.db.getDatabase(),repo=new NeoRepository(db);repo.reserveBinding({sessionId:root,kind:'neo',projectId:null});assert.equal(repo.conversationId(),conversationId);
 const internal='That ask was already settled as done after its todo completed.';
 const wake=seedNeoWake(db,conversationId);wake.finish(internal);
 const active=seedNeoWake(db,conversationId,false);
 const requestId=crypto.randomUUID();
 const ask=new NeoConversationAskRepository(db).append({conversationId,requestId,askOrigin:{sessionId:root,messageId:requestId},content:'Synthetic human request'});assert(ask.accepted);
 const dist=resolve('packages/web/dist');assert(existsSync(join(dist,'neo/index.html')));
 front=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request,server){
  const refusal=await app.guardRequest(request);if(refusal)return refusal;
  const path=new URL(request.url).pathname;
  if(path==='/ws'){const device=await app.authenticateUpgrade(request,'127.0.0.1');if(!device)return new Response('Unauthorized',{status:401});if(server.upgrade(request,{data:{connectionSessionId:'global',device}}))return;return new Response('Upgrade failed',{status:500});}
  const file=Bun.file(join(dist,path==='/neo'?'neo/index.html':path));return await file.exists()?new Response(file):new Response('Not found',{status:404});
 },websocket:createWebSocketHandlers(app.transport,app.sessionManager)});assert.notEqual(front.port,8399);
 const paired=await hub.request<{ok:boolean;code:string}>('operation.invoke',{name:'device.pair.create',input:{kind:'human',name:'Synthetic message browser'}});assert(paired.ok);
 writeFileSync(readyPath,JSON.stringify({phase,pairCode:paired.code,pairBase:`http://127.0.0.1:${app.server.port}`,url:`http://127.0.0.1:${front.port}/neo`,run,internal,wake:wake.scheduleId,active:active.scheduleId}));
 const child=Bun.spawn(['node','.claude/skills/verify/neo-conversation-schedules-web.mjs',readyPath],{stdout:'inherit',stderr:'inherit'});
 assert.equal(await child.exited,0);
 const browser=JSON.parse(readFileSync(join(run,'evidence/browser.json'),'utf8'));assert(browser.passed);
 evidence.browser=browser;evidence.publicationSeedReadable=true;evidence.passed=true;
}finally{
 front?.stop(true);await transport.close();await app.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;
 writeFileSync(join(run,'evidence/conversation-schedules.json'),JSON.stringify(evidence,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(evidence).replaceAll(run,'<synthetic-run>'));
