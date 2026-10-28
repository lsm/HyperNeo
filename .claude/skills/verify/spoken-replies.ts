import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert(['verify','serve'].includes(mode)); assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.HOME, join(run,'home'));
for (const dir of ['workspace','bin','evidence']) mkdirSync(join(run,dir), { recursive:true });
writeFileSync(join(run,'bin/gh'), '#!/bin/sh\nexit 1\n', { mode:0o700 });
const network = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert(['127.0.0.1','localhost'].includes(url.hostname), 'external network disabled');
  return network(input, init);
}) as typeof fetch;
const app = await createDaemonApp({ config: { ...getConfig({ port:mode === 'serve' ? 18554 : 0, host:'127.0.0.1', dbPath:join(run,'data/daemon.db') }), disableWorktrees:true, disableGoalProcessing:true }, verbose:false });
assert.notEqual(app.server.port,8399);
const sessionId = 'neo:10000000-0000-4000-8000-000000000001';
await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
await app.db.createSession({ id:sessionId, title:'Public speech fixture', workspacePath:join(run,'workspace'), createdAt:new Date().toISOString(), lastActiveAt:new Date().toISOString(), status:'active', config:{queryMode:'manual'}, metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0} });
new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId, kind:'neo', projectId:null });
const mcp = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({sessionId, role:'neo'}));
const speak = async (requestId: string) => {
  const response = await mcp({ name:'neo.speech.say', input:{requestId,text:'好，我帮你查一下订单。'} });
  return JSON.parse(response.content[0].text);
};
const evidence = () => ({ speech:[...new Map((app.db.getDatabase().prepare("SELECT reason FROM operation_refusals WHERE operation='neo.speech' ORDER BY rowid").all() as {reason:string}[]).map(row=>{const value=JSON.parse(row.reason); return [value.id,value];})).values()], publications:app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM neo_publications').get() });
const wait = async (check: () => boolean) => { for(let i=0;i<200 && !check();i++) await new Promise(done => setTimeout(done,20)); assert(check()); };
const clients: { hub:MessageHub; transport:WebSocketClientTransport; events:unknown[] }[] = [];
let finish = () => {};
const finished = new Promise<void>(done => { finish = done; });
let sequence=0;
const fixture = createServer(async (request,response) => {
  try {
    response.setHeader('Content-Type','application/json');
    if (request.url === '/speak') { response.end(JSON.stringify(await speak('ui-'+(++sequence)))); return; }
    if (request.url === '/evidence') { response.end(JSON.stringify(evidence())); return; }
    if (request.url === '/stop') { response.end('{}'); finish(); return; }
    if (request.url === '/v1/audio/voices') {
      response.end(JSON.stringify({ model:'fixture', data:[{id:'vivian',name_en:'Vivian',name_zh:'薇薇安'},{id:'ryan',name_en:'Ryan',name_zh:'瑞恩'}] })); return;
    }
    if (request.url === '/v1/audio/transcriptions') {
      for await (const _ of request) {}
      response.end(JSON.stringify({text:'Public conversation fixture'})); return;
    }
    if (request.url === '/v1/audio/speech') {
      for await (const _ of request) {}
      response.setHeader('Content-Type','audio/pcm');
      const pcm=Buffer.alloc(3840);
      for(let i=0;i<1920;i++) pcm.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/24000)*3000),i*2);
      for(let i=0;i<40 && !response.destroyed;i++) { response.write(pcm); await new Promise(done=>setTimeout(done,80)); }
      response.end(); return;
    }
    response.statusCode=404; response.end('{}');
  } catch { response.statusCode=500; response.end('{}'); }
});
try {
  if (mode === 'serve') {
    await new Promise<void>(done => fixture.listen(18555,'127.0.0.1',done));
    app.db.updateGlobalSettings({voice:{enabled:true,endpoint:'http://127.0.0.1:18555/v1/audio/transcriptions',model:'fixture',mode:'batch',allowPrivateNetwork:true}});
    console.log('ready: daemon=18554 fixture=18555');
    process.once('SIGTERM',finish); process.once('SIGINT',finish);
    await Promise.race([finished,new Promise(done=>setTimeout(done,30*60_000).unref())]);
  } else {
    for(let i=0;i<2;i++) {
      const hub=new MessageHub({defaultSessionId:'global'}), transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false}), events:unknown[]=[];
      hub.registerTransport(transport); hub.onEvent('neo.speech', event=>events.push(event));
      await transport.initialize(); clients.push({hub,transport,events});
    }
    const call=(name:string,input:unknown,index=0)=>clients[index].hub.request<{ok:boolean;state?:string}>('operation.invoke',{name:'neo.speech.'+name,input});
    assert((await call('listen',{sessionId,enabled:true})).ok);
    const saved=await speak('first'); assert(saved.ok && saved.created);
    await wait(()=>clients[0].events.length===1); assert.equal(clients[1].events.length,0);
    assert.equal((await speak('first')).created,false); assert.equal(clients[0].events.length,1);
    assert.equal((await call('ack',{sessionId,id:saved.id,state:'played'},1)).ok,false);
    assert.equal((await call('ack',{sessionId,id:saved.id,state:'playing'})).state,'playing');
    assert.equal((await call('ack',{sessionId,id:saved.id,state:'played'})).state,'played');
    const queued=await speak('second'); assert(queued.ok);
    for(let i=0;i<3;i++) assert((await speak('fill-'+i)).created);
    assert.equal((await speak('second')).created,false);
    assert.match((await speak('overflow')).reason,/^speech_queue_full:/);
    await clients[0].transport.close();
    await wait(()=>evidence().speech.some((row:unknown)=>(row as {id:string;state:string}).id===queued.id && (row as {state:string}).state==='cancelled'));
    assert.match((await speak('no-listener')).reason,/^voice_replies_off:/);
    assert((await call('listen',{sessionId,enabled:true},1)).ok);
    assert.equal((await speak('second')).created,false);
    assert.equal(clients[1].events.length,0);
    console.log(JSON.stringify({passed:true, realWebSocket:true, mcp:true, writerWorker:true, unrelatedClientSilent:true, noReplay:true, fullQueueRetry:true, ...evidence()}));
  }
} finally {
  writeFileSync(join(run,'evidence/spoken-replies.json'),JSON.stringify(evidence(),null,2));
  fixture.closeAllConnections(); await new Promise<void>(done=>fixture.close(()=>done()));
  for(const client of clients) { await client.transport.close(); client.hub.cleanup(); }
  await app.cleanup(); globalThis.fetch=network;
}
