import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
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
let main:InstanceType<typeof SQLite>|undefined;let measuring=false;let readOnlyVerification=false;let readOnlyIdentitySelects=0;let mainRowSaves=0;let mainSqlAttempts=0;let beforeIdentityPost:((index:number)=>void)|undefined;let beforeIdentityReceipt:((index:number)=>void)|undefined;let commandPosts=0;let rejectAt=0;let loseAt=0;
const diagnosticSteps:string[]=[];
const metrics:{roundTripMs:number;requestBytes:number;replyBytes:number;encodeMs:number}[]=[];
SQLite.prototype.prepare=function(...args){
 const connection=this;const statement=Reflect.apply(prepare,this,args);if(/INSERT INTO artifact_files/i.test(args[0]))return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...values:unknown[])=>{if(measuring&&connection===main&&key==='run')mainRowSaves++;return Reflect.apply(value,target,values);};}});
 if(!/INSERT\s+OR\s+IGNORE\s+INTO\s+artifact_file_identity|SELECT\s+daemon_id\s+FROM\s+artifact_file_identity\b/i.test(args[0]))return statement;
 return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...values:unknown[])=>{
  if(measuring&&connection===main&&['run','get','all','iterate','values'].includes(String(key))){if(readOnlyVerification&&/^SELECT/i.test(args[0]))readOnlyIdentitySelects++;else{mainSqlAttempts++;throw new Error('Git identity SQL reached main');}}
  return Reflect.apply(value,target,values);
 };}});
};
globalThis.Worker=function(url:string|URL,options?:WorkerOptions){
 const worker=new NativeWorker(url,options);
 if(String(url).endsWith('/db-gateway-worker.ts')){
  const post=worker.postMessage.bind(worker);const sent=new Map<number,{at:number;bytes:number;index:number}>();const lost=new Set<number>();let receive:((event:MessageEvent)=>void)|null=null;
  Object.defineProperty(worker,'onmessage',{configurable:true,get:()=>receive,set:(handler:typeof receive)=>{receive=handler;}});
  worker.addEventListener('message',event=>{
   const request=sent.get(event.data.id);if(request){sent.delete(event.data.id);if(event.data.error)assert.equal(event.data.changes,undefined);else assert.deepEqual(event.data.changes,[]);if(!event.data.error){const at=performance.now();const encoded=JSON.stringify(event.data.result);metrics.push({roundTripMs:at-request.at,requestBytes:request.bytes,replyBytes:Buffer.byteLength(encoded),encodeMs:performance.now()-at});}}
   if(request&&!event.data.error){diagnosticSteps.push('reply:'+request.index);try{beforeIdentityReceipt?.(request.index);}catch(error){diagnosticSteps.push('reply-hook-error:'+String(error));throw error;}}
   if(lost.delete(event.data.id)&&!event.data.error){worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic committed artifact-identity-command reply lost; outcome unknown',cancelable:true}));return;}
   receive?.call(worker,event);
  });
  worker.postMessage=((message:{id:number;op?:string;lane?:string;args?:unknown})=>{
   if(message.op==='artifact.identity.ensure.write'){
    commandPosts++;diagnosticSteps.push('post:'+commandPosts);beforeIdentityPost?.(commandPosts);assert.equal(message.lane,'write');assert.deepEqual(message.args&&Object.keys(message.args).sort(),['args','method']);const args=message.args as {method:string;args:[string]};assert.equal(args.method,'ensure');assert.equal(args.args.length,1);assert.equal(typeof args.args[0],'string');
    if(rejectAt===commandPosts){rejectAt=0;queueMicrotask(()=>worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic artifact identity initialization rejected before commit',cancelable:true})));return;}
    sent.set(message.id,{at:performance.now(),bytes:Buffer.byteLength(JSON.stringify(message.args)),index:commandPosts});if(loseAt===commandPosts){loseAt=0;lost.add(message.id);}
   }
   post(message);
  }) as typeof worker.postMessage;
 }
 return worker;
} as unknown as typeof Worker;
globalThis.fetch=(()=>{throw new Error('External HTTP refused by artifact Git fixture');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;let transport:InstanceType<typeof WebSocketClientTransport>|undefined;let lock:InstanceType<typeof SQLite>|undefined;let timer:ReturnType<typeof setInterval>|undefined;
const evidence:Record<string,unknown>={};
try{
 const sha='a'.repeat(40),treeSha='b'.repeat(40);const bytes=Buffer.from('# Synthetic pinned Git 🦊\n'.repeat(60000));const blobSha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');const expectedHash=createHash('sha256').update(bytes).digest('hex');const gitPrefix='repos/synthetic/fixture/git/';
 const commitKey=gitPrefix+'commits/'+sha,treeKey=gitPrefix+'trees/'+treeSha,blobKey=gitPrefix+'blobs/'+blobSha;
 const fixtures={
  [commitKey]:{url:'https://api.github.com/'+commitKey,sha,tree:{sha:treeSha}},
  [treeKey]:{url:'https://api.github.com/'+treeKey,sha:treeSha,truncated:false,tree:[{path:'report.md',mode:'100644',type:'blob',sha:blobSha,size:bytes.length}]},
  [blobKey]:{url:'https://api.github.com/'+blobKey,sha:blobSha,encoding:'base64',size:bytes.length,content:bytes.toString('base64')},
 };
 writeFileSync(join(run,'git-fixtures.json'),JSON.stringify(fixtures));writeFileSync(join(run,'evidence/gh.log'),'');
 writeFileSync(join(run,'bin/gh'),`#!/usr/bin/env python3
import json,pathlib,sys
r=pathlib.Path(__file__).resolve().parent.parent
a=[v for v in sys.argv[1:] if v!='--include']
with (r/'evidence/gh.log').open('a') as f:f.write(json.dumps(a)+'\\n')
fixtures=json.loads((r/'git-fixtures.json').read_text())
if len(a)==4 and a[:3]==['api','--hostname','github.com'] and a[3] in fixtures:
 print(json.dumps(fixtures[a[3]]));sys.exit(0)
sys.stderr.write('Refused non-fixture gh call');sys.exit(1)
`,{mode:0o755});
 const ghCalls=()=>readFileSync(join(run,'evidence/gh.log'),'utf8').split('\n').filter(Boolean).length;
 JobQueueProcessor.prototype.start=function(){processors.add(this);return start.call(this);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=start;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);
 main.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Synthetic',?,'now','now','active','{}','{}')").run('synthetic-neo',join(run,'workspace'));
 const work=new NeoAskTodoRepository(main);work.openAsk({id:'synthetic-artifact-ask',sessionId:'synthetic-neo',projectId:null,originMessageId:null,title:'Synthetic Git capture',request:'Synthetic proof only',createdAt:Date.now()});work.addTodo('synthetic-artifact-todo','synthetic-artifact-ask',{title:'Synthetic document',doneWhen:'',instruction:null,check:null,named:null},Date.now());
 const reference=`https://github.com/synthetic/fixture/blob/${sha}/report.md`;const setSource=(value:string)=>main!.prepare('UPDATE neo_todos SET evidence=? WHERE id=?').run(value,'synthetic-artifact-todo');setSource(reference);main.prepare('UPDATE neo_todos SET repo=? WHERE id=?').run('github.com/synthetic/fixture','synthetic-artifact-todo');
 const input={requestId:'11111111-1111-4111-8111-111111111111',sourceMessageOrCard:{kind:'todo' as const,id:'synthetic-artifact-todo'},reference};
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 type Reply={accepted:true;artifact:{daemonId:string;artifactId:string;kind:string;byteLength:number}};
 const invoke=(value=input)=>hub.request<Reply>('operation.invoke',{name:'artifact.reference.resolve',input:value});
 const identity=()=>main!.prepare('SELECT daemon_id AS retained FROM artifact_file_identity').get()?.retained;const count=()=>Number(main!.prepare('SELECT COUNT(*) AS n FROM artifact_files').get()!.n);
 const wait=async(predicate:()=>boolean)=>{const until=performance.now()+5000;while(!predicate()){assert(performance.now()<until);await new Promise(done=>setTimeout(done,5));}};
 const cached=main.prepare('INSERT OR IGNORE INTO artifact_file_identity VALUES(1,?)');measuring=true;assert.throws(()=>cached.run(crypto.randomUUID()),/Git identity SQL reached main/);assert.throws(()=>main!.prepare('SELECT daemon_id FROM artifact_file_identity').get(),/Git identity SQL reached main/);assert.equal(mainSqlAttempts,2);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
 let previous=performance.now();let maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
 const beforeReject=commandPosts;rejectAt=beforeReject+2;await assert.rejects(invoke(),/before commit/);assert.equal(commandPosts,beforeReject+2);const retained=identity();assert.equal(typeof retained,'string');assert.equal(ghCalls(),0);assert.equal(count(),0);assert(!existsSync(join(run,'data/artifacts/blobs')));await new Promise(done=>setTimeout(done,60));assert.equal(commandPosts,beforeReject+2);evidence.GitAdmissionFailureNeverLooksUpCapturesOrFallsBack=true;
 const beforeLoss=commandPosts;loseAt=beforeLoss+2;await assert.rejects(invoke(),/outcome unknown/);assert.equal(identity(),retained);assert.equal(ghCalls(),0);assert.equal(count(),0);await new Promise(done=>setTimeout(done,100));assert.equal(commandPosts,beforeLoss+2);evidence.GitUnknownOutcomeNeverAutomaticallyReplayed=true;
 main.exec('CREATE TABLE synthetic_git_lock(value INTEGER);INSERT INTO synthetic_git_lock VALUES(0)');const beforeHeld=commandPosts;beforeIdentityPost=(index)=>{if(index===beforeHeld+2){beforeIdentityPost=undefined;lock=new SQLite(app!.db.getDbPath());lock.exec('BEGIN IMMEDIATE');lock.prepare('UPDATE synthetic_git_lock SET value=1').run();}};beforeIdentityReceipt=(index)=>{if(index===beforeHeld+2){beforeIdentityReceipt=undefined;setSource('Source removed after Git identity commit.');}};
 let settled=false;const at=performance.now();const pending=invoke().then(value=>({value}),error=>({error})).finally(()=>{settled=true;});await wait(()=>commandPosts>=beforeHeld+2||settled);assert.equal(commandPosts,beforeHeld+2);assert(lock);assert.equal(settled,false);assert.equal(ghCalls(),0);assert.equal(count(),0);const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileGitIdentityWriterHeldMs=performance.now()-healthAt;await new Promise(done=>setTimeout(done,1200));assert.equal(settled,false);lock.exec('COMMIT');lock.close();lock=undefined;
 const waited=await pending;assert(!('error' in waited),'Held Git RPC failed: '+String('error' in waited?waited.error:undefined));assert.deepEqual(waited.value,{accepted:false,reason:'unavailable'});evidence.deliberatelyHeldGitInitializationMs=performance.now()-at;assert.equal(ghCalls(),0);assert.equal(count(),0);evidence.sourceRecheckedAfterGitIdentityReceiptBeforeLookup=true;
 setSource(reference);const captureAt=performance.now();const [firstResult,concurrentResult]=await Promise.allSettled([invoke(),invoke()]);evidence.uncontendedConcurrentGitResolutionMs=performance.now()-captureAt;const deno=!!Reflect.get(globalThis,'Deno');
 if(deno){assert.equal(firstResult.status,'fulfilled');if(firstResult.status!=='fulfilled')throw firstResult.reason;assert.deepEqual(firstResult.value,{accepted:false,reason:'safe_open_unavailable'});assert.equal(concurrentResult.status,'rejected');if(concurrentResult.status==='rejected')assert.match(String(concurrentResult.reason),/artifact_blob_conflict/);evidence.existingDenoDuplicateBlobFailsClosed=true;assert.equal(count(),0);assert.equal(identity(),retained);evidence.existingDenoCaptureFailsClosed=true;evidence.successfulCaptureAndSnapshotReadVerified=false;}
 else{assert.equal(firstResult.status,'fulfilled');assert.equal(concurrentResult.status,'fulfilled');if(firstResult.status!=='fulfilled')throw firstResult.reason;if(concurrentResult.status!=='fulfilled')throw concurrentResult.reason;const first=firstResult.value;assert.deepEqual(concurrentResult.value,first);assert.equal(first.accepted,true,JSON.stringify(first));assert.equal(first.artifact.daemonId,retained);assert.equal(first.artifact.byteLength,bytes.length);assert.equal(count(),1);assert.equal(ghCalls(),3);evidence.concurrentGitCaptureRetainsOneReceipt=true;
  const priorCalls=ghCalls();writeFileSync(join(run,'git-fixtures.json'),'{}');assert.deepEqual(await invoke(),first);assert.equal(count(),1);assert.equal(ghCalls(),priorCalls);evidence.explicitOfflineRetryUsesCommittedGitReceiptWithoutLookup=true;
  readOnlyVerification=true;try{const metadata=await hub.request<{accepted:boolean;metadata:{sha256:string;revision:{kind:string;repository:string;commitSha:string;blobSha:string}}}>('operation.invoke',{name:'artifact.file.get',input:{artifactId:first.artifact.artifactId}});assert.equal(metadata.accepted,true);assert.equal(metadata.metadata.sha256,expectedHash);assert.deepEqual(metadata.metadata.revision,{kind:'commit',repository:'github.com/synthetic/fixture',commitSha:sha,blobSha});let offset=0;const chunks:Buffer[]=[];for(;;){const read=await hub.request<{accepted:boolean;data:string;sha256:string;nextOffset:number;complete:boolean}>('operation.invoke',{name:'artifact.file.read',input:{artifactId:first.artifact.artifactId,offset}});assert.equal(read.accepted,true);assert.equal(read.sha256,expectedHash);const chunk=Buffer.from(read.data,'base64');assert(chunk.length<=256*1024);chunks.push(chunk);offset=read.nextOffset;if(read.complete)break;}assert(Buffer.concat(chunks).equals(bytes));evidence.completeBytes=offset;evidence.readChunks=chunks.length;evidence.sha256=expectedHash;}finally{readOnlyVerification=false;}evidence.commitProvenanceAndSnapshotBytesRetained=true;evidence.successfulCaptureAndSnapshotReadVerified=true;evidence.existingReadOnlyIdentitySelectsOutsideGitCapture=readOnlyIdentitySelects;
 }
 const beforeForeign=ghCalls();assert.deepEqual(await invoke({...input,reference:reference.replace('/fixture/','/foreign/')}),{accepted:false,reason:'unavailable'});assert.equal(ghCalls(),beforeForeign);evidence.foreignOrNonSourceReferenceRefusedBeforeLookup=true;
 assert.equal(mainSqlAttempts,0);assert.equal(mainRowSaves,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.mainRowSaves=mainRowSaves;evidence.commandPosts=commandPosts;evidence.fixtureGhCalls=ghCalls();evidence.fullTransitiveGitCaptureGraphMeasured=false;evidence.pass=true;
}finally{
 measuring=false;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}
 try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}
 finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.Worker=NativeWorker;globalThis.fetch=nativeFetch;evidence.diagnosticSteps=diagnosticSteps;evidence.GitMainIdentitySqlAttempts=mainSqlAttempts;evidence.workerMetrics=metrics;writeFileSync(join(run,'evidence/artifact-git-identity.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok real Git reference RPC preserves queue, committed identity, no-replay/source fence and Bun provenance/full bytes; Deno keeps existing safe-open refusal');
