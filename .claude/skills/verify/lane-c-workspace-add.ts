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
const {McpImportService}=await import('../../../packages/daemon/src/lib/mcp/mcp-import-service.ts');
const refresh=McpImportService.prototype.refreshAllForPath;
let scans=0;let failScan=false;let capturedTime=0;
McpImportService.prototype.refreshAllForPath=async function(path){scans++;assert(app?.db.workspaceHistory.listAll().some(row=>row.path===path),'history must commit before MCP scan');if(failScan){failScan=false;throw new Error('synthetic scan failure');}return refresh.call(this,path);};
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
    commandPosts++;assert.equal(message.lane,'write');assert.deepEqual(message.args&&Object.keys(message.args).sort(),['args','method']);const args=message.args as {method:string;args:[string,number]};assert.equal(args.method,'upsert');assert.equal(args.args.length,2);assert.equal(typeof args.args[0],'string');assert.equal(typeof args.args[1],'number');capturedTime=args.args[1];
    if(rejectNext){rejectNext=false;queueMicrotask(()=>worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic workspace upsert rejected before commit',cancelable:true})));return;}
    sent.set(message.id,{at:performance.now(),bytes:Buffer.byteLength(JSON.stringify(message.args))});if(loseNext){loseNext=false;lost.add(message.id);}
   }
   post(message);
  }) as typeof worker.postMessage;
 }
 return worker;
} as unknown as typeof Worker;
globalThis.fetch=(()=>{throw new Error('External HTTP refused by workspace-upsert fixture');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;let transport:InstanceType<typeof WebSocketClientTransport>|undefined;let lock:InstanceType<typeof SQLite>|undefined;let timer:ReturnType<typeof setInterval>|undefined;let stopEvents=()=>{};
const evidence:Record<string,unknown>={};
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return start.call(this);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=start;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 type Entry={path:string;lastUsedAt:number;useCount:number};
 const add=(path:string)=>hub.request<{entry:Entry}>('workspace.add',{path});
 const history=()=>hub.request<{entries:Entry[]}>('workspace.history',{});
 const entry=async(path:string)=>(await history()).entries.find(e=>e.path===path);
 const workspace=(name:string)=>{const path=join(run,'workspace',name);mkdirSync(path);return path;};
 const catalog=()=>hub.request<{servers:{id:string;name:string;enabled:boolean;sourcePath?:string}[]}>('mcp.registry.list',{});
 let notices=0;stopEvents=app.internalEventBus.subscribe('mcp.registry.changed',()=>{notices++;},{subscriberName:'workspace-add-proof'});
 const wait=async(predicate:()=>boolean)=>{const deadline=performance.now()+4000;while(!predicate()){assert(performance.now()<deadline);await new Promise(done=>setTimeout(done,5));}};
 const first=workspace("first-'工作区");writeFileSync(join(first,'.mcp.json'),JSON.stringify({mcpServers:{probe:{command:'synthetic-never-executed'}}}));
 const cached=main.prepare('INSERT INTO workspace_history(path,last_used_at,use_count)VALUES(?,?,1)');measuring=true;
 assert.throws(()=>cached.run(first,Date.now()),/workspace-upsert SQL reached main/);assert.throws(()=>main!.prepare('SELECT path, last_used_at, use_count FROM workspace_history WHERE path=?').get(first),/workspace-upsert SQL reached main/);assert.equal(mainSqlAttempts,2);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
 let previous=performance.now();let maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
 const cold=performance.now();const reply=await add('  '+first+'  ');evidence.firstRpcMs=performance.now()-cold;
 assert.deepEqual(reply.entry,{path:first,lastUsedAt:capturedTime,useCount:1});assert.deepEqual(await entry(first),reply.entry);assert.equal(commandPosts,1);assert.equal(scans,1);
 const imported=(await catalog()).servers.find(s=>s.sourcePath===join(first,'.mcp.json'));assert(imported);assert.equal(imported.enabled,false);
 const defaults=JSON.parse(String(main.prepare('SELECT settings FROM global_settings WHERE id=1').get()!.settings)).toolSelectionDefaults;assert.equal(defaults.choices[`mcp:${imported.id}`].selected,false);await wait(()=>notices>0);evidence.committedHistoryBeforeRealMcpImport=true;evidence.disabledImportedCanonicalDefault=true;evidence.changeEventAfterImportCommit=true;evidence.normalizedLiteralPath=true;
 assert.equal((await add(first)).entry.useCount,2);const concurrent=workspace('concurrent');await Promise.all([1,2,3,4].map(()=>add(concurrent)));assert.equal((await entry(concurrent))?.useCount,4);evidence.repeatedAndConcurrentCounters=true;
 const beforeMalformed=notices;writeFileSync(join(first,'.mcp.json'),'{malformed');assert.equal((await add(first)).entry.useCount,3);assert((await catalog()).servers.some(s=>s.id===imported.id));assert.equal(notices,beforeMalformed);evidence.malformedImportRetainsHistoryAndCatalog=true;
 const scanFailure=workspace('scan-failure');failScan=true;const beforeScanError=notices;assert.equal((await add(scanFailure)).entry.useCount,1);assert.equal(notices,beforeScanError);evidence.scanExceptionDoesNotUndoHistory=true;
 const failed=workspace('write-failure');main.exec("CREATE TRIGGER reject_add BEFORE INSERT ON workspace_history WHEN NEW.path LIKE '%/write-failure' BEGIN SELECT RAISE(ABORT,'synthetic add write failure');END");const beforeWriteFailure=scans;await assert.rejects(add(failed),/synthetic add write failure/);assert.equal(await entry(failed),undefined);assert.equal(scans,beforeWriteFailure);main.exec('DROP TRIGGER reject_add');evidence.failedWritePreventsScan=true;
 const held=workspace('held');main.exec('CREATE TABLE synthetic_workspace_add_lock(value INTEGER);INSERT INTO synthetic_workspace_add_lock VALUES(0)');lock=new SQLite(app.db.getDbPath());lock.exec('BEGIN IMMEDIATE');lock.prepare('UPDATE synthetic_workspace_add_lock SET value=1').run();const beforeHeld=commandPosts;const scansBeforeHeld=scans;let settled=false;const heldStart=performance.now();const pending=add(held).finally(()=>{settled=true;});await wait(()=>commandPosts>beforeHeld);const heldTime=capturedTime;assert.equal(settled,false);assert.equal(await entry(held),undefined);assert.equal(scans,scansBeforeHeld);const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileWriterHeldMs=performance.now()-healthAt;await new Promise(done=>setTimeout(done,1200));assert.equal(settled,false);assert.equal(scans,scansBeforeHeld);lock.exec('COMMIT');lock.close();lock=undefined;assert.deepEqual((await pending).entry,{path:held,lastUsedAt:heldTime,useCount:1});evidence.deliberatelyHeldWriterMs=performance.now()-heldStart;evidence.admissionTimestampAndCommitOrdering=true;
 const refused=workspace('refused');const beforeRefusal=commandPosts;const scansBeforeRefusal=scans;rejectNext=true;await assert.rejects(add(refused),/before commit/);assert.equal(await entry(refused),undefined);assert.equal(commandPosts,beforeRefusal+1);assert.equal(scans,scansBeforeRefusal);evidence.preCommitFailurePreventsScan=true;
 const unknown=workspace('unknown');const beforeLoss=commandPosts;const scansBeforeLoss=scans;loseNext=true;await assert.rejects(add(unknown),/outcome unknown/);assert.equal((await entry(unknown))?.useCount,1);await new Promise(done=>setTimeout(done,100));assert.equal(commandPosts,beforeLoss+1);assert.equal(scans,scansBeforeLoss);assert.equal((await add(unknown)).entry.useCount,2);assert.equal(commandPosts,beforeLoss+2);evidence.unknownOutcomeNeverReplayedOrScanned=true;
 const beforeInvalid=commandPosts;await assert.rejects(add(join(run,'workspace','absent')),/does not exist/);assert.equal(commandPosts,beforeInvalid);evidence.invalidPathRejectedBeforeWriter=true;
 assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.commandPosts=commandPosts;evidence.publicWorkspaceAddExercised=true;evidence.historyAndMcpSourceReadsRemainMain=true;evidence.pass=true;
 }finally{
 measuring=false;stopEvents();McpImportService.prototype.refreshAllForPath=refresh;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}
 try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}
 finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.Worker=NativeWorker;globalThis.fetch=nativeFetch;evidence.mainSqlAttempts=mainSqlAttempts;evidence.workerMetrics=metrics;writeFileSync(join(run,'evidence/workspace-add.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok native public workspace.add awaits worker history commit before real MCP import, preserves readback and refuses replay after uncertain writes');
