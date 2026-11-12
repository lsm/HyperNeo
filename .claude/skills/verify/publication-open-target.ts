import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {z} from '../../../packages/daemon/node_modules/zod/index.js';
import {createDaemonApp} from '../../../packages/daemon/src/app.ts';
import {getConfig} from '../../../packages/daemon/src/config.ts';
import {NeoRepository} from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import {createOperationRegistry,defineOperation} from '../../../packages/daemon/src/lib/operations/registry.ts';
import {createOperationMcpHandler} from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import type {WorkRef} from '../../../packages/daemon/src/lib/drivers/types.ts';

const run=resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
mkdirSync(join(run,'evidence'),{recursive:true});mkdirSync(join(run,'bin'),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 73\n',{mode:0o700});
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;
let ws:WebSocket|undefined;
const observed:Record<string,unknown>={};
try{
 app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db'),workspaceRoot:run}),disableWorktrees:true},standalone:false,verbose:false});
 await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const conversationId=crypto.randomUUID(),root=`neo:${conversationId}`;
 for(const id of [root,'local','space-session']) await app.db.createSession({id,title:'Synthetic session',type:id==='space-session'?'space_task_agent':'general',workspacePath:run,createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{}} as never);
 new NeoRepository(app.db.getDatabase()).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 const reads:string[]=[];let nativeUnavailable=false;
 const place={machine:'synthetic',name:'Synthetic'};
 const summary=(ref:WorkRef)=>({ref,title:'Synthetic native',place,status:'running',lastActivityAt:1,...(ref.id==='linkless'?{}:{link:ref.id==='unsafe'?'javascript:alert(1)':ref.adapter==='codex-desktop'?`codex://threads/${ref.id}`:`claude://claude.ai/epitaxy/${ref.id}`})});
 const original=app.sessionManager.getOperationRegistry();
 const registry=createOperationRegistry(original.entries.map(entry=>['work.status','work.find'].includes(entry.name)?defineOperation({name:entry.name,description:'Synthetic native source',inputSchema:z.unknown(),resultSchema:z.unknown(),execute:(input:unknown,caller)=>{
  if(entry.name==='work.find'){
   const id=(input as {idPrefix?:string}).idPrefix;
   const refs=['native-thread','truncated'].includes(id??'')?[{adapter:'codex-desktop',id}]:id==='ambiguous'?[{adapter:'codex-desktop',id},{adapter:'claude-desktop',id}]:[];
   return {places:refs.length?[{place,lastActivityAt:1,openCount:refs.length,archivedCount:0,adapters:refs.map(ref=>ref.adapter),work:refs.map(summary)}]:[],unreachable:[],more:id==='truncated'};
  }
  const ref=(input as {ref:WorkRef}).ref;
  if(['codex-desktop','claude-desktop'].includes(ref.adapter)){
   reads.push(ref.id);
   return ['missing','unavailable'].includes(ref.id)||(nativeUnavailable&&ref.id==='native-thread')?{ok:false,reason:ref.id==='missing'?'not_found':'unreachable'}:{ok:true,value:summary(ref)};
  }
  return entry.execute(input as never,caller);
 }}):entry));
 app.sessionManager.setOperationRegistryProvider(()=>registry);
 const call=createOperationMcpHandler(()=>registry,()=>({sessionId:root,role:'neo'}));
 const invoke=async(name:string,input:unknown)=>JSON.parse((await call({name,input})).content[0].text);
 const draft={requestId:crypto.randomUUID(),shortText:'Open this session',fullText:'Synthetic Open target',session:'codex-desktop:native-thread'};
 const first=await invoke('neo.publication.publish',draft);
 assert(first.accepted,JSON.stringify(first));
 assert.equal(first.publication.sessionSource?.adapter,'codex-desktop','publication must carry the native Open target');
 assert.equal(first.publication.sessionSource.link,'codex://threads/native-thread');
 assert.equal(first.publication.session,draft.session);
 const retry=await invoke('neo.publication.publish',draft);assert.equal(retry.created,false);assert.equal(retry.publication.publicationId,first.publication.publicationId);assert.deepEqual(retry.publication.sessionSource,first.publication.sessionSource);
 const own=await invoke('neo.publication.publish',{...draft,requestId:crypto.randomUUID(),session:root});assert(own.accepted,JSON.stringify(own));assert.equal(own.publication.session,undefined);assert.equal(own.publication.sessionSource,undefined);
 const bare=await invoke('neo.session.link',{session:'native-thread'});assert.equal(bare.adapter,'codex-desktop');assert.equal(bare.link,'codex://threads/native-thread');
 for(const [session,adapter,link] of [['native-thread','codex-desktop','codex://threads/native-thread'],['codex-desktop:unsafe','codex-desktop',null],['codex-desktop:linkless','codex-desktop',null],['claude-desktop:native-session','claude-desktop','claude://claude.ai/epitaxy/native-session'],['local','hyperneo','/session/local'],['space-session','hyperneo','/session/space-session']] as const){
  const result=await invoke('neo.publication.publish',{...draft,requestId:crypto.randomUUID(),session});assert(result.accepted,JSON.stringify(result));assert.equal(result.publication.sessionSource.adapter,adapter);assert.equal(result.publication.sessionSource.link,link);assert.equal(result.publication.session,session);
 }
 const noSession=await invoke('neo.publication.publish',{requestId:crypto.randomUUID(),shortText:'Ordinary reply',fullText:'No session'});assert(noSession.accepted);assert.equal(noSession.publication.sessionSource,undefined);
 const beforeInjection=app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM neo_publications').get();
 const injected=await invoke('neo.publication.publish',{...draft,requestId:crypto.randomUUID(),sessionSource:{adapter:'codex-desktop',link:'javascript:alert(1)'}});assert.notEqual(injected.accepted,true);assert.deepEqual(app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM neo_publications').get(),beforeInjection);
 const ambiguous=await invoke('neo.session.link',{session:'ambiguous'});assert.equal(ambiguous.ok,false);
 const beforeTruncated=app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM neo_publications').get();
 const truncatedLink=await invoke('neo.session.link',{session:'truncated'});assert.equal(truncatedLink.ok,false,'a truncated lookup must not guess an Open target');
 const truncatedPublish=await invoke('neo.publication.publish',{...draft,requestId:crypto.randomUUID(),session:'truncated'});assert.equal(truncatedPublish.reason,'session_lookup_failed');assert.deepEqual(app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM neo_publications').get(),beforeTruncated);
 const unavailable=await invoke('neo.publication.publish',{...draft,requestId:crypto.randomUUID(),session:'codex-desktop:unavailable'});assert.equal(unavailable.reason,'session_lookup_failed');
 ws=createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);await new Promise((resolve,reject)=>{ws!.onopen=resolve;ws!.onerror=reject;});
 const rpc=(name:string,input:unknown)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
  const id=crypto.randomUUID(),timeout=setTimeout(()=>reject(new Error('RPC timeout')),10000);
  ws!.onmessage=event=>{const response=JSON.parse(String(event.data));if((response.requestId??response.id)!==id)return;clearTimeout(timeout);response.error?reject(new Error(JSON.stringify(response.error))):resolve(response.data.value??response.data);};
  ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'operation.invoke',data:{name,input},timestamp:new Date().toISOString(),version:'1.0.0'}));
 });
 const before=app.db.getDatabase().prepare('SELECT payload_json FROM neo_publications ORDER BY sequence').all();
 for(const name of ['neo.publication.read','neo.conversation.read']){
  reads.length=0;const page=await rpc(name,{conversationId,limit:100});assert.equal(page.ok,true);
  const items=page.items as {role?:string;publication?:typeof first.publication;sessionSource?:{adapter:string}}[];
  const publications=name==='neo.publication.read'?items:items.filter(item=>item.role==='neo').map(item=>item.publication!);
  assert.equal(publications.length,9);
  const current=publications.find(item=>item.publicationId===first.publication.publicationId)!;assert.equal(current.sessionSource.adapter,'codex-desktop');
  assert(reads.filter(id=>id==='native-thread').length<=2,'repeated sessions share one resolution per page');
 }
 nativeUnavailable=true;
 const unavailablePage=await rpc('neo.publication.read',{conversationId,limit:100});
 assert.equal(unavailablePage.ok,true);
 const retained=(unavailablePage.items as typeof first.publication[]).find(item=>item.publicationId===first.publication.publicationId)!;
 assert.equal(retained.fullText,first.publication.fullText);assert.equal(retained.sessionSource,null);
 assert.deepEqual(app.db.getDatabase().prepare('SELECT payload_json FROM neo_publications ORDER BY sequence').all(),before);
 assert(before.every(row=>!String((row as {payload_json:string}).payload_json).includes('sessionSource')));
 Object.assign(observed,{passed:true,wireField:'sessionSource',qualifiedAndBare:true,localNeoAndSpace:true,safeLinks:true,producerCannotInject:true,retry:true,bothReadDoors:true,batchDedup:true,storedPayloadUnchanged:true});
}finally{ws?.close();await app?.cleanup();}
observed.resourcesClosed=true;writeFileSync(join(run,'evidence/publication-open-target.json'),JSON.stringify(observed,null,2));console.log(JSON.stringify(observed));
