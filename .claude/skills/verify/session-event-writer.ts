import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SDKBunWorkerBridge } from '../../../packages/daemon/tests/helpers/sdk-bun-worker-bridge.ts';
import type { ExternalEvent } from '../../../packages/daemon/src/lib/external-events/types.ts';
import type { ExternalEventPublisher } from '../../../packages/daemon/src/lib/external-events/external-event-service.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { SessionExternalEventStore } from '../../../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import { SessionEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/session-event-subscription-repository.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';

const [mode, text] = process.argv.slice(2), run = resolve(text);
assert(['baseline','verify'].includes(mode)); assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV,'test'); assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data')); assert(!existsSync(join(run,'data')));
assert.equal(process.env.PATH?.split(':')[0],join(run,'bin'));
mkdirSync(join(run,'bin')); mkdirSync(join(run,'evidence'));
const memory=process.env.VERIFY_WRITER_MEMORY==='1';
const when = Date.now()-10000, body = 'Complete synthetic human report 🦊\n'.repeat(300);
writeFileSync(join(run,'bin/gh'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),path=args.find(a=>a.startsWith('/repos/')||a==='/user');
if(args[0]!=='api'||!path)process.exit(2); let data=[];
if(path==='/user')data={login:'synthetic-human'};
else if(path.includes('/check-runs'))data={check_runs:[]};
else if(/\\/pulls\\/7(?:\\?|$)/.test(path))data={number:7,state:'open',mergeable:true,head:{sha:'a'.repeat(40)}};
else if(path.includes('/pulls/comments'))data=[{id:1,body:${JSON.stringify(body)},commit_id:'a'.repeat(40),pull_request_url:'https://github.com/synthetic/writer/pull/7',html_url:'https://github.com/synthetic/writer/pull/7#discussion_r1',user:{login:'synthetic-reviewer'},created_at:new Date(${when}).toISOString(),updated_at:new Date(${when}).toISOString()}];
fs.appendFileSync(${JSON.stringify(join(run,'evidence/gh.jsonl'))},JSON.stringify({args})+'\\n');
if(args.includes('--include'))process.stdout.write('HTTP/2.0 200 Synthetic\\r\\nX-RateLimit-Remaining: 4900\\r\\nContent-Type: application/json\\r\\n\\r\\n');process.stdout.write(JSON.stringify(data));
`,{mode:0o700});
const wait = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined,holder:ReturnType<typeof spawn>|undefined,probe:ReturnType<typeof spawn>|undefined;
let armed=false, measuring=false, holderExit:Promise<unknown>|undefined, probeText='', probeErrors='', timer:ReturnType<typeof setInterval>|undefined;
const evidence:Record<string,unknown>={mode,controlledLockMs:memory?0:1200,notProofOfProductionLockCause:true};
const metrics:unknown[]=[], mainSQL:{sql:string;ms:number}[]=[], mainTransactions:unknown[]=[];
const off=subscribeToStructuredLogs(event=>{if(measuring&&(event.module==='hyperneo:daemon:sqlite.worker'||event.module==='hyperneo:daemon:sqlite.query'))metrics.push(event);});
const originalStart=GitHubEventExtension.prototype.start, network=globalThis.fetch;
const NativeWorker=globalThis.Worker;
let sourceReplay: ExternalEventPublisher | undefined, originalEvent: ExternalEvent | undefined;
if(process.env.VERIFY_WRITER_IPC==='1') globalThis.Worker=function(url:string|URL, options?:WorkerOptions) { return String(url).endsWith('/session-event-writer-worker.ts') ? new SDKBunWorkerBridge(String(url)) : new NativeWorker(url,options); } as unknown as typeof Worker;
globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
GitHubEventExtension.prototype.start=async function(context){
 await originalStart.call(this,{...context,publisher:{publish:async event=>{
  if(armed&&event.spaceId==='sessions'){
   armed=false; sourceReplay=context.publisher; originalEvent=event;
   if(memory)return context.publisher.publish(event);
   holder=spawn('bun',['-e',`import {Database} from ${JSON.stringify(new URL('../../../packages/daemon/src/storage/sqlite-compat.ts',import.meta.url).href)};const db=new Database(${JSON.stringify(join(run,'data/daemon.db'))});db.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE;UPDATE session_writer_probe SET value=value+1');console.log('LOCKED');await Bun.sleep(1200);db.exec('COMMIT');db.close();`],{env:process.env,stdio:['ignore','pipe','pipe']});
   let output='',errors='';holder.stdout!.on('data',d=>{output+=String(d);});holder.stderr!.on('data',d=>{errors+=String(d);});holderExit=new Promise((resolve,reject)=>{holder!.once('exit',resolve);holder!.once('error',reject);});
   for(let n=0;n<500&&!output.includes('LOCKED');n++)await wait(10);
   assert(output.includes('LOCKED'),errors||'Lock-holder did not acquire the synthetic WAL write lock');
  }
  return context.publisher.publish(event);
 }}});
};
 const originalTransaction=Database.prototype.transaction;Database.prototype.transaction=(function(...args:Parameters<Database['transaction']>){const stack=new Error('main transaction created').stack;const tx=Reflect.apply(originalTransaction,this,args);const wrap=(target:Function):Function=>new Proxy(target,{apply(target,self,args){const at=performance.now();try{return Reflect.apply(target,self,args);}finally{if(measuring)mainTransactions.push({ms:performance.now()-at,stack});}},get(target,key){const value=Reflect.get(target,key);return ['immediate','deferred','exclusive'].includes(String(key))&&typeof value==='function'?wrap(value):value;}});return wrap(tx);}) as typeof Database.prototype.transaction;
