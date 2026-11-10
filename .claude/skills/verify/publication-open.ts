process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from '../../../packages/daemon/node_modules/zod/index.js';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createOperationRegistry, defineOperation } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';
const phase = process.argv[2], run = resolve(process.argv.at(-1)!);
assert(['before', 'after'].includes(phase));
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run,'home'));
for (const part of ['workspace','bin','evidence']) mkdirSync(join(run,part),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true},verbose:false});
let front:ReturnType<typeof Bun.serve>|undefined;
const evidence:Record<string,unknown>={phase};
try {
 await app.spaceRuntimeService.ready();await app.jobProcessor.stop();await waitForSdkBodyCopy(app.db.getDatabase());assert.notEqual(app.server.port,8399);
 const conversationId=crypto.randomUUID(), root=`neo:${conversationId}`, worker='local-worker', room='space-session';
 for (const id of [root,worker,room]) await app.db.createSession({id,title:id===root?'Synthetic Neo':id===room?'Space session':'Local worker',type:id===room?'space_task_agent':'general',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 new NeoRepository(app.db.getDatabase()).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 const original=app.sessionManager.getOperationRegistry(), status=original.entries.find(entry=>entry.name==='work.status')!;
 const registry=createOperationRegistry(original.entries.map(entry=>entry.name==='work.status'?defineOperation({name:'work.status',description:'Synthetic native app metadata',inputSchema:z.unknown(),resultSchema:z.unknown(),execute:(input,caller)=>{
 const ref=(input as {ref:{id:string;adapter:string}}).ref;
 if(['codex-desktop','claude-desktop'].includes(ref.adapter))return {ok:true,value:{ref,title:`${ref.adapter} worker`,place:{machine:'synthetic',name:'Synthetic'},status:'running',lastActivityAt:1,watchHint:ref.id==='linkless'?'Synthetic session has no native app link':undefined,link:ref.id==='linkless'?undefined:ref.adapter==='codex-desktop'?`codex://threads/${ref.id}`:`claude://claude.ai/epitaxy/${ref.id}`}};
 return status.execute(input,caller);
 }}):entry));app.sessionManager.setOperationRegistryProvider(()=>registry);
 const publish=createOperationMcpHandler(()=>registry,()=>({sessionId:root,role:'neo'}));
 const fixtures=[];
 for(const [session,title] of [[worker,'Local session reply'],[root,'Neo session reply'],[room,'Space session reply'],['codex-desktop:synthetic-thread','Codex session reply'],['claude-desktop:synthetic-session','Claude session reply'],['codex-desktop:linkless','Session without app link'],[undefined,'Ordinary reply']] as const){
 const result=JSON.parse((await publish({name:'neo.publication.publish',input:{requestId:crypto.randomUUID(),shortText:title,fullText:`${title}\n\nSynthetic full report`,...(session?{session}:{})}})).content[0].text);
 assert(result.accepted,JSON.stringify(result));assert.equal(result.publication.session,session===root?undefined:session);fixtures.push({session:session===root?undefined:session,title,id:result.publication.publicationId});
 }
 const stored=JSON.parse((await publish({name:'neo.publication.publish',input:{requestId:crypto.randomUUID(),shortText:'Stored Neo session reply',fullText:'Stored Neo session reply'}})).content[0].text).publication.publicationId;
 app.db.getDatabase().prepare("UPDATE neo_publications SET payload_json=json_set(payload_json,'$.session',?) WHERE publication_id=?").run(root,stored);fixtures.push({session:undefined,title:'Stored Neo session reply',id:stored});
 const store=new NeoAskTodoRepository(app.db.getDatabase()),links=new NeoTodoSessionRepository(app.db.getDatabase()),at=Date.now();
 store.openAsk({id:'comparison-work',sessionId:root,projectId:null,originMessageId:null,title:'Comparison work card',request:'Synthetic comparison',createdAt:at});
 const todo=store.addTodo('comparison-todo','comparison-work',{title:'Same local worker',doneWhen:'Observed Open',check:null,instruction:null,named:null},at);links.bind(todo.id,{adapter:'hyperneo',id:worker},at);links.recordRef(todo.id,{adapter:'hyperneo',id:worker},at,`/session/${worker}`);
 const dist=resolve('packages/web/dist');assert(existsSync(join(dist,'neo/index.html')));
 front=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request,server){
 const path=new URL(request.url).pathname;
 if(path==='/ws'){if(server.upgrade(request,{data:{connectionSessionId:'global',device:await app.authenticateUpgrade(request,'127.0.0.1')}}))return;return new Response('Upgrade failed',{status:500});}
 const file=Bun.file(join(dist,path==='/neo'?'neo/index.html':path));return await file.exists()?new Response(file):new Response('Not found',{status:404});
 },websocket:createWebSocketHandlers(app.transport,app.sessionManager)});assert.notEqual(front.port,8399);
 writeFileSync(join(run,'fixture.json'),JSON.stringify({phase,url:`http://127.0.0.1:${front.port}/neo`,fixtures}));
 const browser=await promisify(execFile)('node',['.claude/skills/verify/publication-open-web.mjs',run],{env:process.env,timeout:90000,maxBuffer:4*1024*1024});
 evidence.browser=JSON.parse(browser.stdout);assert.equal((evidence.browser as {passed:boolean}).passed,true);evidence.passed=true;
} catch(error){evidence.error=String(error);throw error;} finally {await front?.stop(true);await app.cleanup();evidence.resourcesClosed=true;writeFileSync(join(run,'evidence/publication-open.json'),JSON.stringify(evidence,null,2));}
