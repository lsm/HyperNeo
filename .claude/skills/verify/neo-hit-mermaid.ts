import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoPublication } from '../../../packages/shared/src/types/neo-publication.ts';

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
 const conversationId='10000000-0000-4000-8000-000000009088',root=`neo:${conversationId}`;
 await app.db.createSession({id:root,title:'Synthetic message copy',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 const db=app.db.getDatabase(),repo=new NeoRepository(db);repo.reserveBinding({sessionId:root,kind:'neo',projectId:null});assert.equal(repo.conversationId(),conversationId);
 const short='## Copy fixture\n\nThe **short reply** stays with the [source](https://example.test/source).';
 const code='const value = 7;\n\n  keepIndent(value);';
 const full=`### Details\n\nKeep this **Markdown** source.\n\n> A quoted **passage**.\n\n\`\`\`javascript\n${code}\n\`\`\``;
 const diagram='graph LR\n  A[Start] --> B[Done]';
 const fixtures=[
  {publicationId:crypto.randomUUID(),shortText:short,fullText:full,links:[]},
  {publicationId:crypto.randomUUID(),shortText:'Same **source**',fullText:'Same **source**',links:[]},
  {publicationId:crypto.randomUUID(),fullText:'Verbatim **source**',verbatim:true as const,links:[]},
  {publicationId:crypto.randomUUID(),fullText:'### Mermaid hit-area fixture\n\n```mermaid\n'+diagram+'\n```',verbatim:true as const,links:[]},
 ];
 for(const item of fixtures)db.prepare('INSERT INTO neo_publications(conversation_id,publication_id,payload_json,created_at) VALUES (?,?,?,?)').run(conversationId,item.publicationId,JSON.stringify({conversationId,...item}),new Date().toISOString());
 const publications=await hub.request<{ok:boolean;items:NeoPublication[]}>('operation.invoke',{name:'neo.publication.read',input:{conversationId}});assert(publications.ok && publications.items.length===4);assert(publications.items[0].fullText===full);
 const dist=resolve('packages/web/dist');assert(existsSync(join(dist,'neo/index.html')));
 front=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request,server){
  const path=new URL(request.url).pathname;
  if(path==='/ws'){if(server.upgrade(request,{data:{connectionSessionId:'global',device:await app.authenticateUpgrade(request,'127.0.0.1')}}))return;return new Response('Upgrade failed',{status:500});}
  const file=Bun.file(join(dist,path==='/neo'?'neo/index.html':path));return await file.exists()?new Response(file):new Response('Not found',{status:404});
 },websocket:createWebSocketHandlers(app.transport,app.sessionManager)});assert.notEqual(front.port,8399);
 writeFileSync(readyPath,JSON.stringify({phase,port:front.port,url:`http://127.0.0.1:${front.port}/neo`,run,pid:process.pid,fixtures,diagram,short,full,whole:`${short}\n\n${full}`,code},null,2));
 console.log(`Ready for attended browser: http://127.0.0.1:${front.port}/neo`);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 for(const signal of ['SIGUSR1','SIGINT','SIGTERM'] as const)process.once(signal,release);
 const timer=setTimeout(release,600000);await gate;clearTimeout(timer);
 const browser=JSON.parse(readFileSync(join(run,'evidence/browser.json'),'utf8'));assert.equal(browser.phase,phase);assert(phase==='before'?browser.baselineReproduced===true:browser.passed===true);
 evidence.browser=browser;evidence.publicationSeedReadable=true;evidence.passed=true;
}finally{
 front?.stop(true);await transport.close();await app.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;
 writeFileSync(join(run,'evidence/mermaid-hit-areas.json'),JSON.stringify(evidence,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(evidence).replaceAll(run,'<synthetic-run>'));
