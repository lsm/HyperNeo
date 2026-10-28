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
const {InboxItemRepository}=await import('../../../packages/daemon/src/storage/repositories/inbox-item-repository.ts');
const {GitHubService}=await import('../../../packages/daemon/src/lib/github/github-service.ts');
const {GitHubPollingService}=await import('../../../packages/daemon/src/lib/github/polling-service.ts');
const {handleGitHubPoll}=await import('../../../packages/daemon/src/lib/job-handlers/github-poll.handler.ts');
const {githubPollRefreshWrites}=await import('../../../packages/daemon/src/storage/repositories/github-poll-refresh-write.ts');
let poller:InstanceType<typeof GitHubPollingService>|undefined;
const {FilterConfigManager}=await import('../../../packages/daemon/src/lib/github/filter-config-manager.ts');
const {Logger}=await import('../../../packages/daemon/src/lib/logger.ts');
const logError=Logger.prototype.error;let deliveryFailures=0;
Logger.prototype.error=function(...args){if(args[0]==='Failed to deliver polled event')deliveryFailures++;return Reflect.apply(logError,this,args);};
let service:InstanceType<typeof GitHubService>|undefined;const unsubscribe:(()=>void)[]=[];let failureRawId:number|undefined;let failureArmed=false;const observedIds:number[]=[];
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
    commandPosts++;assert.equal(message.lane,'write');assert.deepEqual(message.args&&Object.keys(message.args).sort(),['args','method']);const args=message.args as {method:string;args:[object,string,number]};assert.equal(args.method,'create');assert.equal(args.args.length,3);assert.equal(typeof args.args[0],'object');assert.equal(typeof args.args[1],'string');assert.equal(typeof args.args[2],'number');const rawId=((args.args[0] as {rawEvent:{id:number}}).rawEvent).id;observedIds.push(rawId);if(failureArmed&&rawId===failureRawId){loseNext=true;failureArmed=false;}
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
 type Item=import('../../../packages/shared/src/mod.ts').InboxItem;
 const repo=new InboxItemRepository(main);const notices:Item[]=[];
 unsubscribe.push(app.internalEventBus.subscribe('github.inboxItemAdded',data=>{const item=data.item as Item;assert.deepEqual(repo.listItems().find(row=>row.id===item.id),item);notices.push(item);},{subscriberName:'synthetic-poll-tail-receipt'}));
 new FilterConfigManager(main).setGlobalFilter({repositories:['synthetic/*'],authors:{mode:'all'},labels:{mode:'any'},events:{issues:['updated'],issue_comment:['created'],pull_request:['updated']}});
 main.prepare("UPDATE job_queue SET run_at=? WHERE status='pending'").run(Date.now()+86_400_000);
 const cached=main.prepare('INSERT INTO inbox_items(id)VALUES(?)');measuring=true;assert.throws(()=>cached.run(crypto.randomUUID()),/inbox-create SQL reached main/);assert.throws(()=>main!.prepare('SELECT * FROM inbox_items WHERE id=?').get('synthetic'),/inbox-create SQL reached main/);assert.equal(mainSqlAttempts,2);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
 const wait=async(predicate:()=>boolean)=>{const until=performance.now()+6000;while(!predicate()){assert(performance.now()<until,'native poll job deadline exceeded');await new Promise(done=>setTimeout(done,5));}};
 const tick=async()=>{const due=app!.jobQueue.listJobs({queue:'github.poll',status:'pending'}).filter(job=>job.runAt<=Date.now());assert.equal(due.length,1);assert((await app!.jobProcessor.tick())>=1);await wait(()=>app!.jobQueue.getJob(due[0].id)?.status==='completed');assert.equal(app!.jobQueue.getJob(due[0].id)?.result?.polled,true);return app!.jobQueue.getJob(due[0].id)!.status;};
 let previous=performance.now();let maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
 const scenarios:Record<string,unknown>[]=[];
 for(const failed of [1,2,4,5]){
  let interval=120;const repository=`synthetic/tail-${failed}`;const requests:{page:string;conditional:boolean;hasSince:boolean}[]=[];
  const issue=(id:number)=>({id,number:id,title:'Synthetic issue',body:'Synthetic short body',state:'open',labels:[],user:{login:'synthetic',type:'User'},created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',html_url:`https://example.invalid/issues/${id}`});
  const comment=(id:number)=>({id,body:'Synthetic short comment',user:{login:'synthetic',type:'User'},issue_url:`https://api.github.com/repos/${repository}/issues/${id}`,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',html_url:`https://example.invalid/comments/${id}`});
  const beforeRows=repo.listItems().length;const beforeNotices=notices.length;const beforePosts=commandPosts;const beforeObserved=observedIds.length;const beforeFailures=deliveryFailures;
  service=new GitHubService({db:app.db,internalEventBus:app.internalEventBus,config:getConfig(),apiKey:''});
  poller=new GitHubPollingService({token:'synthetic-transport-only',collectPollPage:async(subject,_cycle,validator)=>{const url=new URL(subject.url);assert(url.pathname.startsWith(`/repos/${repository}/issues`));const page=url.pathname.endsWith('/comments')?'comments':'issues';const etag=`"synthetic-${failed}-${page}"`;requests.push({page,conditional:validator===etag,hasSince:url.searchParams.has('since')});return validator===etag?new Response(null,{status:304,headers:{ETag:etag}}):Response.json(page==='issues'?[1,2,3].map(issue):[4,5,6].map(comment),{headers:{ETag:etag}});}},async event=>{await service!.processEvent(event);});
  poller.addRepository('synthetic',`tail-${failed}`);poller.start();
  app.jobProcessor.register('github.poll',()=>handleGitHubPoll({pollingService:poller,jobQueue:app!.jobQueue,intervalMs:()=>interval*1000}));
  await app.db.gateway.call(githubPollRefreshWrites,'refresh',{enabled:true,reschedulePending:true,runAt:Date.now()});failureRawId=failed;failureArmed=true;
  const at=performance.now();const job=await tick();const firstJobMs=performance.now()-at;
  const retained=repo.listItems().filter(item=>item.repository===repository);const delivered=notices.slice(beforeNotices).map(item=>(item.rawEvent as {id:number}).id);
  assert.equal(retained.length,6,'one uncertain commit must not discard the rest of either page');assert.equal(repo.listItems().length,beforeRows+6);assert.deepEqual(observedIds.slice(beforeObserved),[1,2,3,4,5,6]);assert.deepEqual(delivered,[1,2,3,4,5,6].filter(id=>id!==failed));assert.equal(commandPosts,beforePosts+6);assert.equal(deliveryFailures,beforeFailures+1);assert.equal(failureArmed,false);assert.deepEqual(requests,[{page:'issues',conditional:false,hasSince:false},{page:'comments',conditional:false,hasSince:false}]);
  await app.db.gateway.call(githubPollRefreshWrites,'refresh',{enabled:true,reschedulePending:true,runAt:Date.now()});const repeatJob=await tick();assert.equal(repo.listItems().length,beforeRows+6);assert.equal(notices.length,beforeNotices+5);assert.equal(commandPosts,beforePosts+6);assert.equal(deliveryFailures,beforeFailures+1);assert.deepEqual(requests.slice(2),[{page:'issues',conditional:true,hasSince:true},{page:'comments',conditional:true,hasSince:true}]);
  scenarios.push({failedPosition:failed,page:failed<4?'issues':'comments',firstJobMs,job,repeatJob,retainedRows:6,committedNotices:5,writeAttempts:6,errorLoggedOnce:true,conditionalRepeatDoesNotReplay:true});
  interval=0;await app.db.gateway.call(githubPollRefreshWrites,'refresh',{enabled:false,reschedulePending:false,runAt:Date.now()});poller.stop();poller=undefined;service.stop();service=undefined;
 }
 const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthAfterPollsMs=performance.now()-healthAt;assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.scenarios=scenarios;evidence.maxLoopLagMs=maxLoopLagMs;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.commandPosts=commandPosts;evidence.deliveryFailuresLogged=deliveryFailures;evidence.actualRegisteredPollJobsExercised=true;evidence.credentialBootstrapExercised=false;evidence.servicePollStartupBridgeExercised=false;evidence.pendingReadsRemainMain=true;evidence.pass=true;
}finally{
 measuring=false;for(const stop of unsubscribe)stop();service?.stop();poller?.stop();Logger.prototype.error=logError;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}
 try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}
 finally{SQLite.prototype.prepare=prepare;JobQueueProcessor.prototype.start=start;globalThis.Worker=NativeWorker;globalThis.fetch=nativeFetch;evidence.mainSqlAttempts=mainSqlAttempts;evidence.workerMetrics=metrics;writeFileSync(join(run,'evidence/poll-tail.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok registered native poll jobs retain issue/comment tails after uncertain inbox receipts; conditional repeats do not replay writes');
