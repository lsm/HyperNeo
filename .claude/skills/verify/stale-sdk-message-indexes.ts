import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { handoffPromptToMailbox } from '../../../packages/daemon/src/lib/mailbox/handoff.ts';

const run=resolve(process.argv[2]),mode=process.argv[3]??'verify',path=join(run,'data/daemon.db');
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(path));
assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.ANTHROPIC_API_KEY,undefined);
for(const dir of ['home','bin','evidence'])mkdirSync(join(run,dir),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined;
const logs:unknown[]=[],calls:unknown[]=[];
const unsubscribe=subscribeToStructuredLogs(event=>logs.push(event));
const evidence:Record<string,any>={verified:false,mode,sourceCommit:BUILD_METADATA.commit};
const pause=()=>new Promise(done=>setTimeout(done,25));
const indexes=()=>app!.db.getDatabase().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_sdk_messages_uuid_status','idx_sdk_messages_session') ORDER BY name").all();
async function start(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:path}),verbose:false});assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});
 ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
 await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('RPC connection failed'));});
}
async function stop(){ws?.close();ws=undefined;await app?.cleanup();app=undefined;}
async function rpc(method:string,data:unknown,events=false):Promise<any>{
 const id=crypto.randomUUID(),seen:unknown[]=[];
 const reply=await new Promise<any>((done,fail)=>{
  const timer=setTimeout(()=>fail(new Error(`RPC timeout: ${method}`)),10000);
  ws!.onmessage=event=>{const message=JSON.parse(String(event.data));if(message.type==='EVENT')seen.push(message);if(message.requestId!==id&&message.id!==id)return;clearTimeout(timer);if(message.error)fail(new Error(JSON.stringify(message.error)));else if(events)setTimeout(()=>done({reply:message.data,events:seen}),100);else done(message.data);};
  ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method,data,timestamp:new Date().toISOString(),version:'1.0.0'}));
 });calls.push({method,reply});return reply;
}
async function until(read:()=>any,label:string){for(let i=0;i<400;i++){const value=read();if(value)return value;await pause();}throw new Error(label);}
try{
 await start();
 const created=await rpc('session.create',{workspacePath:join(run,'home'),title:'Synthetic stale indexes'}),sid=created.sessionId;
 assert.equal(typeof sid,'string');evidence.sessionId=sid;
 const db=app!.db.getDatabase();
 const marker173=db.prepare("SELECT applied_at FROM migration_markers WHERE key='migration_173'").get();assert(marker173);evidence.marker173=marker173;
 db.prepare("DELETE FROM migration_markers WHERE key='migration_449'").run();
 db.exec("CREATE INDEX idx_sdk_messages_uuid_status ON sdk_messages(session_id,send_status,json_extract(sdk_message,'$.uuid'))");
 db.exec('CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id,timestamp)');evidence.before=indexes();assert.equal(evidence.before.length,2);
 try{await app!.db.saveUserMessage(sid,{type:'user',uuid:'synthetic-legacy-failure',message:{role:'user',content:'Synthetic old-index failure'}} as never,'deferred');assert.fail('Legacy expression index must reject empty-body insertion');}
 catch(error){evidence.legacySaveError=String(error);assert.match(String(error),/malformed JSON/);}
 if(mode!=='baseline'){
  await stop();await start();evidence.after=indexes();
  if(mode==='failure-baseline')app!.db.getDatabase().exec('DROP INDEX IF EXISTS idx_sdk_messages_uuid_status; DROP INDEX IF EXISTS idx_sdk_messages_session');
  else{
   assert.deepEqual(evidence.after,[],'New migration must retire both indexes despite the old 173 marker');
   evidence.marker449=app!.db.getDatabase().prepare("SELECT applied_at FROM migration_markers WHERE key='migration_449'").get();assert(evidence.marker449);
   assert.deepEqual(app!.db.getDatabase().prepare("SELECT applied_at FROM migration_markers WHERE key='migration_173'").get(),marker173);
  }
  const sent=await rpc('message.send',{sessionId:sid,content:'Synthetic save after index repair',deliveryMode:'defer'});evidence.sent=sent;
  const raw=app!.db.getDatabase();
  evidence.saved=await until(()=>raw.prepare('SELECT id,send_status FROM sdk_messages WHERE session_id=? AND sdk_uuid=?').get(sid,sent.messageId),'Repaired save never appeared');
  raw.exec(`CREATE TRIGGER synthetic_save_failure BEFORE INSERT ON sdk_messages WHEN NEW.send_status != 'failed' BEGIN SELECT RAISE(ABORT,'synthetic primary save failure'); END`);
  const failedUuid=crypto.randomUUID();evidence.failedUuid=failedUuid;
  evidence.handoff=await handoffPromptToMailbox({to:`session:${sid}`,message:{type:'user',message:{content:'Synthetic retained failed input'},parent_tool_use_id:null},origin:'chat',deliveryMode:'defer',messageUuid:failedUuid,policy:{maxAttempts:1},jobQueue:app!.jobQueue});
  assert.equal(evidence.handoff.kind,'enqueued');
  evidence.failed=await until(()=>raw.prepare("SELECT id,send_status FROM sdk_messages WHERE session_id=? AND sdk_uuid=? AND send_status='failed'").get(sid,failedUuid),'Save failure did not leave a failed transcript message');
  const feed=await rpc('liveQuery.subscribe',{queryName:'messages.bySession',subscriptionId:'stale-index-failure',params:[sid,200]},true);evidence.feed=feed;
  const feedText=JSON.stringify(feed);assert(feedText.includes('Synthetic retained failed input'));assert(feedText.includes('failed'));
  evidence.failureLogs=logs.filter(event=>JSON.stringify(event).includes('dead-lettered')&&JSON.stringify(event).includes(sid));
  assert(evidence.failureLogs.length,'Save failure must be logged with its target session id even with verbose:false');
  assert(JSON.stringify(evidence.failureLogs).includes('synthetic primary save failure'));
  raw.exec('DROP TRIGGER synthetic_save_failure');
  await stop();await start();assert.deepEqual(indexes(),[],'Indexes must remain absent on another startup');
 }
 evidence.verified=true;console.log(JSON.stringify({verified:true,mode,evidence:join(run,'evidence/indexes.json')}));
}finally{
 evidence.logs=logs;evidence.rpc=calls;writeFileSync(join(run,'evidence/indexes.json'),JSON.stringify(evidence,null,2));await stop();unsubscribe();globalThis.fetch=network;
}
