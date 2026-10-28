import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const {WorkspaceHistoryRepository}=await import('../../../packages/daemon/src/storage/repositories/workspace-history-repository.ts');
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const NativeWorker=globalThis.Worker;const nativeFetch=globalThis.fetch;const prepare=SQLite.prototype.prepare;const start=JobQueueProcessor.prototype.start;
const processors=new Set<InstanceType<typeof JobQueueProcessor>>();
let main:InstanceType<typeof SQLite>|undefined;let measuring=false;let mainSqlAttempts=0;let commandPosts=0;let rejectNext=false;let loseNext=false;
const metrics:{roundTripMs:number;requestBytes:number;replyBytes:number;encodeMs:number}[]=[];
SQLite.prototype.prepare=function(...args){
 const connection=this;const statement=Reflect.apply(prepare,this,args);
 if(!/DELETE\s+FROM\s+workspace_(history|projects)\b/i.test(args[0]))return statement;
 return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...values:unknown[])=>{
  if(measuring&&connection===main&&['run','get','all','iterate','values'].includes(String(key))){mainSqlAttempts++;throw new Error('workspace-removal SQL reached main');}
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
   if(lost.delete(event.data.id)&&!event.data.error){worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic committed workspace-removal reply lost; outcome unknown',cancelable:true}));return;}
   receive?.call(worker,event);
  });
  worker.postMessage=((message:{id:number;op?:string;lane?:string;args?:unknown})=>{
   if(message.op==='workspace.history.remove.write'){
    commandPosts++;assert.equal(message.lane,'write');assert.deepEqual(message.args&&Object.keys(message.args).sort(),['args','method']);const args=message.args as {method:string;args:[string]};assert.equal(args.method,'remove');assert.equal(args.args.length,1);assert.equal(typeof args.args[0],'string');
    if(rejectNext){rejectNext=false;queueMicrotask(()=>worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic workspace removal rejected before commit',cancelable:true})));return;}
    sent.set(message.id,{at:performance.now(),bytes:Buffer.byteLength(JSON.stringify(message.args))});if(loseNext){loseNext=false;lost.add(message.id);}
   }
   post(message);
  }) as typeof worker.postMessage;
 }
 return worker;
} as unknown as typeof Worker;
globalThis.fetch=(()=>{throw new Error('External HTTP refused by workspace-removal fixture');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;let transport:InstanceType<typeof WebSocketClientTransport>|undefined;let lock:InstanceType<typeof SQLite>|undefined;let timer:ReturnType<typeof setInterval>|undefined;
const evidence:Record<string,unknown>={};
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return start.call(this);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=start;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);
 const repo=new WorkspaceHistoryRepository(main);const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 type Entry={path:string;project?:{id:string;folders:string[]}};
 const history=()=>hub.request<{entries:Entry[]}>('workspace.history',{});
 const remove=(path:string)=>hub.request<{success:boolean}>('workspace.remove',{path});
 const has=async(path:string)=>(await history()).entries.some(e=>e.path===path);
 const seed=(name:string,shared=false)=>{const path=join(run,'workspace',name);mkdirSync(path,{recursive:true});writeFileSync(join(path,'retained.txt'),'synthetic retained workspace bytes');const second=shared?join(run,'workspace',name+'-second'):path;if(shared)mkdirSync(second,{recursive:true});assert(repo.addProjectFolder(path,second,'Synthetic project'));const project=repo.projects().find(p=>p.folders.includes(path))!;return{path,second,projectId:project.id};};
 const projectExists=(id:string)=>!!main!.prepare('SELECT 1 FROM workspace_projects WHERE id=?').get(id);
 const wait=async(predicate:()=>boolean)=>{const deadline=performance.now()+4000;while(!predicate()){assert(performance.now()<deadline,'workspace removal observation deadline exceeded');await new Promise(done=>setTimeout(done,5));}};
 const first=seed('first');const cached=main.prepare('DELETE FROM workspace_history WHERE path=?');measuring=true;
 assert.throws(()=>cached.run('/synthetic-absent'),/workspace-removal SQL reached main/);assert.throws(()=>main!.prepare('DELETE FROM workspace_projects WHERE 1=0').run(),/workspace-removal SQL reached main/);assert.equal(mainSqlAttempts,2);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
 let previous=performance.now();let maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
 const at=performance.now();let reply:{success:boolean};try{reply=await remove(first.path);}catch(error){evidence.removalFailure=String(error);throw error;}
 assert.deepEqual(reply,{success:true});assert.equal(commandPosts,1);assert.equal(await has(first.path),false);assert.equal(projectExists(first.projectId),false);assert.equal(readFileSync(join(first.path,'retained.txt'),'utf8'),'synthetic retained workspace bytes');evidence.firstRpcMs=performance.now()-at;evidence.publicHistoryAndProjectCleanupCommitted=true;evidence.workspaceFilesRetained=true;
 const shared=seed('shared',true);assert.deepEqual(await remove(shared.path),{success:true});assert.equal(await has(shared.path),false);const remaining=(await history()).entries.find(e=>e.path===shared.second);assert(remaining);assert.deepEqual(remaining.project?.folders,[shared.second]);assert.equal(projectExists(shared.projectId),true);assert.deepEqual(await remove(shared.second),{success:true});assert.equal(projectExists(shared.projectId),false);evidence.sharedProjectRetainedUntilLastFolder=true;
 const orphan=randomUUID();main.prepare('INSERT INTO workspace_projects(id,name)VALUES(?,?)').run(orphan,'Synthetic orphan');assert.deepEqual(await remove(join(run,'workspace','absent')),{success:false});assert.equal(projectExists(orphan),false);evidence.missingPathFalseAndLegacyCleanupPreserved=true;
 const rollback=seed('rollback');main.exec("CREATE TRIGGER reject_workspace_cleanup BEFORE DELETE ON workspace_projects BEGIN SELECT RAISE(ABORT,'synthetic workspace cleanup failure');END");await assert.rejects(remove(rollback.path),/synthetic workspace cleanup failure/);assert.equal(await has(rollback.path),true);assert.equal(projectExists(rollback.projectId),true);assert((await history()).entries.find(e=>e.path===rollback.path)?.project?.folders.includes(rollback.path));main.exec('DROP TRIGGER reject_workspace_cleanup');evidence.cleanupFailureRollsBackHistoryAndMembership=true;
 const concurrent=seed('concurrent');const beforeConcurrent=commandPosts;const results=await Promise.all([remove(concurrent.path),remove(concurrent.path)]);assert.deepEqual(results.map(r=>r.success).sort(),[false,true]);assert.equal(commandPosts,beforeConcurrent+2);assert.equal(await has(concurrent.path),false);evidence.concurrentRemovalHasOneWinner=true;
 const held=seed('held');main.exec('CREATE TABLE synthetic_workspace_lock(value INTEGER);INSERT INTO synthetic_workspace_lock VALUES(0)');lock=new SQLite(app.db.getDbPath());lock.exec('BEGIN IMMEDIATE');lock.prepare('UPDATE synthetic_workspace_lock SET value=1').run();const beforeHeld=commandPosts;let settled=false;const heldAt=performance.now();const pending=remove(held.path).finally(()=>{settled=true;});await wait(()=>commandPosts>beforeHeld);assert.equal(settled,false);assert.equal(await has(held.path),true);const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileWriterHeldMs=performance.now()-healthAt;await new Promise(done=>setTimeout(done,1200));assert.equal(settled,false);lock.exec('COMMIT');lock.close();lock=undefined;assert.deepEqual(await pending,{success:true});assert.equal(await has(held.path),false);evidence.deliberatelyHeldWriterMs=performance.now()-heldAt;evidence.publicReplyWaitsForCommit=true;
 const refused=seed('refused');const beforeRefusal=commandPosts;rejectNext=true;await assert.rejects(remove(refused.path),/before commit/);assert.equal(await has(refused.path),true);assert.equal(projectExists(refused.projectId),true);assert.equal(commandPosts,beforeRefusal+1);evidence.preCommitFailureLeavesMetadata=true;
 const unknown=seed('unknown');const beforeLoss=commandPosts;loseNext=true;await assert.rejects(remove(unknown.path),/outcome unknown/);assert.equal(await has(unknown.path),false);assert.equal(projectExists(unknown.projectId),false);await new Promise(done=>setTimeout(done,100));assert.equal(commandPosts,beforeLoss+1);assert.deepEqual(await remove(unknown.path),{success:false});assert.equal(commandPosts,beforeLoss+2);evidence.unknownOutcomeNotAutomaticallyReplayed=true;
 assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.commandPosts=commandPosts;evidence.publicHistoryReadRemainsSeparate=true;
}finally{
 measuring=false;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}
 try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}
 finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.Worker=NativeWorker;globalThis.fetch=nativeFetch;evidence.mainSqlAttempts=mainSqlAttempts;evidence.workerMetrics=metrics;writeFileSync(join(run,'evidence/workspace-remove.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok public workspace.remove commits metadata cleanup on the DB writer, retains files and never replays uncertain writes; history reads and other mutation callers are separate');
