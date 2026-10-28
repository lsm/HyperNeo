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
const {InboxItemRepository}=await import('../../../packages/daemon/src/storage/repositories/inbox-item-repository.ts');
const command=defineDbOp<{method:string;args:[unknown,string,number]},unknown>({name:'github.inbox.create.write',mode:'write',run:()=>{throw new Error('Inbox construction must execute in native worker');}});
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const NativeWorker=globalThis.Worker;const nativeFetch=globalThis.fetch;const prepare=SQLite.prototype.prepare;const start=JobQueueProcessor.prototype.start;
const processors=new Set<InstanceType<typeof JobQueueProcessor>>();
let main:InstanceType<typeof SQLite>|undefined;let measuring=false;let mainSqlAttempts=0;let commandPosts=0;let rejectNext=false;let loseNext=false;
const metrics:{roundTripMs:number;requestBytes:number;replyBytes:number;encodeMs:number}[]=[];
SQLite.prototype.prepare=function(...args){
 const connection=this;const statement=Reflect.apply(prepare,this,args);
 if(!/INSERT\s+INTO\s+inbox_items|SELECT\s+\*\s+FROM\s+inbox_items\s+WHERE\s+id\s*=/i.test(args[0]))return statement;
 return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...values:unknown[])=>{
  if(measuring&&connection===main&&['run','get','all','iterate','values'].includes(String(key))){mainSqlAttempts++;throw new Error('inbox-create SQL reached main');}
  return Reflect.apply(value,target,values);
 };}});
};
globalThis.Worker=function(url:string|URL,options?:WorkerOptions){
 const worker=new NativeWorker(url,options);
 if(String(url).endsWith('/db-gateway-worker.ts')){
  const post=worker.postMessage.bind(worker);const sent=new Map<number,{at:number;bytes:number}>();const lost=new Set<number>();let receive:((event:MessageEvent)=>void)|null=null;
  Object.defineProperty(worker,'onmessage',{configurable:true,get:()=>receive,set:(handler:typeof receive)=>{receive=handler;}});
  worker.addEventListener('message',event=>{
   const request=sent.get(event.data.id);if(request){sent.delete(event.data.id);if(event.data.error)assert.equal(event.data.changes,undefined);else assert.deepEqual(event.data.changes,[{table:'inbox_items'}]);if(!event.data.error){const at=performance.now();const encoded=JSON.stringify(event.data.result);metrics.push({roundTripMs:at-request.at,requestBytes:request.bytes,replyBytes:Buffer.byteLength(encoded),encodeMs:performance.now()-at});}}
   if(lost.delete(event.data.id)&&!event.data.error){worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic committed inbox-create reply lost; outcome unknown',cancelable:true}));return;}
   receive?.call(worker,event);
  });
  worker.postMessage=((message:{id:number;op?:string;lane?:string;args?:unknown})=>{
   if(message.op==='github.inbox.create.write'){
    commandPosts++;assert.equal(message.lane,'write');assert.deepEqual(message.args&&Object.keys(message.args).sort(),['args','method']);const args=message.args as {method:string;args:[object,string,number]};assert.equal(args.method,'create');assert.equal(args.args.length,3);assert.equal(typeof args.args[0],'object');assert.equal(typeof args.args[1],'string');assert.equal(typeof args.args[2],'number');
    if(rejectNext){rejectNext=false;queueMicrotask(()=>worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic inbox creation rejected before commit',cancelable:true})));return;}
    sent.set(message.id,{at:performance.now(),bytes:Buffer.byteLength(JSON.stringify(message.args))});if(loseNext){loseNext=false;lost.add(message.id);}
   }
   post(message);
  }) as typeof worker.postMessage;
 }
 return worker;
} as unknown as typeof Worker;
globalThis.fetch=(()=>{throw new Error('External HTTP refused by inbox-create fixture');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;let transport:InstanceType<typeof WebSocketClientTransport>|undefined;let lock:InstanceType<typeof SQLite>|undefined;let timer:ReturnType<typeof setInterval>|undefined;
const evidence:Record<string,unknown>={};
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return start.call(this);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=start;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 type Params=import('../../../packages/daemon/src/storage/repositories/inbox-item-repository.ts').CreateInboxItemParams;
 type Item=import('../../../packages/shared/src/mod.ts').InboxItem;
 const repo=new InboxItemRepository(main);
 const params:Params={source:'github_issue',repository:'synthetic/inbox',issueNumber:42,title:"Synthetic ' 中文",body:'Synthetic body',author:'synthetic',labels:['test'],securityCheck:{passed:true,injectionRisk:'none'},rawEvent:{nested:{literal:'synthetic'}}};
 const id=()=>crypto.randomUUID();const now=Date.now()-1000;
 const create=(identity:string,at=now,input=params)=>app!.db.gateway.run(command,{method:'create',args:[input,identity,at]}) as Promise<Item>;
 const read=(identity:string)=>repo.listItems().find(item=>item.id===identity);
 const count=()=>repo.countByStatus('pending');
 const wait=async(predicate:()=>boolean)=>{const deadline=performance.now()+4000;while(!predicate()){assert(performance.now()<deadline);await new Promise(done=>setTimeout(done,5));}};
 const cached=main.prepare('INSERT INTO inbox_items(id)VALUES(?)');measuring=true;
 assert.throws(()=>cached.run(id()),/inbox-create SQL reached main/);assert.throws(()=>main!.prepare('SELECT * FROM inbox_items WHERE id=?').get(id()),/inbox-create SQL reached main/);assert.equal(mainSqlAttempts,2);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
 let previous=performance.now();let maxLoopLagMs=0;timer=setInterval(()=>{const current=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,current-previous-5);previous=current;},5);
 const first=id();const cold=performance.now();const receipt=await create(first);evidence.firstCommandMs=performance.now()-cold;
 assert.deepEqual(receipt,{...params,id:first,receivedAt:now,updatedAt:now,status:'pending',commentId:undefined,authorPermission:undefined,routedToRoomId:undefined,routedAt:undefined});assert.deepEqual(structuredClone(receipt),receipt);assert.deepEqual(read(first),receipt);assert.equal(count(),1);evidence.exactCommittedReceiptAndCount=true;evidence.callerIdentityTimeAndJsonPreserved=true;
 const metadata=id();const metadataParams:Params={...params,source:'github_comment',commentId:'synthetic-comment',authorPermission:'write',labels:["quoted-'中文"],rawEvent:{title:"'; DROP TABLE inbox_items; --",flags:[true,null]}};const metadataReceipt=await create(metadata,now+1,metadataParams);assert.deepEqual(read(metadata),metadataReceipt);assert.equal(metadataReceipt.commentId,metadataParams.commentId);assert.deepEqual(metadataReceipt.rawEvent,metadataParams.rawEvent);evidence.literalOptionalMetadataRoundTrip=true;
 const duplicate=id();const beforeDuplicate=count();const outcomes=await Promise.allSettled([create(duplicate,now),create(duplicate,now+10)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);assert.equal(count(),beforeDuplicate+1);assert.equal(read(duplicate)?.receivedAt,now);evidence.concurrentDuplicateOneWinner=true;
 const distinct=[id(),id(),id(),id()];const distinctReceipts=await Promise.all(distinct.map((identity,index)=>create(identity,now+index)));assert.deepEqual(distinctReceipts.map(item=>item.id),distinct);evidence.distinctConcurrentRequestsRetainIdentity=true;
 const corrupt=id();const beforeCorrupt=count();main.exec("CREATE TRIGGER corrupt_inbox_receipt AFTER INSERT ON inbox_items BEGIN UPDATE inbox_items SET security_check='{invalid' WHERE id=NEW.id; END");await assert.rejects(create(corrupt),/JSON|json|property|Unexpected|Expected|position/);assert.equal(read(corrupt),undefined);assert.equal(count(),beforeCorrupt);main.exec('DROP TRIGGER corrupt_inbox_receipt');evidence.receiptDecodeFailureRollsBackInsertAndTrigger=true;
 const held=id();main.exec('CREATE TABLE synthetic_inbox_lock(value INTEGER);INSERT INTO synthetic_inbox_lock VALUES(0)');lock=new SQLite(app.db.getDbPath());lock.exec('BEGIN IMMEDIATE');lock.prepare('UPDATE synthetic_inbox_lock SET value=1').run();const beforeHeld=commandPosts;let settled=false;const heldAt=performance.now();const pending=create(held,now+77).finally(()=>{settled=true;});await wait(()=>commandPosts>beforeHeld);assert.equal(settled,false);assert.equal(read(held),undefined);const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileWriterHeldMs=performance.now()-healthAt;await new Promise(done=>setTimeout(done,1200));assert.equal(settled,false);lock.exec('COMMIT');lock.close();lock=undefined;const heldReceipt=await pending;assert.equal(heldReceipt.id,held);assert.equal(heldReceipt.receivedAt,now+77);assert.equal(heldReceipt.updatedAt,now+77);evidence.deliberatelyHeldWriterMs=performance.now()-heldAt;evidence.admissionIdentityAndTimeRetainedAcrossWait=true;
 const refused=id();const beforeRefusal=commandPosts;const countBeforeRefusal=count();rejectNext=true;await assert.rejects(create(refused),/before commit/);assert.equal(read(refused),undefined);assert.equal(count(),countBeforeRefusal);assert.equal(commandPosts,beforeRefusal+1);evidence.preCommitFailureLeavesNoRow=true;
 const unknown=id();const beforeLoss=commandPosts;const countBeforeLoss=count();loseNext=true;await assert.rejects(create(unknown),/outcome unknown/);assert.equal(read(unknown)?.receivedAt,now);await new Promise(done=>setTimeout(done,100));assert.equal(commandPosts,beforeLoss+1);assert.equal(count(),countBeforeLoss+1);await assert.rejects(create(unknown,now+10));assert.equal(commandPosts,beforeLoss+2);assert.equal(read(unknown)?.receivedAt,now);evidence.unknownOutcomeNeverAutomaticallyReplayed=true;
 assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.commandPosts=commandPosts;evidence.publicGithubEventCallerWired=false;evidence.pendingReadsRemainMain=true;evidence.pass=true;
}finally{
 measuring=false;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}
 try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}
 finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.Worker=NativeWorker;globalThis.fetch=nativeFetch;evidence.mainSqlAttempts=mainSqlAttempts;evidence.workerMetrics=metrics;writeFileSync(join(run,'evidence/inbox-create.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok inbox construction command returns committed plain receipts/counts on the DB writer; public GitHub event wiring is separate');
