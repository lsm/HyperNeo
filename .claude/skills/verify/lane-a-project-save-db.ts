import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const [mode,directory]=process.argv.slice(2),run=resolve(directory);assert(['before','verify'].includes(mode));
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data')));
for(const key of ['GH_TOKEN','GITHUB_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'])assert.equal(process.env[key],undefined);
for(const dir of ['bin','evidence','workspace'])mkdirSync(join(run,dir),{recursive:true});writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP refused');}) as typeof fetch;
const root='neo:10000000-0000-4000-8000-000000009255',text='项目🙂\n'.repeat(2999),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined,measuring=0,park=false,parked:()=>void=()=>{},release:()=>void=()=>{},maxLagMs=0,last=performance.now();
let lock:ReturnType<typeof spawn>|undefined,unlocked:Promise<void>|undefined;
const mainSql:string[]=[],commands:unknown[]=[],waiting=new Map<string,{done:(v:any)=>void;fail:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const evidence:Record<string,any>={verified:false,mode,consumer:'Real public WebSocket project.save/snapshot, system.health RPC and registered MCP saves',limitations:'Synthetic metadata; no filesystem/GitHub/model/GUI, identity alias, core ask/card-reply or whole-daemon SQL claim.'};
const interval=setInterval(()=>{const at=performance.now();if(measuring)maxLagMs=Math.max(maxLagMs,at-last-10);last=at;},10);
const raw=()=>app!.db.getDatabase();
function fixture<T>(fn:()=>T){const before=measuring;measuring=0;try{return fn();}finally{measuring=before;}}
async function open(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);await app.db.updateGlobalSettings({neo:{packs:[]}});
 const db=raw(),prepare=db.prepare.bind(db),send=app.db.gateway.run.bind(app.db.gateway);
 db.prepare=((sql:string)=>{if(measuring&&/neo_concerns|neo_session_bindings/.test(sql))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
 app.db.gateway.run=(async(op,args)=>{const method=(args as {method:string}).method;if(park&&op.name==='neo.project.move'&&method==='save'){park=false;parked();await new Promise<void>(done=>{release=done;});}const start=performance.now(),value=await send(op,args);if(measuring&&method==='save')commands.push({name:op.name,method,mode:op.mode,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value)??'null')});return value;}) as typeof app.db.gateway.run;
 ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('RPC connect failed'));});
 ws.onmessage=event=>{const r=JSON.parse(String(event.data)),id=r.requestId??r.id,w=waiting.get(id);if(!w)return;clearTimeout(w.timer);waiting.delete(id);r.error?w.fail(new Error(JSON.stringify(r.error))):w.done(r.data);};
}
function rpc(method:string,data:unknown={}){return new Promise<any>((done,fail)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{waiting.delete(id);fail(new Error('RPC timeout'));},10000);waiting.set(id,{done,fail,timer});ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method,data,timestamp:new Date().toISOString(),version:'1.0.0'}));});}
async function save(input:unknown){measuring++;try{return await rpc('operation.invoke',{name:'neo.project.save',input});}finally{measuring--;}}
async function mcp(input:unknown,sessionId=root){measuring++;try{const handler=createOperationMcpHandler(()=>app!.sessionManager.getOperationRegistry(),()=>({sessionId,role:'neo'}));const r=await handler({name:'neo.project.save',input});assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);}finally{measuring--;}}
const request={title:'Synthetic 项目',summary:'Retained summary.',context:text,expectedRevision:0};
try{
 await open();
 lock=spawn('/usr/bin/python3',['-c',"import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()",join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
 unlocked=new Promise<void>((done,fail)=>{lock!.once('error',fail);lock!.once('exit',code=>code===0?done():fail(new Error('Synthetic writer failed')));});
 await new Promise<void>((done,fail)=>{const timer=setTimeout(()=>fail(new Error('Writer lock startup timed out')),5000);lock!.stdout!.once('data',chunk=>{clearTimeout(timer);String(chunk).includes('locked')?done():fail(new Error('Writer did not lock'));});lock!.once('error',fail);});
 measuring++;last=performance.now();const started=performance.now(),pending=save(request);await new Promise(done=>setTimeout(done,30));const dispatched=performance.now(),healthStart=performance.now();evidence.health=await rpc('system.health');const healthMs=performance.now()-healthStart;evidence.created=await pending;const saveMs=performance.now()-started;await unlocked;lock=undefined;unlocked=undefined;await new Promise(done=>setTimeout(done,20));measuring--;
 assert(evidence.created.ok);const project=evidence.created.project;assert.equal(hash(project.context),hash(text));
 evidence.contention={healthMs,clientDispatchDelayMs:Math.max(0,dispatched-started-30),saveMs,maxLagMs,affectedSaveUnder250ms:saveMs<250};
 assert(maxLagMs<1000,'Project save must not block the daemon loop for one second');assert(healthMs<250);assert(saveMs>1000,'Fixture must retain real writer contention');
 const second=await save(request);assert(second.ok);assert.notEqual(second.project.id,project.id,'Independent human creates have distinct ids');
 evidence.race=await Promise.all(['First','Second'].map(title=>save({...request,id:project.id,title,expectedRevision:1})));assert.equal(evidence.race.filter((r:any)=>r.ok).length,1);assert(evidence.race.some((r:any)=>r.reason?.startsWith('superseded')));
 evidence.namedCreate=await save({...request,id:'must-not-create'});assert(!evidence.namedCreate.ok);
 evidence.unnamedUpdate=await save({...request,expectedRevision:1});assert(!evidence.unnamedUpdate.ok);
 const winner=evidence.race.find((r:any)=>r.ok).project;assert.equal(winner.revision,2);assert.equal(hash(winner.context),hash(text));
 evidence.snapshot=await rpc('operation.invoke',{name:'neo.snapshot',input:{projectId:project.id}});assert(evidence.snapshot.ok);assert.equal(evidence.snapshot.projects.find((p:any)=>p.id===project.id).title,winner.title);
 await app!.db.createSession({id:root,title:'Synthetic project saver',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,totalCost:0,toolCallCount:0}});fixture(()=>new NeoRepository(raw()).reserveBinding({sessionId:root,kind:'neo',projectId:null}));
 evidence.unbound=await mcp(request,'neo:unbound-synthetic');assert.equal(evidence.unbound.ok,false);
 evidence.bound=await mcp({...request,id:project.id,expectedRevision:2,title:'Bound Neo'});assert(evidence.bound.ok);
 ws.close();await app!.cleanup();app=undefined;await open();evidence.reopened=await rpc('operation.invoke',{name:'neo.snapshot',input:{projectId:project.id}});assert.equal(evidence.reopened.projects.find((p:any)=>p.id===project.id).title,'Bound Neo');
 if(mode==='verify'){
  const gate=new Promise<void>(done=>{parked=done;});park=true;const saving=mcp({...request,id:project.id,expectedRevision:3,title:'Must not save'});
  await Promise.race([gate,new Promise<never>((_,fail)=>setTimeout(()=>fail(new Error('Save did not reach writer')),5000))]);fixture(()=>raw().prepare('DELETE FROM neo_session_bindings WHERE session_id=?').run(root));release();evidence.staleBinding=await saving;assert.equal(evidence.staleBinding.ok,false);
  evidence.afterRefusal=await rpc('operation.invoke',{name:'neo.snapshot',input:{projectId:project.id}});assert.equal(evidence.afterRefusal.projects.find((p:any)=>p.id===project.id).title,'Bound Neo');
  assert.deepEqual(mainSql,[],'Project save admission, lookup and write SQL must leave main');
 }
 evidence.textHash=hash(text);evidence.verified=true;
}finally{
 release();lock?.kill();await unlocked?.catch(()=>{});clearInterval(interval);for(const r of waiting.values())clearTimeout(r.timer);waiting.clear();ws?.close();await app?.cleanup();globalThis.fetch=network;evidence.mainSql=mainSql;evidence.commands=commands;evidence.maxLagMs=maxLagMs;evidence.resourcesStopped=true;writeFileSync(join(run,'evidence/lane-a-project-save-db.json'),JSON.stringify(evidence,null,2));
}
