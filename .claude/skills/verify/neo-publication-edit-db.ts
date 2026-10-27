import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createDaemonApp} from '../../../packages/daemon/src/app.ts';
import {getConfig} from '../../../packages/daemon/src/config.ts';
import {NeoRepository} from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import {NeoPublicationRepository} from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import {createOperationMcpHandler} from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
const [mode,directory]=process.argv.slice(2),run=resolve(directory);
assert(['before','verify'].includes(mode));assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const part of ['home','bin','evidence','workspace'])mkdirSync(join(run,part),{recursive:true});process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
const conversationId='10000000-0000-4000-8000-000000009144',root=`neo:${conversationId}`,publicationId='20000000-0000-4000-8000-000000009144',second='30000000-0000-4000-8000-000000009144',foreign='40000000-0000-4000-8000-000000009144',verbatim='50000000-0000-4000-8000-000000009144';
const original={conversationId,publicationId,shortText:'Original.',fullText:'Original detail.',links:[]};
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,measuring=0,park=false,parked:()=>void=()=>{},release:()=>void=()=>{};
const mainSql:string[]=[],commands:unknown[]=[];
const evidence:Record<string,any>={mode,verified:false,consumer:'Actual daemon registered MCP edit operation followed by public WebSocket publication read',limitation:'No model, GUI, card-reply mutation, live daemon or external service is involved.'};
function fixture<T>(fn:()=>T):T{const previous=measuring;measuring=0;try{return fn();}finally{measuring=previous;}}
async function open(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const db=app.db.getDatabase(),prepare=db.prepare.bind(db),send=app.db.gateway.run.bind(app.db.gateway);
 db.prepare=((sql:string)=>{if(measuring&&/neo_publications|neo_session_bindings/.test(sql))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
 app.db.gateway.run=(async(op,args)=>{
  if(park&&op.name==='neo.publication.revision'){park=false;parked();await new Promise<void>(done=>{release=done;});}
  const start=performance.now(),value=await send(op,args);
  if(op.name==='neo.publication.revision')commands.push({name:op.name,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value)??'null')});
  return value;
 }) as typeof app.db.gateway.run;
}
async function edit(input:Record<string,unknown>,who=root){measuring++;try{const handler=createOperationMcpHandler(()=>app!.sessionManager.getOperationRegistry(),()=>({sessionId:who,role:'neo'}));const reply=await handler({name:'neo.publication.edit',input});assert(!reply.isError,JSON.stringify(reply));return JSON.parse(reply.content[0].text);}finally{measuring--;}}
async function read(){const ws=new WebSocket(`ws://127.0.0.1:${app!.server.port}/ws`);try{await new Promise<void>((done,fail)=>{ws.onopen=()=>done();ws.onerror=()=>fail(new Error('Read connect failed'));});return await new Promise<any>((done,fail)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>fail(new Error('Public read timed out')),10000);ws.onmessage=event=>{const reply=JSON.parse(String(event.data));if(reply.id!==id&&reply.requestId!==id)return;clearTimeout(timer);reply.error?fail(new Error(JSON.stringify(reply.error))):done(reply.data);};ws.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'operation.invoke',data:{name:'neo.publication.read',input:{conversationId}},timestamp:new Date().toISOString(),version:'1.0.0'}));});}finally{ws.close();}}
try{
 await open();const db=app!.db.getDatabase();await app!.db.createSession({id:root,title:'Synthetic publication revision',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,totalCost:0,toolCallCount:0}});
 new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 const repo=new NeoPublicationRepository(db);assert(repo.append(original).accepted);assert(repo.append({...original,publicationId:second}).accepted);assert(repo.append({...original,publicationId:foreign,conversationId:foreign}).accepted);assert(repo.append({conversationId,publicationId:verbatim,verbatim:true,fullText:'Full verbatim.',links:[]}).accepted);
 const first={publicationId,requestId:'revision-one',shortText:'First.'};evidence.first=await edit(first);assert(evidence.first.accepted);
 const largeText='甲乙🙂\n'.repeat(2999)+'结束';evidence.second=await edit({publicationId,requestId:'revision-two',shortText:'Second.',fullText:largeText});assert(evidence.second.accepted);assert.equal(evidence.second.publication.fullText,largeText);
 evidence.replay=await edit(first);assert(evidence.replay.accepted);assert.equal(evidence.replay.publication.shortText,'Second.');assert.equal(evidence.replay.publication.revisions.length,2);
 evidence.conflict=await edit({...first,shortText:'Conflicting.'});assert.equal(evidence.conflict.reason.split(':')[0],'publication_conflict');
 evidence.reuse=await edit({...first,publicationId:second});assert.equal(evidence.reuse.reason.split(':')[0],'publication_conflict');
 evidence.foreign=await edit({...first,publicationId:foreign});assert.equal(evidence.foreign.reason.split(':')[0],'not_found');
 evidence.verbatim=await edit({...first,publicationId:verbatim,requestId:'verbatim-short'});assert.equal(evidence.verbatim.reason.split(':')[0],'invalid_publication');
 evidence.unauthorized=await edit(first,'neo:unbound-synthetic');assert.equal(evidence.unauthorized.reason.split(':')[0],'avatar_required');
 const retried=repo.append(original);assert(retried.accepted);assert.equal(retried.publication.shortText,'Second.');assert.equal(repo.append({...original,shortText:'Alter original.'}).accepted,false);
 evidence.race=await Promise.all(['Race A.','Race B.'].map(shortText=>edit({publicationId,requestId:'same-revision',shortText})));assert.equal(evidence.race.filter((r:any)=>r.accepted).length,1);assert.equal(evidence.race.filter((r:any)=>r.reason?.split(':')[0]==='publication_conflict').length,1);
 evidence.publicRead=await read();assert(evidence.publicRead.ok);const current=evidence.publicRead.items.find((p:any)=>p.publicationId===publicationId);assert.equal(current.fullText,largeText);assert.equal(current.revisions.length,3);assert.equal(current.revisions[0].shortText,'Original.');
 const before=evidence.publicRead;await app!.cleanup();app=undefined;await open();evidence.reopened=await read();assert.deepEqual(evidence.reopened,before);
 if(mode==='verify'){
  const gate=new Promise<void>(done=>{parked=done;});park=true;const pending=edit({publicationId,requestId:'stale-binding',shortText:'Must not publish.'});
  await Promise.race([gate,new Promise<never>((_,fail)=>setTimeout(()=>fail(new Error('Revision did not reach writer boundary')),5000))]);
  fixture(()=>app!.db.getDatabase().prepare('DELETE FROM neo_session_bindings WHERE session_id=?').run(root));release();evidence.staleBinding=await pending;assert.equal(evidence.staleBinding.reason.split(':')[0],'avatar_required');
  fixture(()=>new NeoRepository(app!.db.getDatabase()).reserveBinding({sessionId:root,kind:'neo',projectId:null}));
  assert.deepEqual(await read(),before);
  const timeGate=new Promise<void>(done=>{parked=done;});park=true;const timed=edit({publicationId,requestId:'queued-time',shortText:'Timestamp after the writer queue.'});
  await Promise.race([timeGate,new Promise<never>((_,fail)=>setTimeout(()=>fail(new Error('Timed revision did not reach writer boundary')),5000))]);
  await new Promise(done=>setTimeout(done,35));const releasedAt=Date.now();release();const timedReply=await timed;
  evidence.queuedTimestamp={releasedAt,reply:timedReply};assert(timedReply.accepted);assert(Date.parse(timedReply.publication.editedAt)>=releasedAt,'Edited timestamp must be generated after writer queue admission');
  const timedPage=await read();assert.equal(timedPage.items.find((p:any)=>p.publicationId===publicationId).editedAt,timedReply.publication.editedAt);
  assert.deepEqual(mainSql,[],'Revision admission, binding and publication SQL must leave main');
 }else assert(mainSql.length>0,'Baseline must reproduce revision SQL on main');
 evidence.verified=true;
}finally{release();evidence.mainSql=mainSql;evidence.commands=commands;writeFileSync(join(run,'evidence/neo-publication-edit-db.json'),JSON.stringify(evidence,null,2));await app?.cleanup();globalThis.fetch=network;}
