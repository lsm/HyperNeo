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
const {defineDbOp}=await import('../../../packages/daemon/src/storage/db-gateway/db-op.ts');
const {ArtifactFileRepository}=await import('../../../packages/daemon/src/storage/repositories/artifact-file-repository.ts');
const command=defineDbOp<{method:string;args:[string]},string>({name:'artifact.identity.ensure.write',mode:'write',run:()=>{throw new Error('Artifact identity construction must execute in native worker');}});
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const NativeWorker=globalThis.Worker;const nativeFetch=globalThis.fetch;const prepare=SQLite.prototype.prepare;const start=JobQueueProcessor.prototype.start;
const processors=new Set<InstanceType<typeof JobQueueProcessor>>();
let main:InstanceType<typeof SQLite>|undefined;let measuring=false;let mainSqlAttempts=0;let commandPosts=0;let rejectNext=false;let loseNext=false;
const metrics:{roundTripMs:number;requestBytes:number;replyBytes:number;encodeMs:number}[]=[];
SQLite.prototype.prepare=function(...args){
 const connection=this;const statement=Reflect.apply(prepare,this,args);
 if(!/INSERT\s+OR\s+IGNORE\s+INTO\s+artifact_file_identity|SELECT\s+daemon_id\s+FROM\s+artifact_file_identity\b/i.test(args[0]))return statement;
 return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...values:unknown[])=>{
  if(measuring&&connection===main&&['run','get','all','iterate','values'].includes(String(key))){mainSqlAttempts++;throw new Error('artifact-identity-command SQL reached main');}
  return Reflect.apply(value,target,values);
 };}});
};
globalThis.Worker=function(url:string|URL,options?:WorkerOptions){
 const worker=new NativeWorker(url,options);
 if(String(url).endsWith('/db-gateway-worker.ts')){
  const post=worker.postMessage.bind(worker);const sent=new Map<number,{at:number;bytes:number}>();const lost=new Set<number>();let receive:((event:MessageEvent)=>void)|null=null;
  Object.defineProperty(worker,'onmessage',{configurable:true,get:()=>receive,set:(handler:typeof receive)=>{receive=handler;}});
  worker.addEventListener('message',event=>{
   const request=sent.get(event.data.id);if(request){sent.delete(event.data.id);if(event.data.error)assert.equal(event.data.changes,undefined);else assert.deepEqual(event.data.changes,[]);if(!event.data.error){const at=performance.now();const encoded=JSON.stringify(event.data.result);metrics.push({roundTripMs:at-request.at,requestBytes:request.bytes,replyBytes:Buffer.byteLength(encoded),encodeMs:performance.now()-at});}}
   if(lost.delete(event.data.id)&&!event.data.error){worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic committed artifact-identity-command reply lost; outcome unknown',cancelable:true}));return;}
   receive?.call(worker,event);
  });
  worker.postMessage=((message:{id:number;op?:string;lane?:string;args?:unknown})=>{
   if(message.op==='artifact.identity.ensure.write'){
    commandPosts++;assert.equal(message.lane,'write');assert.deepEqual(message.args&&Object.keys(message.args).sort(),['args','method']);const args=message.args as {method:string;args:[string]};assert.equal(args.method,'ensure');assert.equal(args.args.length,1);assert.equal(typeof args.args[0],'string');
    if(rejectNext){rejectNext=false;queueMicrotask(()=>worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic artifact identity initialization rejected before commit',cancelable:true})));return;}
    sent.set(message.id,{at:performance.now(),bytes:Buffer.byteLength(JSON.stringify(message.args))});if(loseNext){loseNext=false;lost.add(message.id);}
   }
   post(message);
  }) as typeof worker.postMessage;
 }
 return worker;
} as unknown as typeof Worker;
globalThis.fetch=(()=>{throw new Error('External HTTP refused by artifact-identity-command fixture');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;let transport:InstanceType<typeof WebSocketClientTransport>|undefined;let lock:InstanceType<typeof SQLite>|undefined;let timer:ReturnType<typeof setInterval>|undefined;
const evidence:Record<string,unknown>={};
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return start.call(this);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=start;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 const ensure=(candidate:string)=>app!.db.gateway.run(command,{method:'ensure',args:[candidate]});
 const row=()=>{const value=main!.prepare('SELECT singleton, daemon_id AS retained FROM artifact_file_identity').get() as {singleton:number;retained:string}|null;return value?{...value}:null;};
 const count=()=>Number(main!.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()!.n);
 const uuid=()=>crypto.randomUUID();const wait=async(predicate:()=>boolean)=>{const until=performance.now()+5000;while(!predicate()){assert(performance.now()<until);await new Promise(done=>setTimeout(done,5));}};
 assert.equal(count(),0);assert.equal(main.prepare('SELECT COUNT(*) AS n FROM artifact_files').get()!.n,0);
 const cached=main.prepare('INSERT OR IGNORE INTO artifact_file_identity VALUES(1,?)');measuring=true;assert.throws(()=>cached.run(uuid()),/artifact-identity-command SQL reached main/);assert.throws(()=>main!.prepare('SELECT daemon_id FROM artifact_file_identity').get(),/artifact-identity-command SQL reached main/);assert.equal(mainSqlAttempts,2);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
 let previous=performance.now();let maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
 const candidates=[uuid(),uuid(),uuid(),uuid()];const at=performance.now();const receipts=await Promise.all(candidates.map(ensure));evidence.firstInitializationBatchMs=performance.now()-at;const winner=receipts[0];assert(candidates.includes(winner));assert(receipts.every(value=>value===winner));assert.deepEqual(row(),{singleton:1,retained:winner});assert.equal(count(),1);assert.equal(structuredClone(winner),winner);evidence.concurrentInitializationRetainsOneCommittedIdentity=true;
 assert.equal(await ensure(uuid()),winner);assert.equal(count(),1);evidence.laterCandidateCannotReplaceIdentity=true;
 const known=new ArtifactFileRepository(main,winner);assert.equal(known.daemonId,winner);assert.equal(mainSqlAttempts,0);evidence.committedIdentityConstructorExecutesNoSql=true;
 main.exec('CREATE TABLE synthetic_identity_lock(value INTEGER);INSERT INTO synthetic_identity_lock VALUES(0)');lock=new SQLite(app.db.getDbPath());lock.exec('BEGIN IMMEDIATE');lock.prepare('UPDATE synthetic_identity_lock SET value=1').run();const beforeHeld=commandPosts;let settled=false;const heldAt=performance.now();const pending=ensure(uuid()).finally(()=>{settled=true;});await wait(()=>commandPosts>beforeHeld);assert.equal(settled,false);assert.deepEqual(row(),{singleton:1,retained:winner});const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileWriterHeldMs=performance.now()-healthAt;await new Promise(done=>setTimeout(done,1200));assert.equal(settled,false);lock.exec('COMMIT');lock.close();lock=undefined;assert.equal(await pending,winner);evidence.deliberatelyHeldWriterMs=performance.now()-heldAt;evidence.receiptWaitsForCommit=true;
 const beforeRefusal=commandPosts;rejectNext=true;await assert.rejects(ensure(uuid()),/before commit/);assert.equal(row()?.retained,winner);assert.equal(commandPosts,beforeRefusal+1);evidence.preCommitFailureKeepsIdentity=true;
 const beforeLoss=commandPosts;loseNext=true;await assert.rejects(ensure(uuid()),/outcome unknown/);assert.equal(row()?.retained,winner);await new Promise(done=>setTimeout(done,100));assert.equal(commandPosts,beforeLoss+1);assert.equal(await ensure(uuid()),winner);assert.equal(commandPosts,beforeLoss+2);evidence.unknownOutcomeNeverAutomaticallyReplayed=true;
 assert.equal(main.prepare('SELECT COUNT(*) AS n FROM artifact_files').get()!.n,0);main.exec("DELETE FROM artifact_file_identity;CREATE TABLE synthetic_identity_effects(value INTEGER);CREATE TRIGGER hide_identity AFTER INSERT ON artifact_file_identity BEGIN INSERT INTO synthetic_identity_effects VALUES(1);DELETE FROM artifact_file_identity WHERE singleton=NEW.singleton;END");await assert.rejects(ensure(uuid()),/daemon_id|null|undefined/);assert.equal(count(),0);assert.equal(main.prepare('SELECT COUNT(*) AS n FROM synthetic_identity_effects').get()!.n,0);main.exec('DROP TRIGGER hide_identity');assert.equal(await ensure(winner),winner);evidence.missingReceiptRollsBackCreationAndTriggerEffects=true;evidence.syntheticEmptyIdentityResetCount=1;
 assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.commandPosts=commandPosts;evidence.publicArtifactActivationExercised=false;evidence.fullCaptureOwnershipGraphMeasured=false;evidence.pass=true;
}finally{
 measuring=false;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}
 try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}
 finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.Worker=NativeWorker;globalThis.fetch=nativeFetch;evidence.mainSqlAttempts=mainSqlAttempts;evidence.workerMetrics=metrics;writeFileSync(join(run,'evidence/artifact-identity-command.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok native artifact identity command commits one retained UUID with no target SQL on main; public artifact activation remains separate');
