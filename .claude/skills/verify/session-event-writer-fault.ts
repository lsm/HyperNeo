import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { runMigration331 } from '../../../packages/daemon/src/storage/schema/m331-session-external-events.ts';
import { SessionEventWriter } from '../../../packages/daemon/src/lib/external-events/session-event-writer.ts';
import { SessionExternalEventStore } from '../../../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import { ExternalEventService, type ExternalEventPublishedPayload } from '../../../packages/daemon/src/lib/external-events/external-event-service.ts';
import type { ExternalEvent } from '../../../packages/daemon/src/lib/external-events/types.ts';
import { createInternalEventBus } from '../../../packages/daemon/src/lib/internal-event-bus.ts';

const run=resolve(process.argv[2]);assert(run.startsWith('/private/tmp/'));assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
mkdirSync(join(run,'data'));mkdirSync(join(run,'evidence'));
const results:unknown[]=[],nativeURL=new URL('../../../packages/daemon/src/lib/external-events/session-event-writer-worker.ts',import.meta.url).href,storeURL=new URL('../../../packages/daemon/src/lib/external-events/session-external-event-store.ts',import.meta.url).href;
const body='Complete human result 🦊\n'.repeat(90000),bodySHA=createHash('sha256').update(body).digest('hex');
for(const mode of ['before','rollback','after','timeout','healthy','memory']){
 const dbPath=mode==='memory'?':memory:':join(run,'data',mode+'.db'),db=new Database(dbPath);db.exec('PRAGMA journal_mode=WAL');runMigration331(db);
 const store=new SessionExternalEventStore(db),bus=createInternalEventBus<{'externalEvent.published':ExternalEventPublishedPayload}>(),seen:unknown[]=[];
 bus.subscribe('externalEvent.published',event=>{assert.equal(store.getById(event.eventId)?.event.payload.body,body);seen.push(event.eventId);},{subscriberName:'native-writer-fault'});
 const fixture=join(run,mode+'.ts');
 writeFileSync(fixture,`const send=globalThis.postMessage.bind(globalThis);globalThis.postMessage=(reply)=>{if(reply.outcome?.action==='ingested'&&${JSON.stringify(['after','timeout'].includes(mode))}){${mode==='after'?"queueMicrotask(()=>{throw new Error('synthetic lost committed reply')});":''}return;}send(reply);};
 ${mode==='rollback'?`const {SessionExternalEventStore}=await import(${JSON.stringify(storeURL)});const store=SessionExternalEventStore.prototype.store;SessionExternalEventStore.prototype.store=function(event){store.call(this,event);throw new Error('synthetic rollback after INSERT');};`:''}
 await import(${JSON.stringify(nativeURL)});const ingest=globalThis.onmessage;globalThis.onmessage=event=>{if(${JSON.stringify(mode==='before')})throw new Error('synthetic failure before INSERT');ingest(event);};send({ready:true});`);
 let workers=0;const writer=mode==='memory'?undefined:new SessionEventWriter(dbPath,()=>{const injected=workers++===0&&mode!=='healthy',worker=new Worker(injected?pathToFileURL(fixture).href:nativeURL,{type:'module'});if(injected){let ready=false;const pending:unknown[]=[],post=worker.postMessage.bind(worker);worker.addEventListener('message',({data})=>{if(data.ready){ready=true;for(const request of pending)post(request);pending.length=0;}});worker.postMessage=((request:unknown)=>{if(ready)post(request);else pending.push(request);}) as typeof worker.postMessage;}return worker;},mode==='timeout'?1000:5000);
 const service=new ExternalEventService(store,bus,writer?(event)=>writer.ingest(event):undefined);
 const event:ExternalEvent={id:mode,spaceId:'sessions',source:'github',topic:'github/synthetic/writer/pull_request/7',dedupeKey:mode,occurredAt:1,ingestedAt:2,summary:'Complete result',payload:{body}};
 try{
  const start=performance.now();let error='';try{await service.publish(event);}catch(e){error=String(e);}
  const elapsedMs=performance.now()-start;
  if(['before','rollback','after','timeout'].includes(mode)){
   assert(error,mode);assert.equal(seen.length,0);assert.equal(workers,1);
   if(mode==='rollback')assert.match(error,/synthetic rollback/);else assert.match(error,/outcome unknown[\s\S]*not replayed/);
   const committed=['after','timeout'].includes(mode);assert.equal(!!store.getById(mode),committed);
   if(committed)assert.equal(store.getById(mode)?.event.payload.body,body);
   const recovered=await service.publish(event);assert.equal(recovered.outcome,committed?'duplicate_terminal':'published');assert.equal(seen.length,committed?0:1);assert.equal(workers,2);
  }else{assert.equal(error,'');assert.equal(seen.length,1);}
  assert.equal(createHash('sha256').update(String(store.getById(mode)?.event.payload.body)).digest('hex'),bodySHA);
  assert.equal((await service.publish({...event,id:mode+'-duplicate',payload:{body:'must not replace complete bytes'}})).outcome,'duplicate_terminal');
  assert.equal(store.getById(mode)?.event.payload.body,body);await writer?.close();assert.equal(db.prepare('SELECT COUNT(*) n FROM session_external_events').get().n,1);
  results.push({mode,elapsedMs,error,workers,publications:seen.length,rowCount:1,completeBodySHA:bodySHA});
 }finally{await writer?.close().catch(()=>{});db.close();}
}
writeFileSync(join(run,'evidence/fault.json'),JSON.stringify({verified:true,bodyBytes:Buffer.byteLength(body),results},null,2));console.log(JSON.stringify({verified:true,results}));
