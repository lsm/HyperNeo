import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { Database: SQLite } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { DevicePairingRepository } = await import('../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts');
const { humanDeviceResetReads } = await import('../../../packages/daemon/src/storage/repositories/human-device-reset-read.ts');
const { humanDeviceResetWrites } = await import('../../../packages/daemon/src/storage/repositories/human-device-reset-write.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker;
const nativeFetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start;
const prepare = SQLite.prototype.prepare;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
const transports: InstanceType<typeof WebSocketClientTransport>[] = [];
const subscriptions: (()=>void)[]=[];
const children=new Set<ReturnType<typeof spawn>>();
const timings: { roundTripMs: number; requestBytes: number; replyBytes: number; encodeMs: number }[] = [];
let measuring = false;
let mainConnection: InstanceType<typeof SQLite> | undefined;
let mainSqlAttempts = 0;
let rejectNextWrite = false;
let loseNextReceipt = false;
let commandPosts = 0;
const commandIds: string[]=[];
let readPosts = 0;
let rejectNextRead = false;
let receiptReaderUnavailableUntil = 0;
SQLite.prototype.prepare = function (...args) {
  const connection = this;
  const statement = Reflect.apply(prepare, this, args);
  if (!/UPDATE\s+paired_devices\s+SET\s+revoked_at|UPDATE\s+pairing_codes\s+SET\s+expires_at|INSERT\s+INTO\s+human_device_resets|INSERT\s+OR\s+IGNORE\s+INTO\s+neo_conversation|INSERT\s+INTO\s+neo_publications|SELECT\s+id\s+FROM\s+neo_conversation|FROM\s+human_device_resets\s+r/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && connection === mainConnection && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
        mainSqlAttempts++;
        throw new Error('pairing human-reset SQL reached main');
      }
      return Reflect.apply(value, target, values);
    };
  } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker);
    const sent = new Map<number, { at: number; bytes: number }>();
    const lost = new Set<number>();
    let receive: ((event: MessageEvent) => void) | null = null;
    Object.defineProperty(worker, 'onmessage', { configurable: true, get: () => receive, set: (handler: typeof receive) => { receive = handler; } });
    worker.addEventListener('message', (event) => {
      const { data } = event;
      const request = sent.get(data.id);
      if (request) {
        sent.delete(data.id);
        if (!data.error) {
          const at = performance.now(); const encoded = JSON.stringify(data.result);
          timings.push({ roundTripMs: at - request.at, requestBytes: request.bytes, replyBytes: Buffer.byteLength(encoded), encodeMs: performance.now() - at });
        }
      }
      if (lost.delete(data.id) && !data.error) {
        worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed human-reset reply lost; outcome unknown', cancelable: true }));
        return;
      }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === 'pairing.humanReset.write') {
        assert.equal(message.lane, 'write'); commandPosts++;
        assert.deepEqual(message.args && Object.keys(message.args).sort(), ['args', 'method']);
        const args = message.args as { method: string; args: [number, string?] };
        assert.equal(args.method, 'reset'); assert(args.args.length === 1 || args.args.length === 2); assert.equal(typeof args.args[0], 'number'); if (args.args.length === 2) { assert.equal(typeof args.args[1], 'string'); commandIds.push(args.args[1]!); }
        if (rejectNextWrite) {
          rejectNextWrite = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic human-reset admission rejected before commit', cancelable: true })));
          return;
        }
        sent.set(message.id, { at: performance.now(), bytes: Buffer.byteLength(JSON.stringify(message.args)) });
        if (loseNextReceipt) { loseNextReceipt = false; lost.add(message.id); }
      }
      if (message.op === 'pairing.humanReset.read') {
        assert.equal(message.lane, 'read'); readPosts++;
        const args = message.args as { method: string; args: [string] };
        assert.equal(args.method, 'receipt'); assert.equal(args.args.length, 1); assert.equal(typeof args.args[0], 'string');
        if (rejectNextRead || performance.now() < receiptReaderUnavailableUntil) { rejectNextRead = false; queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic receipt reader unavailable', cancelable: true }))); return; }
        sent.set(message.id, { at: performance.now(), bytes: Buffer.byteLength(JSON.stringify(message.args)) });
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by pairing fixture'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let lock: InstanceType<typeof SQLite> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const evidence: Record<string, unknown> = {};
type Receipt = { id: string; resetAt: number; conversationId: string; devices: { id: string; name: string }[] };

try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  } finally { JobQueueProcessor.prototype.start = start; }
  assert.notEqual(app.server.port, 8399); await Promise.all([...processors].map((p) => p.stop()));
  const { onDeviceRevoked } = await import('../../../packages/daemon/src/lib/pairing/upgrade-auth.ts');
  const { onHumanDevicesReset } = await import('../../../packages/daemon/src/lib/pairing/human-device-reset.ts');
  const raw=app.db.getDatabase();mainConnection=raw;await waitForSdkBodyCopy(raw);
  const repo=new DevicePairingRepository(raw);
  const inspect=<T>(fn:()=>T):T=>{const previous=measuring;measuring=false;try{return fn();}finally{measuring=previous;}};
  const seed=(kind:'human'|'relay'='human')=>inspect(()=>{const code=repo.createCode(kind,null,true,Date.now());return repo.redeem(code.code,'Synthetic public-reset device',Date.now())!;});
  const active=(id:string)=>inspect(()=>repo.isActiveDevice(id));
  const count=(table:'neo_publications'|'human_device_resets')=>inspect(()=>(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n);
  const events:string[]=[];const revoked:string[]=[];const publications:string[]=[];
  subscriptions.push(onDeviceRevoked(id=>revoked.push(id)),onHumanDevicesReset(id=>publications.push(id)));
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  type Reply={ok:boolean;resetAt:number;devices:{id:string;name:string;revokedAt:number|null}[]};
  const cli=async(...args:string[])=>{
    const child=spawn('bun',[join(root,'packages/cli/main.ts'),...args],{cwd:root,env:{...process.env,HYPERNEO_SESSION_DOOR:join(run,'data/session-door.sock')},stdio:['ignore','pipe','pipe']});
    children.add(child);let output='';let error='';child.stdout!.on('data',chunk=>{output+=String(chunk);});child.stderr!.on('data',chunk=>{error+=String(chunk);});
    const exit=await new Promise<number>((done,fail)=>{child.once('error',fail);child.once('close',code=>{children.delete(child);done(code??-1);});});
    return {exit,error,value:output.trim()?JSON.parse(output) as Reply:null};
  };
  const reset=()=>cli('devices','reset-human');
  const connect=async(credential:string)=>{
    const hub=new MessageHub({defaultSessionId:'global'});const transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app!.server.port}/ws`,autoReconnect:false,createSocket:url=>new WebSocket(url,{headers:{authorization:`Bearer ${credential}`}})});
    let closed=false;transport.onConnectionChange(state=>{if(state==='disconnected')closed=true;});transports.push(transport);hub.registerTransport(transport);await transport.initialize();return {hub,closed:()=>closed};
  };
  const wait=async(predicate:()=>boolean,ms=6000)=>{const deadline=performance.now()+ms;while(!predicate()){assert(performance.now()<deadline,'public reset observation deadline exceeded');await new Promise(done=>setTimeout(done,5));}};
  const humans=Array.from({length:21},()=>seed());const relay=seed('relay');
  const phone=await connect(humans[0].credential);const relayClient=await connect(relay.credential);
  relayClient.hub.onEvent('neo.publications.changed',(payload:{conversationId:string})=>{events.push(payload.conversationId);});
  const oldCode=inspect(()=>repo.createCode('human',null,true,Date.now()));
  const cached=raw.prepare("UPDATE paired_devices SET revoked_at=? WHERE kind='human' AND revoked_at IS NULL");measuring=true;
  assert.throws(()=>cached.run(Date.now()),/human-reset SQL reached main/);assert.throws(()=>raw.prepare('SELECT id FROM neo_conversation').get(),/human-reset SQL reached main/);assert.throws(()=>raw.prepare('SELECT r.id FROM human_device_resets r').get(),/human-reset SQL reached main/);
  assert.equal(mainSqlAttempts,3);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
  let previous=performance.now();let maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
  const refused=await phone.hub.request<{ok:boolean}>('operation.invoke',{name:'device.reset_human',input:{}});assert.equal(refused.ok,false);assert.equal(commandPosts,0);assert.equal(revoked.length,0);evidence.networkResetRefusedWithoutAdmission=true;
  const at=performance.now();const first=await reset();
  if(first.exit!==0){evidence.publicMutationFailure='CLI reset failed while target main SQL was denied';throw new Error(first.error);}
  assert(first.value?.ok);const receipt=first.value;evidence.coldCliMs=performance.now()-at;
  assert.equal(receipt.devices.length,21);assert.equal(commandPosts,1);assert.deepEqual(new Set(receipt.devices.map(d=>d.id)),new Set(humans.map(d=>d.device.id)));
  await wait(()=>events.length===1&&phone.closed());assert.equal(publications.length,1);assert.equal(revoked.length,21);assert.equal(relayClient.closed(),false);
  for(const human of humans)assert.equal(active(human.device.id),false);assert.equal(active(relay.device.id),true);assert.equal(count('human_device_resets'),1);assert.equal(count('neo_publications'),2);
  const list=await cli('devices');assert.equal(list.exit,0);assert.equal(list.value?.devices.length,22);for(const human of humans)assert.equal(list.value?.devices.find(d=>d.id===human.device.id)?.revokedAt,receipt.resetAt);assert.equal(list.value?.devices.find(d=>d.id===relay.device.id)?.revokedAt,null);evidence.realCliRetainsPublicReplyAndHistory=true;
  const page=await relayClient.hub.request<{ok:boolean;items:{fullText:string}[]}>('operation.invoke',{name:'neo.publication.read',input:{conversationId:events[0],after:0,limit:100}});assert(page.ok);const text=JSON.stringify(page.items);for(const human of humans){assert(text.includes(human.device.id));assert(!text.includes(human.credential));}assert(!text.includes(relay.credential));evidence.committedNoticeEventAndPublicReadback=true;
  assert.deepEqual(await repo.redeemAsync(oldCode.code,'Expired synthetic code',Date.now()),{paired:null,awaitingApproval:false});
  const replacementCode=inspect(()=>repo.createCode('human',null,true,Date.now()));const extraCode=inspect(()=>repo.createCode('human',null,true,Date.now()));assert((await repo.redeemAsync(replacementCode.code,'Synthetic replacement',Date.now())).paired);assert.deepEqual(await repo.redeemAsync(extraCode.code,'Synthetic extra',Date.now()),{paired:null,awaitingApproval:true});evidence.oldCodeInvalidationAndSingleRecoveryPreserved=true;
  const heldRemoved=seed();const heldRetained=seed();const heldPhone=await connect(heldRetained.credential);
  raw.exec('CREATE TABLE synthetic_reset_lock(value INTEGER);INSERT INTO synthetic_reset_lock VALUES(0)');lock=new SQLite(app.db.getDbPath());lock.exec('BEGIN IMMEDIATE');lock.prepare('UPDATE synthetic_reset_lock SET value=1').run();lock.prepare('UPDATE paired_devices SET revoked_at=? WHERE id=?').run(Date.now(),heldRemoved.device.id);
  const writesBeforeHold=commandPosts;const notificationsBeforeHold=publications.length;let settled=false;const pending=reset().finally(()=>{settled=true;});await wait(()=>commandPosts>writesBeforeHold);assert.equal(settled,false);assert.equal(publications.length,notificationsBeforeHold);assert.equal(heldPhone.closed(),false);
  const healthAt=performance.now();assert.equal((await relayClient.hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileWriterHeldMs=performance.now()-healthAt;
  lock.exec('COMMIT');lock.close();lock=undefined;const held=await pending;assert.equal(held.exit,0);assert(held.value?.devices.some(d=>d.id===heldRetained.device.id));assert(!held.value?.devices.some(d=>d.id===heldRemoved.device.id));await wait(()=>publications.length===notificationsBeforeHold+1&&heldPhone.closed());evidence.currentHumansSelectedAtWriterCommitWithoutEarlyNotification=true;
  const rollbackHumans=Array.from({length:21},()=>seed());const rollbackCode=inspect(()=>repo.createCode('human',null,true,Date.now()));const rowsBeforeRollback=count('human_device_resets');const noticesBeforeRollback=count('neo_publications');const eventsBeforeRollback=publications.length;const revocationsBeforeRollback=revoked.length;
  raw.exec("CREATE TRIGGER reject_second_notice BEFORE INSERT ON neo_publications WHEN json_extract(NEW.payload_json, '$.fullText') LIKE '%(part 2)%' BEGIN SELECT RAISE(ABORT, 'synthetic second notice failure'); END");
  const failed=await reset();assert.notEqual(failed.exit,0);assert.match(failed.error,/synthetic second notice failure/);for(const human of rollbackHumans)assert.equal(active(human.device.id),true);assert.equal(count('human_device_resets'),rowsBeforeRollback);assert.equal(count('neo_publications'),noticesBeforeRollback);assert.equal(publications.length,eventsBeforeRollback);assert.equal(revoked.length,revocationsBeforeRollback);assert((await repo.redeemAsync(rollbackCode.code,'Synthetic valid after rollback',Date.now())).paired);raw.exec('DROP TRIGGER reject_second_notice');evidence.publicSecondNoticeFailureRollsBackAllState=true;
  const writesBeforeLoss=commandPosts;const notificationsBeforeLoss=publications.length;loseNextReceipt=true;receiptReaderUnavailableUntil=performance.now()+2200;
  const lost=await reset();const lostRequestId=commandIds.at(-1)!;assert.notEqual(lost.exit,0);assert.match(lost.error,/outcome unknown/);assert.equal(commandPosts,writesBeforeLoss+1);assert.equal(publications.length,notificationsBeforeLoss);await new Promise(done=>setTimeout(done,1200));assert.equal(publications.length,notificationsBeforeLoss);
  await wait(()=>publications.length===notificationsBeforeLoss+1);assert.equal(commandPosts,writesBeforeLoss+1);const recoveredConversation=publications.at(-1)!;const recoveredPage=await relayClient.hub.request<{ok:boolean;items:{producerInput?:{messageId:string}}[]}>('operation.invoke',{name:'neo.publication.read',input:{conversationId:recoveredConversation,after:0,limit:100}});assert(recoveredPage.ok);assert(recoveredPage.items.some(p=>p.producerInput?.messageId===lostRequestId));const exactRecovered=await app.db.gateway.call(humanDeviceResetReads,'receipt',lostRequestId);assert.equal(exactRecovered?.conversationId,recoveredConversation);assert.equal(exactRecovered?.devices.length,22);evidence.publicLostReplyRecoversNoticeWithoutResetReplay=true;
  seed();const eventsBeforeRefusal=publications.length;const rowsBeforeRefusal=count('human_device_resets');rejectNextWrite=true;const rejected=await reset();const refusedRequestId=commandIds.at(-1)!;assert.notEqual(rejected.exit,0);assert.match(rejected.error,/before commit/);assert.equal(publications.length,eventsBeforeRefusal);assert.equal(count('human_device_resets'),rowsBeforeRefusal);
  const next=await reset();assert.equal(next.exit,0);await wait(()=>publications.length===eventsBeforeRefusal+1);await new Promise(done=>setTimeout(done,1100));assert.equal(publications.length,eventsBeforeRefusal+1);assert.equal(await app.db.gateway.call(humanDeviceResetReads,'receipt',refusedRequestId),null);evidence.refusedRequestCannotBorrowLaterReceipt=true;
  const beforeEmpty=publications.length;const empty=await Promise.all([reset(),reset()]);assert(empty.every(r=>r.exit===0&&r.value?.devices.length===0));await wait(()=>publications.length===beforeEmpty+2);const emptyRequestIds=commandIds.slice(-2);assert.equal(new Set(emptyRequestIds).size,2);const emptyReceipts=await Promise.all(emptyRequestIds.map(id=>app!.db.gateway.call(humanDeviceResetReads,'receipt',id)));assert(emptyReceipts.every(r=>r?.devices.length===0));assert.deepEqual(emptyReceipts.map(r=>r?.id),emptyRequestIds);evidence.concurrentEmptyPublicResetsRetainDistinctNotices=true;
  await Promise.all(transports.map(t=>t.close()));seed();loseNextReceipt=true;receiptReaderUnavailableUntil=Infinity;const beforeClose=publications.length;
  const closing=await reset();assert.notEqual(closing.exit,0);assert.match(closing.error,/outcome unknown/);await app.db.gateway.close();const readsAtClose=readPosts;const writesAtClose=commandPosts;await new Promise(done=>setTimeout(done,1100));assert.equal(readPosts,readsAtClose);assert.equal(commandPosts,writesAtClose);assert.equal(publications.length,beforeClose);evidence.gatewayCloseStopsPublicRecovery=true;
  assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=statSync(`${app.db.getDbPath()}-wal`).size;evidence.commandPosts=commandPosts;evidence.readPosts=readPosts;evidence.directDeviceNotifications=revoked.length;evidence.publicNoticeEvents=events.length;
} finally {
  await Promise.all([...children].map(child=>new Promise<void>(done=>{child.once('close',()=>done());child.kill();})));for(const off of subscriptions)off();
  measuring = false; if (timer) clearInterval(timer); if (lock) { try { lock.exec('ROLLBACK'); } catch {} lock.close(); }
  try { await Promise.all(transports.map((t) => t.close())); await Promise.all([...processors].map((p) => p.stop())); await app?.cleanup(); }
  finally { SQLite.prototype.prepare = prepare; JobQueueProcessor.prototype.start = start; globalThis.Worker = NativeWorker; globalThis.fetch = nativeFetch; evidence.mainSqlAttempts = mainSqlAttempts; evidence.timings = timings; writeFileSync(join(run, 'evidence/human-reset-activation.json'), JSON.stringify(evidence, null, 2)); }
}
console.log('ok real local CLI human reset runs on DB workers, with committed public events, exact lost-reply recovery and no replay or main target SQL');
