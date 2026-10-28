import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const {ArtifactFileRepository}=await import('../../../packages/daemon/src/storage/repositories/artifact-file-repository.ts');
const {runMigration432}=await import('../../../packages/daemon/src/storage/schema/m432-artifact-files.ts');
const {NeoAskTodoRepository}=await import('../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts');
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const nativeFetch=globalThis.fetch,prepare=SQLite.prototype.prepare,start=JobQueueProcessor.prototype.start;
const processors=new Set<InstanceType<typeof JobQueueProcessor>>();let main:InstanceType<typeof SQLite>|undefined;let measuring=false;let mainInsertRuns=0;const bindCounts:number[]=[];
SQLite.prototype.prepare=function(sql,...rest){const connection=this,statement=Reflect.apply(prepare,this,[sql,...rest]);if(!/INSERT INTO artifact_files/i.test(sql))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(measuring&&connection===main&&key==='run'){mainInsertRuns++;bindCounts.push(args.length);}return Reflect.apply(value,target,args);};}});};
globalThis.fetch=(()=>{throw new Error('External HTTP refused by artifact receipt extraction fixture');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,transport:InstanceType<typeof WebSocketClientTransport>|undefined;const scratch:InstanceType<typeof SQLite>[]=[];
const evidence:Record<string,unknown>={mainThreadMovementClaim:false,phase:'pure receipt serialization extraction; legacy row publication remains on its supplied connection'};
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return start.call(this);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=start;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);
 main.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Synthetic',?,'now','now','active','{}','{}')").run('synthetic-neo',join(run,'workspace'));
 new NeoAskTodoRepository(main).openAsk({id:'synthetic-artifact-ask',sessionId:'synthetic-neo',projectId:null,originMessageId:null,title:'Synthetic receipt',request:'Synthetic proof only',createdAt:Date.now()});
 const text='# Synthetic immutable receipt 🦊\n';writeFileSync(join(run,'workspace/report.md'),text);
 const input={requestId:'synthetic-receipt-request',context:{kind:'ask' as const,id:'synthetic-artifact-ask'},path:join(run,'workspace/report.md'),title:'Synthetic report 🦊'};
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 type Ref={daemonId:string;artifactId:string;title:string;kind:'markdown';byteLength:number};type Reply={accepted:true;artifact:Ref};
 const invoke=()=>hub.request<Reply>('operation.invoke',{name:'artifact.file.register',input});
 measuring=true;const at=performance.now();const first=await invoke();evidence.firstRpcMs=performance.now()-at;assert.deepEqual(await invoke(),first);const deno=!!Reflect.get(globalThis,'Deno');
 const daemonId=main.prepare('SELECT daemon_id AS retained FROM artifact_file_identity').get()!.retained as string;let publicReceipt:string|undefined;
 if(deno){assert.deepEqual(first,{accepted:false,reason:'safe_open_unavailable'});assert.equal(mainInsertRuns,0);assert.equal(main.prepare('SELECT COUNT(*) AS n FROM artifact_files').get()!.n,0);evidence.existingDenoCaptureFailsClosed=true;evidence.successfulDenoCaptureAndReadVerified=false;}
 else{assert.equal(first.accepted,true,JSON.stringify(first));assert.equal(first.artifact.daemonId,daemonId);assert.equal(mainInsertRuns,1);assert.deepEqual(bindCounts,[11]);publicReceipt=main.prepare('SELECT receipt FROM artifact_files WHERE artifact_id=?').get(first.artifact.artifactId)!.receipt as string;assert.equal(publicReceipt,JSON.stringify({accepted:true,requestId:input.requestId,artifact:first.artifact,revision:{kind:'worktree'}}));const read=await hub.request<{accepted:boolean;data:string}>('operation.invoke',{name:'artifact.file.read',input:{artifactId:first.artifact.artifactId}});assert.equal(read.accepted,true);assert.equal(Buffer.from(read.data,'base64').toString(),text);evidence.publicRegistrationReceiptAndBytesPreserved=true;evidence.publicReceiptBytes=Buffer.byteLength(publicReceipt);evidence.publicReceiptSha256=createHash('sha256').update(publicReceipt).digest('hex');}
 const helperFile=new URL('../../../packages/daemon/src/storage/repositories/artifact-file-receipt.ts',import.meta.url);assert(existsSync(helperFile),'Canonical artifact receipt serializer is unavailable');const {serializeArtifactReceipt}=await import(helperFile.href);assert.equal(typeof serializeArtifactReceipt,'function');
 if(publicReceipt)assert.equal(serializeArtifactReceipt(first.artifact,{kind:'worktree'},undefined,input.requestId),publicReceipt);
 const db=new SQLite(':memory:');scratch.push(db);runMigration432(db);const repo=new ArtifactFileRepository(db,daemonId);const cases=[{}, {logical:''}, {logical:'logical-request'}, {revision:{kind:'worktree'}}, {bundle:[]}, {logical:'logical-request',revision:{kind:'commit',repository:'github.com/synthetic/fixture',commitSha:'a'.repeat(40),blobSha:'b'.repeat(40)},bundle:[{path:'style.css',artifactId:'SyntheticCss'}]}];
 for(const [i,value] of cases.entries()){const options=value as {logical?:string;revision?:Parameters<typeof repo.save>[7];bundle?:Parameters<typeof repo.save>[8]},ref={daemonId,artifactId:'Synthetic'+i,title:'Synthetic 🦊',kind:'markdown' as const,byteLength:3};const result=repo.save(input.context,'case'+i,'fingerprint','sha',ref,'{"adapter":"hyperneo","id":"synthetic"}','report.md',options.revision,options.bundle,options.logical);assert.equal(result.artifact,ref);const row=db.prepare('SELECT receipt,created_at FROM artifact_files WHERE artifact_id=?').get(ref.artifactId)!;assert.equal(row.receipt,serializeArtifactReceipt(ref,options.revision,options.bundle,options.logical));assert.equal(typeof row.created_at,'number');}
 evidence.optionalFieldMatrixPreserved=true;evidence.matrixCases=cases.length;
 assert.throws(()=>db.transaction(()=>{repo.save(input.context,'rollback','fingerprint','sha',{daemonId,artifactId:'RollbackArtifact',title:'Rollback',kind:'markdown',byteLength:3},'{"adapter":"hyperneo"}','report.md');throw new Error('synthetic outer rollback');})(),/synthetic outer rollback/);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM artifact_files WHERE artifact_id='RollbackArtifact'").get()!.n,0);evidence.callerOwnedRollbackPreserved=true;
 const bad={daemonId,artifactId:'BadArtifact',title:'Bad',kind:'markdown' as const,byteLength:3,toJSON(){throw new Error('synthetic serialization failure');}};assert.throws(()=>serializeArtifactReceipt(bad),/synthetic serialization failure/);assert.throws(()=>repo.save(input.context,'bad','fingerprint','sha',bad,'{"adapter":"hyperneo"}','report.md'),/synthetic serialization failure/);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM artifact_files WHERE artifact_id='BadArtifact'").get()!.n,0);evidence.serializationErrorsBeforeWritePreserved=true;
 const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthMs=performance.now()-healthAt;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.pass=true;
}finally{
 measuring=false;for(const db of scratch)db.close();try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.fetch=nativeFetch;evidence.mainInsertRuns=mainInsertRuns;evidence.publicMainInsertBindCounts=bindCounts;writeFileSync(join(run,'evidence/artifact-receipt-extract.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok canonical receipt extraction keeps legacy bytes/SQL/returns/rollback and native registration behavior; no SQL movement claimed');
