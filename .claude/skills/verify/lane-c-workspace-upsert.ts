import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run=resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data')));
for(const key of ['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','GITHUB_TOKEN'])assert.equal(process.env[key],undefined);
for(const name of ['home','workspace','bin','evidence'])mkdirSync(join(run,name),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o755});process.env.PATH=join(run,'bin')+':'+process.env.PATH;
const {createDaemonApp}=await import('../../../packages/daemon/src/app.ts');
const {getConfig}=await import('../../../packages/daemon/src/config.ts');
const {JobQueueProcessor}=await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const {Database:SQLite}=await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const {workspaceHistoryUpsertWrites}=await import('../../../packages/daemon/src/storage/repositories/workspace-history-upsert-write.ts');
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const NativeWorker=globalThis.Worker;const nativeFetch=globalThis.fetch;const prepare=SQLite.prototype.prepare;const start=JobQueueProcessor.prototype.start;
const processors=new Set<InstanceType<typeof JobQueueProcessor>>();
let main:InstanceType<typeof SQLite>|undefined;let measuring=false;let mainSqlAttempts=0;let commandPosts=0;let rejectNext=false;let loseNext=false;
const metrics:{roundTripMs:number;requestBytes:number;replyBytes:number;encodeMs:number}[]=[];
SQLite.prototype.prepare=function(...args){
 const connection=this;const statement=Reflect.apply(prepare,this,args);
 if(!/INSERT\s+INTO\s+workspace_history|SELECT\s+path,\s*last_used_at,\s*use_count\s+FROM\s+workspace_history\s+WHERE\s+path/i.test(args[0]))return statement;
 return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...values:unknown[])=>{
  if(measuring&&connection===main&&['run','get','all','iterate','values'].includes(String(key))){mainSqlAttempts++;throw new Error('workspace-upsert SQL reached main');}
  return Reflect.apply(value,target,values);
 };}});
};
globalThis.Worker=function(url:string|URL,options?:WorkerOptions){
 const worker=new NativeWorker(url,options);
 if(String(url).endsWith('/db-gateway-worker.ts')){
  const post=worker.postMessage.bind(worker);const sent=new Map<number,{at:number;bytes:number}>();const lost=new Set<number>();let receive:((event:MessageEvent)=>void)|null=null;
  Object.defineProperty(worker,'onmessage',{configurable:true,get:()=>receive,set:(handler:typeof receive)=>{receive=handler;}});
  worker.addEventListener('message',event=>{
   const request=sent.get(event.data.id);if(request){sent.delete(event.data.id);if(!event.data.error){const at=performance.now();const encoded=JSON.stringify(event.data.result);metrics.push({roundTripMs:at-request.at,requestBytes:request.bytes,replyBytes:Buffer.byteLength(encoded),encodeMs:performance.now()-at});}}
   if(lost.delete(event.data.id)&&!event.data.error){worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic committed workspace-upsert reply lost; outcome unknown',cancelable:true}));return;}
   receive?.call(worker,event);
  });
  worker.postMessage=((message:{id:number;op?:string;lane?:string;args?:unknown})=>{
   if(message.op==='workspace.history.upsert.write'){
    commandPosts++;assert.equal(message.lane,'write');assert.deepEqual(message.args&&Object.keys(message.args).sort(),['args','method']);const args=message.args as {method:string;args:[string,number]};assert.equal(args.method,'upsert');assert.equal(args.args.length,2);assert.equal(typeof args.args[0],'string');assert.equal(typeof args.args[1],'number');
    if(rejectNext){rejectNext=false;queueMicrotask(()=>worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic workspace upsert rejected before commit',cancelable:true})));return;}
    sent.set(message.id,{at:performance.now(),bytes:Buffer.byteLength(JSON.stringify(message.args))});if(loseNext){loseNext=false;lost.add(message.id);}
   }
   post(message);
  }) as typeof worker.postMessage;
 }
 return worker;
} as unknown as typeof Worker;
globalThis.fetch=(()=>{throw new Error('External HTTP refused by workspace-upsert fixture');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;let transport:InstanceType<typeof WebSocketClientTransport>|undefined;let lock:InstanceType<typeof SQLite>|undefined;let timer:ReturnType<typeof setInterval>|undefined;
const evidence:Record<string,unknown>={};
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return start.call(this);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=start;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 type Row={path:string;last_used_at:number;use_count:number};
 const upsert=(path:string,now:number)=>app!.db.gateway.call(workspaceHistoryUpsertWrites,'upsert',path,now);
 const history=()=>hub.request<{entries:{path:string;lastUsedAt:number;useCount:number}[]}>('workspace.history',{});
 const entry=async(path:string)=>(await history()).entries.find(e=>e.path===path);
 const at=Date.now();const first=join(run,'workspace','first');const cached=main.prepare('INSERT INTO workspace_history(path,last_used_at,use_count)VALUES(?,?,1)');measuring=true;
 assert.throws(()=>cached.run(first,at),/workspace-upsert SQL reached main/);assert.throws(()=>main!.prepare('SELECT path, last_used_at, use_count FROM workspace_history WHERE path=?').get(first),/workspace-upsert SQL reached main/);assert.equal(mainSqlAttempts,2);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
 let previous=performance.now();let maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
 const cold=performance.now();let receipt:Row;try{receipt=await upsert(first,at);}catch(error){evidence.commandFailure=String(error);throw error;}
 assert.deepEqual(receipt,{path:first,last_used_at:at,use_count:1});assert.deepEqual(structuredClone(receipt),receipt);assert.deepEqual(await entry(first),{path:first,lastUsedAt:at,useCount:1});evidence.firstCommandMs=performance.now()-cold;evidence.committedRowVisibleThroughPublicHistory=true;
 const again=await upsert(first,at+1);assert.deepEqual(again,{path:first,last_used_at:at+1,use_count:2});assert.equal((await entry(first))?.useCount,2);evidence.counterAndSuppliedTimePreserved=true;
 const concurrent=join(run,'workspace','concurrent');const receipts=await Promise.all([1,2,3,4].map(offset=>upsert(concurrent,at+offset)));assert.deepEqual(receipts.map(r=>r.use_count).sort(),[1,2,3,4]);assert.deepEqual(receipts.map(r=>r.last_used_at),[1,2,3,4].map(n=>at+n));assert.equal((await entry(concurrent))?.useCount,4);evidence.concurrentCountersSerialized=true;
 const literal=join(run,'workspace',"quoted-'工作区");assert.deepEqual(await upsert(literal,at),{path:literal,last_used_at:at,use_count:1});evidence.literalMetadataPathPreserved=true;
 main.exec("CREATE TRIGGER reject_workspace_upsert BEFORE UPDATE ON workspace_history WHEN NEW.path LIKE '%/first' BEGIN SELECT RAISE(ABORT,'synthetic workspace upsert failure');END");await assert.rejects(upsert(first,at+20),/synthetic workspace upsert failure/);assert.deepEqual(await entry(first),{path:first,lastUsedAt:at+1,useCount:2});main.exec('DROP TRIGGER reject_workspace_upsert');evidence.failedWriteKeepsPreviousCounterAndTime=true;
 const held=join(run,'workspace','held');main.exec('CREATE TABLE synthetic_workspace_upsert_lock(value INTEGER);INSERT INTO synthetic_workspace_upsert_lock VALUES(0)');lock=new SQLite(app.db.getDbPath());lock.exec('BEGIN IMMEDIATE');lock.prepare('UPDATE synthetic_workspace_upsert_lock SET value=1').run();const beforeHeld=commandPosts;const capturedAt=Date.now();let settled=false;const heldStart=performance.now();const pending=upsert(held,capturedAt).finally(()=>{settled=true;});const deadline=performance.now()+4000;while(commandPosts===beforeHeld){assert(performance.now()<deadline);await new Promise(done=>setTimeout(done,5));}assert.equal(settled,false);assert.equal(await entry(held),undefined);const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileWriterHeldMs=performance.now()-healthAt;await new Promise(done=>setTimeout(done,1200));assert.equal(settled,false);lock.exec('COMMIT');lock.close();lock=undefined;assert.deepEqual(await pending,{path:held,last_used_at:capturedAt,use_count:1});assert.equal((await entry(held))?.lastUsedAt,capturedAt);evidence.deliberatelyHeldWriterMs=performance.now()-heldStart;evidence.admissionTimestampRetainedAcrossWriterWait=true;
 const refused=join(run,'workspace','refused');const beforeRefusal=commandPosts;rejectNext=true;await assert.rejects(upsert(refused,at),/before commit/);assert.equal(await entry(refused),undefined);assert.equal(commandPosts,beforeRefusal+1);evidence.preCommitFailureLeavesNoRow=true;
 const unknown=join(run,'workspace','unknown');const beforeLoss=commandPosts;loseNext=true;await assert.rejects(upsert(unknown,at),/outcome unknown/);assert.deepEqual(await entry(unknown),{path:unknown,lastUsedAt:at,useCount:1});await new Promise(done=>setTimeout(done,100));assert.equal(commandPosts,beforeLoss+1);assert.deepEqual(await upsert(unknown,at+10),{path:unknown,last_used_at:at+10,use_count:2});assert.equal(commandPosts,beforeLoss+2);evidence.unknownOutcomeNotAutomaticallyReplayed=true;
 assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.commandPosts=commandPosts;evidence.publicWorkspaceAddExercised=false;
}finally{
 measuring=false;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}
 try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}
 finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.Worker=NativeWorker;globalThis.fetch=nativeFetch;evidence.mainSqlAttempts=mainSqlAttempts;evidence.workerMetrics=metrics;writeFileSync(join(run,'evidence/workspace-upsert.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok native history-upsert command returns its committed counter/time row with public history readback and no main target SQL; public workspace.add wiring is separate');