try{
 app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:memory?':memory:':join(run,'data/daemon.db'),workspaceRoot:run}),disableWorktrees:true,disableGoalProcessing:true,sqlQueryObservability:{slowThresholdMs:250,summaryIntervalMs:300000,maxQueryGroups:256,summaryQueryLimit:20}},verbose:false});
 await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const raw=app.db.getDatabase(),store=new SessionExternalEventStore(raw);
 raw.exec('CREATE TABLE session_writer_probe(value INTEGER);INSERT INTO session_writer_probe VALUES(0)');
 const seedBody='Retained synthetic history 🦊\n'.repeat(30);
 raw.transaction(()=>{for(let i=0;i<(memory?64:100000);i++)store.store({id:'history-'+i,spaceId:'sessions',source:'synthetic-history',topic:'fixture/history',dedupeKey:String(i),occurredAt:when,ingestedAt:when,summary:'Retained',payload:{body:seedBody}});})();
 const historyHash=()=>{const hash=createHash('sha256');let count=0;for(const row of raw.prepare("SELECT * FROM session_external_events WHERE source='synthetic-history' ORDER BY id").iterate()){hash.update(JSON.stringify(row));count++;}return{count,sha256:hash.digest('hex')};};
 evidence.historyBefore=historyHash();
 app.db.createSession({id:'owner',title:'Synthetic owner',workspacePath:join(run,'home'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 const github=app.extensionManager.getExtension('github') as GitHubEventExtension;
 github.repo.upsertWatchedRepo({spaceId:'sessions',owner:'synthetic',repo:'writer',pollingEnabled:true});
 new SessionEventSubscriptionRepository(raw).upsert({sessionId:'owner',topic:'github/synthetic/writer/pull_request/7.*'});
 await new ExternalEventExtensionConfigStore(raw).setGlobalConfig('github',{source:'github',globallyEnabled:true,capabilities:{polling:true,rpcConfig:true}});
 const published:{eventId:string;storedBeforePublication:boolean}[]=[];
 app.internalEventBus.subscribe('externalEvent.published',payload=>{if(payload.spaceId==='sessions')published.push({eventId:payload.eventId,storedBeforePublication:!!store.getById(payload.eventId)});},{subscriberName:'writer-proof'});
 const url=`ws://127.0.0.1:${app.server.port}/ws`;ws=new WebSocket(url);
 const pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void}>();
 ws.onmessage=({data})=>{const r=JSON.parse(String(data)),id=r.requestId??r.id,p=pending.get(id);if(!p)return;pending.delete(id);r.error?p.reject(new Error(JSON.stringify(r.error))):p.resolve(r.data);};
 await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=()=>reject(new Error('RPC unavailable'));});
 const rpc=(method:string,data:unknown={})=>new Promise<unknown>((resolve,reject)=>{const id=crypto.randomUUID(),t=setTimeout(()=>reject(new Error('RPC deadline')),60000);pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});ws!.send(JSON.stringify({id,type:'REQ',method,data,sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));});

 const prepare=raw.prepare.bind(raw);raw.prepare=((sql:string)=>{const stmt=prepare(sql);return new Proxy(stmt,{get(target,key){const value=Reflect.get(target,key);if(!['get','all','run'].includes(String(key)))return typeof value==='function'?value.bind(target):value;return(...args:unknown[])=>{const at=performance.now();try{return value.apply(target,args);}finally{if(measuring)mainSQL.push({sql,ms:performance.now()-at});}};}});}) as typeof raw.prepare;
 probe=spawn('bun',['-e',`const ws=new WebSocket(${JSON.stringify(url)});let stopped=false,id=0,at=0;const samples=[];const send=()=>{if(stopped){console.log(JSON.stringify({samples}));ws.close();return;}at=performance.now();ws.send(JSON.stringify({id:String(++id),type:'REQ',method:'system.health',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));};ws.onopen=()=>{console.log('READY');send();};ws.onmessage=e=>{const r=JSON.parse(e.data);if((r.requestId??r.id)!==String(id))return;if(r.error)throw new Error(JSON.stringify(r.error));samples.push(performance.now()-at);setTimeout(send,10);};process.stdin.on('data',()=>{stopped=true;});setTimeout(()=>process.exit(2),60000).unref();`],{env:process.env,stdio:['pipe','pipe','pipe']});
 probe.stdout!.on('data',d=>{probeText+=String(d);});probe.stderr!.on('data',d=>{probeErrors+=String(d);});const probeExit=new Promise((resolve,reject)=>{probe!.once('exit',resolve);probe!.once('error',reject);});
 for(let n=0;n<500&&!probeText.includes('READY');n++)await wait(10);assert(probeText.includes('READY'),probeErrors);
 let maxLagMs=0,last=performance.now(),peakRssBytes=process.memoryUsage().rss;
 timer=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-last-10);last=now;peakRssBytes=Math.max(peakRssBytes,process.memoryUsage().rss);},10);
 await wait(30);armed=true;measuring=true;const at=performance.now();evidence.poll=await rpc('space.github.pollOnce');evidence.pollMs=performance.now()-at;
 assert.equal(armed,false,'The real session publisher was not exercised');if(!memory)assert.equal(await holderExit,0);
 await wait(30);clearInterval(timer);timer=undefined;measuring=false;probe.stdin!.end('stop');assert.equal(await probeExit,0,probeErrors);
 const samples=JSON.parse(probeText.trim().split('\n').at(-1)!).samples;assert(samples.length>0);evidence.maxHealthMs=Math.max(...samples);evidence.healthReplies=samples.length;evidence.maxLagMs=maxLagMs;evidence.peakRssBytes=peakRssBytes;evidence.mainSQL=mainSQL;evidence.mainTransactions=mainTransactions;evidence.metrics=metrics;
 const stored=raw.prepare("SELECT payload_json FROM session_external_events WHERE source='github' AND topic LIKE 'github/synthetic/writer/pull_request/7.%'").all() as {payload_json:string}[];
 assert.equal(stored.length,1);assert.equal(JSON.parse(stored[0].payload_json).body,body);assert(published.length>0);assert(published.every(p=>p.storedBeforePublication));
 evidence.payloadSha256=createHash('sha256').update(stored[0].payload_json).digest('hex');evidence.published=published;
 assert(sourceReplay && originalEvent); evidence.duplicate = await sourceReplay.publish({...originalEvent,id:crypto.randomUUID(),payload:{body:'different'}}); assert.equal((evidence.duplicate as {outcome:string}).outcome,'duplicate_terminal');
 await rpc('space.github.pollOnce');assert.equal(raw.prepare("SELECT COUNT(*) n FROM session_external_events WHERE source='github'").get().n,1);assert.equal(published.length,1);
 evidence.historyAfter=historyHash();assert.deepEqual(evidence.historyAfter,evidence.historyBefore);
 evidence.verified=true;console.log(JSON.stringify({mode,maxLagMs,maxHealthMs:evidence.maxHealthMs,pollMs:evidence.pollMs,history:evidence.historyAfter,payloadSha256:evidence.payloadSha256}));
 if(mode==='baseline')assert(maxLagMs>=1000,'No main-thread reproduction; inconclusive');else assert(maxLagMs<1000);
}finally{
 if(timer)clearInterval(timer);probe?.kill();holder?.kill();ws?.close();await app?.cleanup();off();Database.prototype.transaction=originalTransaction;globalThis.fetch=network;globalThis.Worker=NativeWorker;GitHubEventExtension.prototype.start=originalStart;
 writeFileSync(join(run,'evidence/writer.json'),JSON.stringify(evidence,null,2));
}
