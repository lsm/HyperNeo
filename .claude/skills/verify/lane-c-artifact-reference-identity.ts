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
const {createArtifactReferenceResolve}=await import('../../../packages/daemon/src/lib/artifacts/resolve-operation.ts');
const {NeoAskTodoRepository}=await import('../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts');
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const NativeWorker=globalThis.Worker;const nativeFetch=globalThis.fetch;const prepare=SQLite.prototype.prepare;const start=JobQueueProcessor.prototype.start;
const processors=new Set<InstanceType<typeof JobQueueProcessor>>();
let main:InstanceType<typeof SQLite>|undefined;let measuring=false;let readOnlyVerification=false;let readOnlyIdentitySelects=0;let mainRowSaves=0;let mainSqlAttempts=0;let beforeIdentityReceipt:(()=>void)|undefined;let commandPosts=0;let rejectNext=false;let loseNext=false;
const metrics:{roundTripMs:number;requestBytes:number;replyBytes:number;encodeMs:number}[]=[];
SQLite.prototype.prepare=function(...args){
 const connection=this;const statement=Reflect.apply(prepare,this,args);if(/INSERT INTO artifact_files/i.test(args[0]))return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...values:unknown[])=>{if(measuring&&connection===main&&key==='run')mainRowSaves++;return Reflect.apply(value,target,values);};}});
 if(!/INSERT\s+OR\s+IGNORE\s+INTO\s+artifact_file_identity|SELECT\s+daemon_id\s+FROM\s+artifact_file_identity\b/i.test(args[0]))return statement;
 return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...values:unknown[])=>{
  if(measuring&&connection===main&&['run','get','all','iterate','values'].includes(String(key))){if(readOnlyVerification&&/^SELECT/i.test(args[0]))readOnlyIdentitySelects++;else{mainSqlAttempts++;throw new Error('reference identity SQL reached main');}}
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
   if(request&&!event.data.error)beforeIdentityReceipt?.();
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
globalThis.fetch=(()=>{throw new Error('External HTTP refused by artifact reference fixture');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;let transport:InstanceType<typeof WebSocketClientTransport>|undefined;let lock:InstanceType<typeof SQLite>|undefined;let timer:ReturnType<typeof setInterval>|undefined;
const evidence:Record<string,unknown>={};
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return start.call(this);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=start;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);
 main.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Synthetic',?,'now','now','active','{}','{}')").run('synthetic-neo',join(run,'workspace'));
 const work=new NeoAskTodoRepository(main);work.openAsk({id:'synthetic-artifact-ask',sessionId:'synthetic-neo',projectId:null,originMessageId:null,title:'Synthetic reference',request:'Synthetic proof only',createdAt:Date.now()});
 work.addTodo('synthetic-artifact-todo','synthetic-artifact-ask',{title:'Synthetic document',doneWhen:'',instruction:null,check:null,named:null},Date.now());
 const setSource=(value:string)=>main!.prepare('UPDATE neo_todos SET evidence=? WHERE id=?').run(value,'synthetic-artifact-todo');setSource('Read `report.md`.');
 const source=join(run,'workspace/report.md');const text='# Synthetic reference snapshot\n';writeFileSync(source,text);
 const input={requestId:'11111111-1111-4111-8111-111111111111',sourceMessageOrCard:{kind:'todo' as const,id:'synthetic-artifact-todo'},reference:'report.md'};
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 type Reply={accepted:true;artifact:{daemonId:string;artifactId:string;kind:string;byteLength:number}};
 const invoke=(value=input)=>hub.request<Reply>('operation.invoke',{name:'artifact.reference.resolve',input:value});
 const identity=()=>main!.prepare('SELECT daemon_id AS retained FROM artifact_file_identity').get()?.retained;
 const count=()=>Number(main!.prepare('SELECT COUNT(*) AS n FROM artifact_files').get()!.n);
 const wait=async(predicate:()=>boolean)=>{const until=performance.now()+5000;while(!predicate()){assert(performance.now()<until);await new Promise(done=>setTimeout(done,5));}};
 assert.equal(identity(),undefined);assert.equal(count(),0);
 const cached=main.prepare('INSERT OR IGNORE INTO artifact_file_identity VALUES(1,?)');measuring=true;assert.throws(()=>cached.run(crypto.randomUUID()),/reference identity SQL reached main/);assert.throws(()=>main!.prepare('SELECT daemon_id FROM artifact_file_identity').get(),/reference identity SQL reached main/);assert.equal(mainSqlAttempts,2);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
 const op=createArtifactReferenceResolve(()=>main!,join(run,'data'),join(run,'home'));assert.deepEqual(await op.execute(input,{source:'mcp',role:'neo',sessionId:'synthetic-neo'}),{accepted:false,reason:'unavailable'});assert.equal(commandPosts,0);evidence.nonHumanAndDiscoveryDoNotInitialize=true;
 await assert.rejects(hub.request('operation.invoke',{name:'artifact.reference.resolve',input:{sourceMessageOrCard:input.sourceMessageOrCard,reference:input.reference}}),/requestId/);assert.equal(commandPosts,0);evidence.retryIdValidationBeforeInitialization=true;
 let previous=performance.now();let maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
 rejectNext=true;const beforeRefusal=commandPosts;await assert.rejects(invoke(),/before commit/);assert.equal(commandPosts,beforeRefusal+1);assert.equal(identity(),undefined);assert.equal(count(),0);assert(!existsSync(join(run,'data/artifacts/blobs')));await new Promise(done=>setTimeout(done,60));assert.equal(commandPosts,beforeRefusal+1);evidence.admissionFailureNeverCapturesOrFallsBack=true;
 loseNext=true;const beforeLoss=commandPosts;await assert.rejects(invoke(),/outcome unknown/);const retained=identity();assert.equal(typeof retained,'string');assert.equal(count(),0);assert(!existsSync(join(run,'data/artifacts/blobs')));await new Promise(done=>setTimeout(done,100));assert.equal(commandPosts,beforeLoss+1);evidence.unknownOutcomeNeverAutomaticallyReplayed=true;
 main.exec('CREATE TABLE synthetic_reference_lock(value INTEGER);INSERT INTO synthetic_reference_lock VALUES(0)');lock=new SQLite(app.db.getDbPath());lock.exec('BEGIN IMMEDIATE');lock.prepare('UPDATE synthetic_reference_lock SET value=1').run();const beforeHeld=commandPosts;let settled=false;const at=performance.now();const pending=invoke().finally(()=>{settled=true;});await wait(()=>commandPosts>beforeHeld);assert.equal(commandPosts,beforeHeld+1);assert.equal(settled,false);assert.equal(count(),0);
 const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileWriterHeldMs=performance.now()-healthAt;await new Promise(done=>setTimeout(done,1200));assert.equal(settled,false);beforeIdentityReceipt=()=>{beforeIdentityReceipt=undefined;setSource('Reference removed before planning resumes.');};lock.exec('COMMIT');lock.close();lock=undefined;
 assert.deepEqual(await pending,{accepted:false,reason:'unavailable'});evidence.deliberatelyHeldInitializationMs=performance.now()-at;assert.equal(count(),0);assert.equal(commandPosts,beforeHeld+1);evidence.sourceLoadedAfterCommittedIdentityReceipt=true;
 setSource('Read `report.md`.');const captureAt=performance.now();const [first,concurrent]=await Promise.all([invoke(),invoke()]);evidence.uncontendedConcurrentResolutionMs=performance.now()-captureAt;assert.deepEqual(concurrent,first);const deno=!!Reflect.get(globalThis,'Deno');
 if(deno){assert.deepEqual(first,{accepted:false,reason:'safe_open_unavailable'});assert.equal(count(),0);assert.equal(identity(),retained);evidence.existingDenoCaptureFailsClosed=true;evidence.successfulCaptureAndSnapshotReadVerified=false;}
 else{assert.equal(first.accepted,true,JSON.stringify(first));assert.equal(first.artifact.daemonId,retained);assert.equal(first.artifact.kind,'markdown');assert.equal(count(),1);assert.deepEqual(await invoke(),first);assert.equal(count(),1);evidence.concurrentCaptureAndRetryRetainOneReceipt=true;
  const changing={...input,requestId:'22222222-2222-4222-8222-222222222222'};const before=count();beforeIdentityReceipt=()=>{if(count()>before){beforeIdentityReceipt=undefined;setSource('Reference removed after capture.');}};assert.deepEqual(await invoke(changing),{accepted:false,reason:'unavailable'});assert.equal(beforeIdentityReceipt,undefined);assert.equal(count(),before+1);evidence.postCaptureSourceRevalidationWithholdsReceiptButRetainsSnapshot=true;
  setSource('Read `report.md`.');const recovered=await invoke(changing);assert.equal(recovered.accepted,true);assert.equal(count(),before+1);assert.deepEqual(await invoke(changing),recovered);
  readOnlyVerification=true;try{const read=await hub.request<{accepted:boolean;data:string}>('operation.invoke',{name:'artifact.file.read',input:{artifactId:first.artifact.artifactId}});assert.equal(read.accepted,true);assert.equal(Buffer.from(read.data,'base64').toString(),text);}finally{readOnlyVerification=false;}assert(readOnlyIdentitySelects>0);evidence.publicSnapshotBytesRetained=true;evidence.existingReadOnlyIdentitySelectsOutsideResolver=readOnlyIdentitySelects;evidence.successfulCaptureAndSnapshotReadVerified=true;
 }
 assert.deepEqual(await invoke({...input,reference:'not-in-source.md'}),{accepted:false,reason:'unavailable'});assert.deepEqual(await invoke({...input,sourceMessageOrCard:{kind:'todo',id:'synthetic-missing'}}),{accepted:false,reason:'unavailable'});setSource('Read `.ssh/key.md`.');assert.deepEqual(await invoke({...input,reference:'.ssh/key.md'}),{accepted:false,reason:'sensitive_path'});setSource('Read `report.md`.');evidence.sourceAndSensitiveRefusalsPreserved=true;
 assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.mainRowSaves=mainRowSaves;evidence.commandPosts=commandPosts;evidence.fullTransitiveSourceCaptureGraphMeasured=false;evidence.pass=true;
}finally{
 measuring=false;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}
 try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}
 finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.Worker=NativeWorker;globalThis.fetch=nativeFetch;evidence.resolverMainIdentitySqlAttempts=mainSqlAttempts;evidence.workerMetrics=metrics;writeFileSync(join(run,'evidence/artifact-reference-identity.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok real reference resolver awaits committed identity and revalidates source; zero resolver identity SQL on main; Bun snapshots and existing Deno refusal are distinguished');
