import '../../../packages/daemon/tests/unit/helpers/register-space-schema.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home')); assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { ExternalEventExtensionManager } = await import('../../../packages/daemon/src/lib/external-events/extension-manager.ts');
const { ExternalEventExtensionConfigStore } = await import('../../../packages/daemon/src/lib/external-events/extension-config-store.ts');
const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { GitHubEventExtension } = await import('../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts');
const { insertWatchedRow } = await import('../../../packages/daemon/tests/unit/helpers/github-watched-read-fixture.ts');
const { DB_OPS } = await import('../../../packages/daemon/src/storage/db-gateway/db-ops.ts');
const { spaceDaemonModule } = await import('../../../packages/space/src/daemon-module.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const name = 'extension.space.config.write', source = 'github', spaceId = 'synthetic-space-activation';
const notices: string[] = [], capturedTimes: number[] = [];
const pending = new Set<Promise<unknown>>();
const original = { Worker: globalThis.Worker, start: JobQueueProcessor.prototype.start, register: ExternalEventExtensionManager.prototype.register, registerRpc: GitHubEventExtension.prototype.registerRpcHandlers, prepare: Database.prototype.prepare, fetch: globalThis.fetch, createLogEvidenceService: spaceDaemonModule.createLogEvidenceService };
let logEvidence: ReturnType<typeof spaceDaemonModule.createLogEvidenceService> | undefined;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, transport: InstanceType<typeof WebSocketClientTransport> | undefined, manager: InstanceType<typeof ExternalEventExtensionManager> | undefined, main: InstanceType<typeof Database> | undefined, lock: InstanceType<typeof Database> | undefined;
let measuring = false, mainSqlAttempts = 0, commandPosts = 0, rejectNext = false, loseNext = false, holdNext = false;
let timer: ReturnType<typeof setInterval> | undefined;
const metrics: { roundTripMs: number; requestBytes: number; replyBytes: number }[] = [];
const evidence: Record<string, unknown> = { publicSpaceSetterActivated: true };
Database.prototype.prepare = function (sql, ...rest) {
  const db = this, statement = Reflect.apply(original.prepare, this, [sql, ...rest]);
  if (!/INSERT INTO space_external_event_source_configs/i.test(sql)) return statement;
  return new Proxy(statement, { get(target, key) { const value = Reflect.get(target, key); if (typeof value !== 'function') return value; return (...args: unknown[]) => { if (measuring && db === main && key === 'run') { mainSqlAttempts++; throw new Error('Space config UPSERT reached main'); } return Reflect.apply(value, target, args); }; } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new original.Worker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker), sent = new Map<number, { at: number; bytes: number }>(), lost = new Set<number>();
    let receive: ((event: MessageEvent) => void) | null = null;
    Object.defineProperty(worker, 'onmessage', { configurable: true, get: () => receive, set: (handler: typeof receive) => { receive = handler; } });
    worker.addEventListener('message', event => {
      const request = sent.get(event.data.id);
      if (request) { sent.delete(event.data.id); if (!event.data.error) metrics.push({ roundTripMs: performance.now() - request.at, requestBytes: request.bytes, replyBytes: Buffer.byteLength(JSON.stringify(event.data)) }); }
      if (lost.delete(event.data.id) && !event.data.error) { worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed Space config reply lost; outcome unknown', cancelable: true })); return; }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === name && (message.args as {args?:unknown[]})?.args?.[1] === source) {
        commandPosts++; assert.equal(message.lane, 'write');
        const payload = message.args as { method: string; args: unknown[] };
        assert.equal(payload.method, 'persist'); assert.equal(payload.args.length, 4); assert.equal(typeof payload.args[0], 'string'); assert.equal(typeof payload.args[3], 'number'); assert.deepEqual(structuredClone(payload), payload); capturedTimes.push(payload.args[3] as number);
        if (holdNext) { holdNext=false; lock=new Database(app!.db.getDbPath()); lock.exec('BEGIN IMMEDIATE'); lock.prepare('UPDATE synthetic_space_lock SET value=1').run(); }
        if (rejectNext) { rejectNext = false; queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic Space config admission rejected', cancelable: true }))); return; }
        sent.set(message.id, { at: performance.now(), bytes: Buffer.byteLength(JSON.stringify(payload)) }); if (loseNext) { loseNext = false; lost.add(message.id); }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by Space command fixture'); }) as typeof fetch;
GitHubEventExtension.prototype.registerRpcHandlers = function(hub,ctx) {
  return original.registerRpc.call(this,hub,{...ctx,onSourceConfigChanged(change){if(measuring&&change.source===source&&change.spaceId===spaceId)notices.push(change.kind);ctx.onSourceConfigChanged(change);}});
};
try {
  JobQueueProcessor.prototype.start=function(){processors.add(this);return original.start.call(this);};
  spaceDaemonModule.createLogEvidenceService=(db)=>{logEvidence=original.createLogEvidenceService(db);return logEvidence;};
  ExternalEventExtensionManager.prototype.register=function(extension){manager=this;if(extension.sourceId==='github'){const options=(extension as unknown as {options:{getPollIntervalMs?:()=>number;autoReconcileWebhooks?:boolean}}).options;options.getPollIntervalMs=()=>0;options.autoReconcileWebhooks=false;}return original.register.call(this,extension);};
  try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;spaceDaemonModule.createLogEvidenceService=original.createLogEvidenceService;}
  assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);assert(manager);
  const at=Date.now();main.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(spaceId,spaceId,join(run,'workspace'),'Synthetic activation',at,at);
  const store=new ExternalEventExtensionConfigStore(main);await store.setGlobalConfig(source,{source,globallyEnabled:false,capabilities:{rpcConfig:true,polling:false,webhooks:false}});
  const seed=()=>insertWatchedRow(main!,{space_id:spaceId,polling_enabled:0,webhook_enabled:0,webhook_auto_registered:0,webhook_remote_id:null,webhook_secret:null,webhook_url:null});seed();
  const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false,createSocket:url=>createLocalSocket(url,join(run,'data/local-rpc.credential'))});hub.registerTransport(transport);await transport.initialize();await hub.request('externalEvents.extensions.setGlobalEnabled',{source,enabled:true});await hub.request('space.github.enable',{spaceId});
  const op=DB_OPS.get(name);assert(op&&op.mode==='write');
  const listed=()=>hub.request<{spaceId:string;source:string;enabled:boolean;settings:{pollingIntent:boolean;filterCurrentUser:boolean;watchedRepos:unknown[]}}>('space.github.listConfig',{spaceId});
  const row=()=>{const raw=main!.prepare('SELECT * FROM space_external_event_source_configs WHERE space_id=? AND source=?').get(spaceId,source)!;return {...raw};};
  const remaining=()=>main!.prepare('SELECT COUNT(*) AS n FROM space_github_watched_repos WHERE space_id=?').get(spaceId)!.n;
  const unwatch=(id=spaceId)=>{const p=hub.request('space.github.unwatchRepo',{spaceId:id,owner:'OwnerZ',repo:'repo-z'});pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
  const initial=row();assert.equal((await listed()).settings.watchedRepos.length,1);main.exec('CREATE TABLE synthetic_space_lock(value INTEGER);INSERT INTO synthetic_space_lock VALUES(0)');
  const cached=main.prepare('INSERT INTO space_external_event_source_configs(space_id,source,enabled,settings_json,created_at,updated_at)VALUES(?,?,0,?,0,0)');measuring=true;assert.throws(()=>cached.run(spaceId,source,'{}'),/UPSERT reached main/);assert.throws(()=>main!.prepare('INSERT INTO space_external_event_source_configs(space_id,source,enabled,settings_json,created_at,updated_at)VALUES(?,?,0,?,0,0)').run(spaceId,source,'{}'),/UPSERT reached main/);assert.equal(mainSqlAttempts,2);mainSqlAttempts=0;commandPosts=0;capturedTimes.length=0;metrics.length=0;evidence.mainGuardSelfCheckPassed=true;
  let previous=performance.now(),maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
  evidence.phase='public_unwatch';const first=performance.now();assert.deepEqual(await unwatch(),{removed:true});evidence.firstRpcMs=performance.now()-first;assert.equal(commandPosts,1);assert.equal(row().created_at,initial.created_at);assert.equal(row().updated_at,capturedTimes.at(-1));assert.equal(row().settings_json,'{"pollingIntent":false,"filterCurrentUser":true,"watchedRepos":[]}');assert.deepEqual(await listed(),{spaceId,source,enabled:true,settings:{pollingIntent:false,filterCurrentUser:true,watchedRepos:[]}});assert.deepEqual(notices,['watched_repo_removed']);evidence.publicCommitBeforeNotificationAndReply=true;
  evidence.phase='rollback';seed();const beforeRollback=row(),beforeNotices=notices.length;main.exec("CREATE TRIGGER reject_synthetic_space_update AFTER UPDATE ON space_external_event_source_configs WHEN NEW.space_id='synthetic-space-activation' BEGIN SELECT RAISE(ABORT,'synthetic rollback');END");await assert.rejects(unwatch(),/synthetic rollback/);assert.deepEqual(row(),beforeRollback);assert.equal(remaining(),0);assert.equal(notices.length,beforeNotices);main.exec('DROP TRIGGER reject_synthetic_space_update');evidence.rollbackDoesNotUndoAlreadyCommittedUpstreamRemoval=true;
  evidence.phase='foreign_key';await assert.rejects(unwatch('synthetic-missing-space'),/FOREIGN KEY/i);assert.equal(main.prepare("SELECT COUNT(*) AS n FROM space_external_event_source_configs WHERE space_id='synthetic-missing-space'").get()!.n,0);evidence.foreignKeyPreserved=true;
  assert(logEvidence);await logEvidence.flushAsync();evidence.startupLogEvidenceDrained=true;evidence.phase='held_writer';seed();const beforeHeld=row(),beforeHeldNotices=notices.length,beforeHeldPosts=commandPosts;holdNext=true;let settled=false;const heldAt=performance.now();const held=unwatch().finally(()=>{settled=true;});const deadline=performance.now()+4000;while(commandPosts===beforeHeldPosts){assert(performance.now()<deadline);await new Promise(done=>setTimeout(done,5));}assert(lock);assert.equal(settled,false);assert.deepEqual(row(),beforeHeld);assert.equal((await listed()).settings.watchedRepos.length,0);assert.equal(notices.length,beforeHeldNotices);assert.equal(remaining(),0);const submitted=capturedTimes.at(-1)!;const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileWriterHeldMs=performance.now()-healthAt;await new Promise(done=>setTimeout(done,1200));assert.equal(settled,false);lock.exec('COMMIT');lock.close();lock=undefined;assert.deepEqual(await held,{removed:true});assert.equal(row().created_at,initial.created_at);assert.equal(row().updated_at,submitted);assert.equal(notices.length,beforeHeldNotices+1);evidence.deliberatelyHeldWriterMs=performance.now()-heldAt;evidence.preAdmissionClockAndCommitFencePreserved=true;
  evidence.phase='admission_refused';seed();const beforeRefusal=row(),refusedPosts=commandPosts,refusedNotices=notices.length;rejectNext=true;await assert.rejects(unwatch(),/admission rejected/);assert.deepEqual(row(),beforeRefusal);assert.equal(remaining(),0);await new Promise(done=>setTimeout(done,60));assert.equal(commandPosts,refusedPosts+1);assert.equal(notices.length,refusedNotices);evidence.refusalHasNoFallbackNotificationOrReplay=true;
  evidence.phase='lost_committed_reply';seed();const lossPosts=commandPosts,lossNotices=notices.length;loseNext=true;await assert.rejects(unwatch(),/outcome unknown/);assert.equal(row().updated_at,capturedTimes.at(-1));assert.equal((await listed()).settings.watchedRepos.length,0);assert.equal(remaining(),0);await new Promise(done=>setTimeout(done,100));await listed();assert.equal(commandPosts,lossPosts+1);assert.equal(notices.length,lossNotices);evidence.actualCommittedReplyLossHasNoReplayOrNotification=true;
  assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.commandPosts=commandPosts;evidence.notifications=notices;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.pass=true;
}finally{measuring=false;holdNext=false;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}await Promise.allSettled([...pending]);try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;GitHubEventExtension.prototype.registerRpcHandlers=original.registerRpc;Database.prototype.prepare=original.prepare;globalThis.Worker=original.Worker;globalThis.fetch=original.fetch;evidence.mainSqlAttempts=mainSqlAttempts;evidence.metrics=metrics;writeFileSync(join(run,'evidence/extension-space-activation.json'),JSON.stringify(evidence,null,2));}}
console.log('ok public unwatch awaits Space config writer; JSON/time/FK/rollback and no replay preserved; upstream removal remains separate');
