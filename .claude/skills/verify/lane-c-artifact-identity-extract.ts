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
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const insert='INSERT OR IGNORE INTO artifact_file_identity VALUES (1, ?)';const select='SELECT daemon_id FROM artifact_file_identity';
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const nativeFetch=globalThis.fetch;const prepare=SQLite.prototype.prepare;const start=JobQueueProcessor.prototype.start;
const processors=new Set<InstanceType<typeof JobQueueProcessor>>();let main:InstanceType<typeof SQLite>|undefined;let measuring=false;const mainStatements:{kind:string;bindCount:number}[]=[];
SQLite.prototype.prepare=function(sql,...rest){const connection=this;const stmt=Reflect.apply(prepare,this,[sql,...rest]);if(sql!==insert&&sql!==select)return stmt;return new Proxy(stmt,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(measuring&&connection===main&&(key==='run'||key==='get')){if(key==='run')assert(uuid(args[0]));mainStatements.push({kind:sql===insert?'insert':'select',bindCount:args.length});}return Reflect.apply(value,target,args);};}});};
globalThis.fetch=(()=>{throw new Error('External HTTP refused by artifact identity extraction fixture');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;let transport:InstanceType<typeof WebSocketClientTransport>|undefined;
const scratch:InstanceType<typeof SQLite>[]=[];const evidence:Record<string,unknown>={fullSubsystemOffMainClaim:false,phase:'historical helper extraction contracts; current resolver identity is worker-backed, direct legacy helper remains on its supplied connection'};
function database(existing?:string){const db=new SQLite(':memory:');scratch.push(db);db.exec('CREATE TABLE artifact_file_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), daemon_id TEXT NOT NULL)');if(existing)db.prepare(insert).run(existing);return db;}
function trace(db:InstanceType<typeof SQLite>,action:()=>string){const saved=db.prepare;const calls:{sql:string;method:string;argc:number;uuidArgument?:boolean}[]=[];db.prepare=((sql:string)=>{const stmt=saved.call(db,sql);return new Proxy(stmt,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(key==='run'||key==='get')calls.push({sql,method:String(key),argc:args.length,...(key==='run'?{uuidArgument:uuid(args[0])}:{})});return Reflect.apply(value,target,args);};}});}) as typeof db.prepare;try{return{id:action(),calls};}finally{db.prepare=saved;}}
function receiptFault(db:InstanceType<typeof SQLite>,action:()=>string){const saved=db.prepare;db.prepare=((sql:string)=>{const stmt=saved.call(db,sql);return sql===select?new Proxy(stmt,{get(target,key){if(key==='get')return()=>{throw new Error('synthetic identity receipt failure');};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}):stmt;}) as typeof db.prepare;try{return action();}finally{db.prepare=saved;}}
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return start.call(this);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=start;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 const input={sourceMessageOrCard:{kind:'todo',id:'synthetic-missing-artifact-source'},reference:'synthetic-report.md',requestId:crypto.randomUUID()};
 const invoke=()=>hub.request('operation.invoke',{name:'artifact.reference.resolve',input});
 measuring=true;const at=performance.now();assert.deepEqual(await invoke(),{accepted:false,reason:'unavailable'});evidence.firstRpcMs=performance.now()-at;const retained=main.prepare('SELECT * FROM artifact_file_identity').all() as {singleton:number;daemon_id:string}[];assert.equal(retained.length,1);assert.equal(retained[0].singleton,1);assert(uuid(retained[0].daemon_id));assert.deepEqual(await invoke(),{accepted:false,reason:'unavailable'});assert.deepEqual(main.prepare('SELECT * FROM artifact_file_identity').all(),retained);assert.equal(main.prepare('SELECT COUNT(*) AS n FROM artifact_files').get()!.n,0);assert.deepEqual(mainStatements,[]);evidence.realRpcRefusalAndRetainedIdentity=true;evidence.referenceRpcIdentityNowWorkerBacked=true;
 const helperFile=new URL('../../../packages/daemon/src/storage/repositories/artifact-file-identity.ts',import.meta.url);let ensure:((db:InstanceType<typeof SQLite>)=>string)|undefined;if(existsSync(helperFile))ensure=(await import(helperFile.href)).ensureArtifactFileIdentity;assert.equal(typeof ensure,'function','extracted artifact identity helper is unavailable');
 assert.equal(ensure!(main),retained[0].daemon_id);evidence.extractedHelperRetainsRpcIdentity=true;assert.deepEqual(mainStatements,[{kind:'insert',bindCount:1},{kind:'select',bindCount:0}]);evidence.directLegacyHelperStillMainSide=true;
 const stable='33333333-3333-4333-8333-333333333333';
 for(const existing of [undefined,stable]){const legacyDb=database(existing),helperDb=database(existing);const old=trace(legacyDb,()=>new ArtifactFileRepository(legacyDb).daemonId),next=trace(helperDb,()=>ensure!(helperDb));assert.deepEqual(next.calls,old.calls);assert.deepEqual(old.calls,[{sql:insert,method:'run',argc:1,uuidArgument:true},{sql:select,method:'get',argc:0}]);assert(uuid(old.id));assert(uuid(next.id));if(existing){assert.equal(old.id,existing);assert.equal(next.id,existing);}assert.equal(new ArtifactFileRepository(legacyDb).daemonId,old.id);assert.equal(ensure!(helperDb),next.id);}
 evidence.sqlAndBoundUuidShapeIdentical=true;evidence.retainedSingletonStable=true;
 for(const initialize of [(db:InstanceType<typeof SQLite>)=>new ArtifactFileRepository(db).daemonId,ensure!]){
  for(const existing of [undefined,stable]){const db=database(existing);const before=db.prepare('SELECT * FROM artifact_file_identity').all();assert.throws(()=>db.transaction(()=>{initialize(db);throw new Error('synthetic outer rollback');})(),/synthetic outer rollback/);assert.deepEqual(db.prepare('SELECT * FROM artifact_file_identity').all(),before);}
  const plain=database();assert.throws(()=>receiptFault(plain,()=>initialize(plain)),/synthetic identity receipt failure/);assert.equal(plain.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()!.n,1);
  const atomic=database();assert.throws(()=>atomic.transaction(()=>receiptFault(atomic,()=>initialize(atomic)))(),/synthetic identity receipt failure/);assert.equal(atomic.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()!.n,0);
  const rejected=database();rejected.exec("CREATE TRIGGER reject_identity BEFORE INSERT ON artifact_file_identity BEGIN SELECT RAISE(ABORT,'synthetic identity insert failure');END");assert.throws(()=>initialize(rejected),/synthetic identity insert failure/);assert.equal(rejected.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()!.n,0);
 }
 evidence.callerOwnedRollbackPreserved=true;evidence.outsideTransactionPartialInsertPreserved=true;evidence.insertAndReceiptErrorsPreserved=true;
 assert.deepEqual(await invoke(),{accepted:false,reason:'unavailable'});assert.deepEqual(main.prepare('SELECT * FROM artifact_file_identity').all(),retained);evidence.publicRpcAfterHelperStillUnchanged=true;
 const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthMs=performance.now()-healthAt;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.pass=true;
}finally{
 measuring=false;for(const db of scratch)db.close();try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.fetch=nativeFetch;evidence.mainStatementTrace=mainStatements;evidence.sql=[insert,select].map(sql=>({bytes:Buffer.byteLength(sql),sha256:createHash('sha256').update(sql).digest('hex')}));writeFileSync(join(run,'evidence/artifact-identity-extract.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok artifact identity extraction preserves native SQL/UUID/retained row/rollback and real artifact RPC; current resolver identity is worker-backed while direct helper stays legacy');
