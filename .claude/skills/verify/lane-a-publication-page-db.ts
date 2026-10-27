import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const [mode,directory]=process.argv.slice(2),run=resolve(directory);
assert(['before','verify'].includes(mode));assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data')));
for(const key of ['GH_TOKEN','GITHUB_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'])assert.equal(process.env[key],undefined);
for(const part of ['bin','evidence','workspace'])mkdirSync(join(run,part),{recursive:true});process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('No external HTTP in publication proof');}) as typeof fetch;
const conversationId='10000000-0000-4000-8000-000000009244',foreign='30000000-0000-4000-8000-000000009244',root=`neo:${conversationId}`;
const id=(n:number)=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const text='甲乙🙂\n'.repeat(2999)+'全文结束';const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,measuring=0,park=false,parked:()=>void=()=>{},release:()=>void=()=>{};
const mainSql:string[]=[],commands:unknown[]=[];
const evidence:Record<string,any>={verified:false,mode,consumer:'Real public WebSocket neo.publication.read and registered MCP operation',limitations:'No GUI, model, card-reply mutation, real GitHub, live daemon or global latency benchmark.'};
const sql=()=>app!.db.getDatabase();
async function open(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});
 const db=sql(),prepare=db.prepare.bind(db),send=app.db.gateway.run.bind(app.db.gateway);
 db.prepare=((statement:string)=>{if(measuring&&/neo_publications|neo_conversation\b|neo_session_bindings/.test(statement))mainSql.push(statement);return prepare(statement);}) as typeof db.prepare;
 app.db.gateway.run=(async(op,args)=>{
  if(park&&op.name==='neo.publication.page'){park=false;parked();await new Promise<void>(done=>{release=done;});}
  const start=performance.now(),value=await send(op,args);if(measuring)commands.push({name:op.name,mode:op.mode,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value)??'null')});return value;
 }) as typeof app.db.gateway.run;
}
async function read(input:Record<string,unknown>={conversationId}){
 measuring++;const ws=new WebSocket(`ws://127.0.0.1:${app!.server.port}/ws`);
 try{await new Promise<void>((done,fail)=>{ws.onopen=()=>done();ws.onerror=()=>fail(new Error('RPC connect failed'));});return await new Promise<any>((done,fail)=>{const requestId=crypto.randomUUID(),timer=setTimeout(()=>fail(new Error('Publication read timed out')),10000);ws.onmessage=event=>{const reply=JSON.parse(String(event.data));if(reply.id!==requestId&&reply.requestId!==requestId)return;clearTimeout(timer);reply.error?fail(new Error(JSON.stringify(reply.error))):done(reply.data);};ws.send(JSON.stringify({id:requestId,type:'REQ',sessionId:'global',method:'operation.invoke',data:{name:'neo.publication.read',input},timestamp:new Date().toISOString(),version:'1.0.0'}));});}
 finally{ws.close();measuring--;}
}
async function mcp(who:string){measuring++;try{const handler=createOperationMcpHandler(()=>app!.sessionManager.getOperationRegistry(),()=>({sessionId:who,role:'neo'}));const reply=await handler({name:'neo.publication.read',input:{conversationId}});assert(!reply.isError,JSON.stringify(reply));return JSON.parse(reply.content[0].text);}finally{measuring--;}}
try{
 await open();await app!.db.createSession({id:root,title:'Synthetic publication page',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,totalCost:0,toolCallCount:0}});
 sql().exec("DELETE FROM neo_conversation; DELETE FROM neo_session_bindings WHERE kind='neo'");new NeoRepository(sql()).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 const ledger=new NeoPublicationRepository(sql()),stored=[];
 for(let n=1;n<=7;n++){const result=ledger.append({conversationId,publicationId:id(n),verbatim:true,fullText:n===1?text:`Fictional reply ${n} 甲🙂`,links:[]});assert(result.accepted);stored.push(result.publication);}
 assert(ledger.append({conversationId:foreign,publicationId:id(8),verbatim:true,fullText:'Foreign row must stay private.',links:[]}).accepted);
 const payload=sql().prepare('SELECT payload_json AS value FROM neo_publications WHERE publication_id=?').get(id(1)) as {value:string};sql().prepare('UPDATE neo_publications SET payload_json=? WHERE publication_id=?').run('{}',id(1));
 await assert.rejects(read(),/Invalid stored Neo publication/);evidence.conversationAfterFailedRead=sql().prepare('SELECT id FROM neo_conversation').get()??null;
 assert.equal(evidence.conversationAfterFailedRead,null,'Failed page decoding must roll conversation initialization back');
 sql().prepare('UPDATE neo_publications SET payload_json=? WHERE publication_id=?').run(payload.value,id(1));
 evidence.race=await Promise.all([read(),read()]);for(const reply of evidence.race){assert(reply.ok);assert.deepEqual(reply.items,stored);assert.equal(hash(reply.items[0].fullText),hash(text));}
 assert.equal(sql().prepare('SELECT count(*) AS n FROM neo_conversation').get().n,1);
 evidence.forward=await read({conversationId,after:stored[1].sequence,limit:2});assert.deepEqual(evidence.forward.items,stored.slice(2,4));
 evidence.tail=await read({conversationId,before:Number.MAX_SAFE_INTEGER,limit:3});assert.deepEqual(evidence.tail.items,stored.slice(4));
 evidence.older=await read({conversationId,before:stored[4].sequence,limit:3});assert.deepEqual(evidence.older.items,stored.slice(1,4));
 evidence.empty=await read({conversationId,after:Number.MAX_SAFE_INTEGER});assert.deepEqual(evidence.empty,{ok:true,conversationId,items:[],nextAfter:Number.MAX_SAFE_INTEGER});
 evidence.foreign=await read({conversationId:foreign});assert.deepEqual(evidence.foreign,{ok:false,reason:'conversation_not_found'});
 evidence.unbound=await mcp('neo:unbound-synthetic');assert.equal(evidence.unbound.ok,false);assert.equal(evidence.unbound.reason.split(':')[0],'human_only');
 evidence.bound=await mcp(root);assert.deepEqual(evidence.bound,evidence.race[0]);
 const before=evidence.race[0];await app!.cleanup();app=undefined;await open();evidence.reopened=await read();assert.deepEqual(evidence.reopened,before);
 if(mode==='verify'){
  const gate=new Promise<void>(done=>{parked=done;});park=true;const pending=mcp(root);
  await Promise.race([gate,new Promise<never>((_,fail)=>setTimeout(()=>fail(new Error('Page did not reach gateway boundary')),5000))]);
  measuring--;try{sql().prepare('DELETE FROM neo_session_bindings WHERE session_id=?').run(root);}finally{measuring++;}release();evidence.staleBinding=await pending;assert.equal(evidence.staleBinding.ok,false);assert.equal(evidence.staleBinding.reason.split(':')[0],'human_only');
  assert.deepEqual(mainSql,[],'Publication page SQL must leave main');
 }else assert(mainSql.length>0,'Baseline must show page SQL on main');
 evidence.textHash=hash(text);evidence.verified=true;
}finally{release();await app?.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;evidence.mainSql=mainSql;evidence.commands=commands;writeFileSync(join(run,'evidence/lane-a-publication-page-db.json'),JSON.stringify(evidence,null,2));}
