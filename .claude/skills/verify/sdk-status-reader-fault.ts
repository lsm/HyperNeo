import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const [run] = process.argv.slice(2);
assert(run.startsWith('/private/tmp/')); assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run,'home')); assert.equal(process.env.HYPERNEO_DATA_DIR, join(run,'data'));
await mkdir(join(run,'evidence'),{recursive:true});
const faultPath = join(run,'fault-worker.ts');
await writeFile(faultPath, "self.onmessage = () => { throw new Error('synthetic SDK reader crash'); }; postMessage({ready:true});\n");
const NativeWorker = globalThis.Worker; let first = true;
globalThis.Worker = function(url: string | URL, options?: WorkerOptions) {
  if(first && String(url).endsWith('/sdk-status-worker.ts')) { first=false; return new NativeWorker(new URL('file://'+faultPath).href,options); }
  return new NativeWorker(url,options);
} as unknown as typeof Worker;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const evidence: Record<string,unknown> = {};
try {
  app = await createDaemonApp({config:{...getConfig({host:'127.0.0.1',dbPath:join(run,'data/daemon.db'),workspaceRoot:run}),port:0,disableWorktrees:true,disableGoalProcessing:true},standalone:false,verbose:false});
  assert.notEqual(app.server.port,8399);
  ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  const pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void}>();
  ws.onmessage=({data})=>{const r=JSON.parse(String(data)),id=r.requestId??r.id,p=pending.get(id);if(p){pending.delete(id);r.error?p.reject(new Error(JSON.stringify(r.error))):p.resolve(r.data);}};
  await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=()=>reject(new Error('RPC socket failed'));});
  const rpc=(method:string,data:unknown={})=>new Promise<unknown>((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>reject(new Error('RPC timeout')),10000);pending.set(id,{resolve:(v)=>{clearTimeout(timer);resolve(v);},reject:(e)=>{clearTimeout(timer);reject(e);}});ws!.send(JSON.stringify({id,method,data,type:'REQ',sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));});
  const {sessionId}=await rpc('session.create',{workspacePath:join(run,'workspace'),config:{queryMode:'manual'}}) as {sessionId:string};
  const text='Full user text 🦊\n'.repeat(2000);
  app.db.saveUserMessage(sessionId,{type:'user',uuid:'fault-retention',parent_tool_use_id:null,message:{role:'user',content:text}} as SDKMessage,'consumed');
  const hash=()=>{const h=createHash('sha256');for(const r of app!.db.getDatabase().prepare('SELECT sdk_message FROM sdk_message_bodies ORDER BY seq').iterate() as Iterable<{sdk_message:string}>)h.update(r.sdk_message);return h.digest('hex');};
  const before=hash(),at=performance.now();
  evidence.error=await rpc('session.messages.byStatus',{sessionId,status:'consumed',limit:20}).then(()=>{throw new Error('Fault returned fabricated success');},(error)=>String(error));
  evidence.failureMs=performance.now()-at;assert(String(evidence.error).includes('SDK reader failed'));
  const healthAt=performance.now();assert.equal((await rpc('system.health') as {status:string}).status,'ok');evidence.healthMs=performance.now()-healthAt;
  const recovered=await rpc('session.messages.byStatus',{sessionId,status:'consumed',limit:20}) as {total:number;messages:{text:string}[]};
  assert.equal(recovered.total,1);assert.equal(recovered.messages[0].text,text);assert.equal(hash(),before);
  evidence.bodySha256=before;evidence.recovered=true;console.log(JSON.stringify(evidence));
} finally {ws?.close();await app?.cleanup();globalThis.Worker=NativeWorker;await writeFile(join(run,'evidence/fault.json'),JSON.stringify(evidence,null,2));}
