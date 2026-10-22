import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { SDKBunWorkerBridge } from '../../../packages/daemon/tests/helpers/sdk-bun-worker-bridge.ts';

const [mode,run]=process.argv.slice(2);
assert(['baseline','verify','bridge'].includes(mode));assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
await mkdir(join(run,'evidence'),{recursive:true});
const summaryMode=process.env.VERIFY_SQL_SUMMARY;
const sqlLogs:Record<string,unknown>[]=[];
const unsubscribe=subscribeToStructuredLogs(event=>{if(event.module==='hyperneo:daemon:sqlite.query'&&event.metadata.workerKind==='sdk-status')sqlLogs.push(event.metadata);});
const NativeWorker=globalThis.Worker;
if(mode==='bridge') globalThis.Worker=function(url:string|URL,options?:WorkerOptions) { return String(url).endsWith('/sdk-status-worker.ts')?new SDKBunWorkerBridge(String(url)):new NativeWorker(url,options); } as unknown as typeof Worker;
const app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',dbPath:mode==='bridge'?join(run,'data/daemon.db'):':memory:',workspaceRoot:run}),sqlQueryObservability:summaryMode?{slowThresholdMs:0,summaryIntervalMs:1000,maxQueryGroups:128,summaryQueryLimit:128}:undefined,port:0,disableWorktrees:true,disableGoalProcessing:true},standalone:false,verbose:false});
assert.notEqual(app.server.port,8399);
let ws:WebSocket|undefined;const evidence:Record<string,unknown>={mode,dbPath:app.db.getDbPath()};
try {
 ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
 const pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void}>();
 ws.onmessage=({data})=>{const r=JSON.parse(String(data)),id=r.requestId??r.id,p=pending.get(id);if(p){pending.delete(id);r.error?p.reject(new Error(JSON.stringify(r.error))):p.resolve(r.data);}};
 await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=()=>reject(new Error('RPC socket failed'));});
 const rpc=(method:string,data:unknown={})=>new Promise<unknown>((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>reject(new Error('RPC timeout')),10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws!.send(JSON.stringify({id,method,data,type:'REQ',sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));});
 const {sessionId}=await rpc('session.create',{workspacePath:join(run,'workspace'),config:{queryMode:'manual'}}) as {sessionId:string};
 const text='Complete memory text 🦊\n'.repeat(2000);
 app.db.saveUserMessage(sessionId,{type:'user',uuid:'memory-user',parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text},{type:'image'},{type:'text',text:'Second'}]}} as SDKMessage,'consumed');
 const hash=()=>{const h=createHash('sha256');for(const r of app.db.getDatabase().prepare('SELECT sdk_message FROM sdk_message_bodies ORDER BY seq').iterate() as Iterable<{sdk_message:string}>)h.update(r.sdk_message);return h.digest('hex');};
 const before=hash(),at=performance.now();
 const result=await rpc('session.messages.byStatus',{sessionId,status:'consumed',limit:20}).then(value=>({value}),error=>({error:String(error)}));
 evidence.rpcMs=performance.now()-at;
 if(mode==='baseline'){assert('error' in result);assert(result.error.includes('file-backed'));evidence.error=result.error;}
 else {assert('value' in result);const page=result.value as {total:number;messages:{text:string}[]};assert.equal(page.total,1);assert.equal(page.messages[0].text,text+'\nSecond');evidence.total=page.total;}
 if(mode!=='baseline') {
  const pageAt=performance.now();
  const page=await rpc('message.sdkMessages',{sessionId,limit:20}) as {sdkMessages:{uuid:string;message:{content:unknown}}[];hasMore:boolean;backgroundTaskMessages:unknown[]};
  evidence.pageMs=performance.now()-pageAt;
  assert.equal(page.sdkMessages.length,1);assert.equal(page.sdkMessages[0].uuid,'memory-user');
  assert.deepEqual(page.sdkMessages[0].message.content,[{type:'text',text},{type:'image'},{type:'text',text:'Second'}]);
  assert.equal(page.hasMore,false);assert.deepEqual(page.backgroundTaskMessages,[]);
  const repeated=await rpc('message.sdkMessages',{sessionId,limit:20});assert.deepEqual(repeated,page);
  evidence.repeatedPageMatched=true;
  if(summaryMode){
   await new Promise(resolve=>setTimeout(resolve,1200));
   const summaries=sqlLogs.filter(m=>m.event==='summary'&&m.reason==='interval');
   assert(summaries.length>0,'No interval summary observed');
   evidence.intervalSummaries=summaries;
   evidence.slowOperationLabels=[...new Set(sqlLogs.filter(m=>m.event==='slow').map(m=>m.workerOperation))];
   assert((evidence.slowOperationLabels as unknown[]).includes('sdk-page'));
   assert((evidence.slowOperationLabels as unknown[]).includes('sdk-status'));
   if(summaryMode==='baseline') assert(summaries.some(m=>m.workerOperation==='sdk-page'),'Baseline failed to reproduce last-request summary attribution');
   else assert(summaries.every(m=>!('workerOperation' in m)),'Mixed summary attributed to one request');
  }
 }
 assert.equal(hash(),before);evidence.bodySha256=before;
 assert.equal((await rpc('system.health') as {status:string}).status,'ok');evidence.health='ok';
} finally {ws?.close();await app.cleanup();unsubscribe();globalThis.Worker=NativeWorker;await writeFile(join(run,'evidence/memory.json'),JSON.stringify(evidence,null,2));}
