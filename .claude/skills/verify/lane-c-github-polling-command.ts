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
const { listGitHubWatchedRepos } = await import('../../../packages/daemon/src/storage/repositories/github-watched-repos-read.ts');
const { projectGitHubWatchedRepo } = await import('../../../packages/daemon/src/lib/external-events/github/github-watched-projection.ts');
const { DB_OPS } = await import('../../../packages/daemon/src/storage/db-gateway/db-ops.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const name = 'github.space.polling.write', source = 'github', spaceId = 'synthetic-github-polling-command';
const original = { Worker: globalThis.Worker, start: JobQueueProcessor.prototype.start, register: ExternalEventExtensionManager.prototype.register, prepare: Database.prototype.prepare, fetch: globalThis.fetch };
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, transport: InstanceType<typeof WebSocketClientTransport> | undefined, manager: InstanceType<typeof ExternalEventExtensionManager> | undefined, main: InstanceType<typeof Database> | undefined, lock: InstanceType<typeof Database> | undefined;
let measuring = false, mainSqlAttempts = 0, commandPosts = 0, rejectNext = false, loseNext = false;
let timer: ReturnType<typeof setInterval> | undefined;
const metrics: { roundTripMs: number; requestBytes: number; replyBytes: number }[] = [];
const evidence: Record<string, unknown> = { publicMutationActivated: false };
Database.prototype.prepare = function (sql, ...rest) {
  const db = this, statement = Reflect.apply(original.prepare, this, [sql, ...rest]);
  if (!/(?:INSERT INTO|UPDATE)\s+(?:space_github_source_settings|space_github_watched_repos|space_external_event_source_configs)\b/i.test(sql)) return statement;
  return new Proxy(statement, { get(target, key) { const value = Reflect.get(target, key); if (typeof value !== 'function') return value; return (...args: unknown[]) => { if (measuring && db === main && key === 'run') { mainSqlAttempts++; throw new Error('Target GitHub SQL reached main'); } return Reflect.apply(value, target, args); }; } });
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
      if (lost.delete(event.data.id) && !event.data.error) { worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed GitHub Space command reply lost; outcome unknown', cancelable: true })); return; }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === name) {
        commandPosts++; assert.equal(message.lane, 'write');
        const payload = message.args as {spaceId:string;enabled:boolean};assert.deepEqual(Object.keys(payload).sort(),['enabled','spaceId']);assert.equal(typeof payload.spaceId,'string');assert.equal(typeof payload.enabled,'boolean');assert.deepEqual(structuredClone(payload),payload);
        if (rejectNext) { rejectNext = false; queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic GitHub Space command admission rejected', cancelable: true }))); return; }
        sent.set(message.id, { at: performance.now(), bytes: Buffer.byteLength(JSON.stringify(payload)) }); if (loseNext) { loseNext = false; lost.add(message.id); }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by GitHub Space command fixture'); }) as typeof fetch;
try {
  JobQueueProcessor.prototype.start=function(){processors.add(this);return original.start.call(this);};ExternalEventExtensionManager.prototype.register=function(extension){manager=this;return original.register.call(this,extension);};
  try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;}
  assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);assert(manager);
  const at=Date.now();for(const[id,slug]of [[spaceId,'synthetic-github-polling-command'],['synthetic-other-space','synthetic-other-space']]){mkdirSync(join(run,'workspace',slug),{recursive:true});main.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(id,slug,join(run,'workspace',slug),slug,at,at);}
  const store=new ExternalEventExtensionConfigStore(main);await store.setGlobalConfig(source,{source,globallyEnabled:false,capabilities:{rpcConfig:true,polling:false,webhooks:false}});
  const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();assert.deepEqual(await hub.request('externalEvents.extensions.setGlobalEnabled',{source,enabled:true}),{source,globallyEnabled:true});
  for(const repo of ['repo-one','repo-two','repo-disabled'])await hub.request('space.github.watchRepo',{spaceId,owner:'synthetic-owner',repo,enabled:true,pollingEnabled:false,webhookEnabled:false});
  main.prepare('INSERT INTO space_github_source_settings(space_id,enabled,created_at,updated_at,polling_intent,filter_current_user)VALUES(?,0,11,12,0,0)ON CONFLICT(space_id)DO UPDATE SET enabled=0,created_at=11,updated_at=12,polling_intent=0,filter_current_user=0').run(spaceId);
  main.prepare('INSERT INTO space_github_source_settings(space_id,enabled,created_at,updated_at,polling_intent,filter_current_user)VALUES(?,1,21,22,0,1)').run('synthetic-other-space');
  main.prepare('INSERT INTO space_github_watched_repos(id,space_id,owner,repo,enabled,webhook_enabled,polling_enabled,created_at,updated_at)VALUES(?,?,?,?,1,0,1,21,22)').run('synthetic-other-watch','synthetic-other-space','synthetic-other-owner','repo');
  const baseline={spaceId,source,enabled:false,settings:{baseline:true}};await store.setSpaceConfig(spaceId,source,baseline);main.prepare('UPDATE space_external_event_source_configs SET created_at=13,updated_at=14 WHERE space_id=? AND source=?').run(spaceId,source);
  const cursor={lastSeenAt:15,etags:{issues:'synthetic-etag'},checkRunHeadLastSeenAt:{old:3},checkRunHeadPendingLastSeenAt:{old:4},endpointLastSeenAt:{check_runs:5,issues:6},endpointPendingLastSeenAt:{check_runs:7,pulls:8}};
  main.prepare("UPDATE space_github_watched_repos SET webhook_enabled=1,webhook_secret=? WHERE space_id=? AND repo='repo-two'").run('synthetic-webhook-only',spaceId);main.prepare("UPDATE space_github_watched_repos SET enabled=0 WHERE space_id=? AND repo='repo-disabled'").run(spaceId);main.prepare("UPDATE space_github_watched_repos SET poll_cursor=? WHERE space_id=? AND repo='repo-one'").run(JSON.stringify(cursor),spaceId);
  const watched=listGitHubWatchedRepos(main,spaceId);
  const expected=(enabled:boolean)=>({spaceId,source,enabled:false,settings:{pollingIntent:enabled,filterCurrentUser:false,watchedRepos:listGitHubWatchedRepos(main!,spaceId).map(projectGitHubWatchedRepo)}});
  const listed=()=>hub.request<ReturnType<typeof expected>>('space.github.listConfig',{spaceId});
  assert.deepEqual(await listed(),baseline);evidence.publicBaselineReaderConfirmed=true;
  const sourceRow=()=>main!.prepare('SELECT * FROM space_github_source_settings WHERE space_id=?').get(spaceId)!;
  const row=()=>main!.prepare('SELECT * FROM space_external_event_source_configs WHERE space_id=? AND source=?').get(spaceId,source)!;
  const state=()=>({source:main!.prepare('SELECT * FROM space_github_source_settings ORDER BY space_id').all(),watched:main!.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all(),config:main!.prepare('SELECT * FROM space_external_event_source_configs ORDER BY space_id,source').all()});
  const otherBefore={source:main.prepare("SELECT * FROM space_github_source_settings WHERE space_id='synthetic-other-space'").get(),watched:main.prepare("SELECT * FROM space_github_watched_repos WHERE space_id='synthetic-other-space'").all()};
  const op=DB_OPS.get(name)??{name,mode:'write' as const,run(){throw new Error('Native command must never execute on main');}};
  const persist=(enabled=true,key=spaceId)=>app!.db.gateway.run(op,{spaceId:key,enabled} as never) as Promise<{config:ReturnType<typeof expected>}>;
  const guards=[{sql:'INSERT INTO space_github_source_settings(space_id,enabled,created_at,updated_at)VALUES(?,?,?,?)',args:[spaceId,1,41,41]},{sql:'UPDATE space_github_watched_repos SET enabled=?,updated_at=? WHERE space_id=?',args:[1,41,spaceId]},{sql:'INSERT INTO space_external_event_source_configs(space_id,source,enabled,settings_json,created_at,updated_at)VALUES(?,?,?,?,?,?)',args:[spaceId,source,1,'{}',41,41]}];
  const cached=guards.map(g=>main!.prepare(g.sql));measuring=true;for(const[i,g]of guards.entries()){assert.throws(()=>cached[i].run(...g.args as never[]),/Target GitHub SQL reached main/);assert.throws(()=>main!.prepare(g.sql).run(...g.args as never[]),/Target GitHub SQL reached main/);}assert.equal(mainSqlAttempts,6);mainSqlAttempts=0;evidence.mainGuardSelfCheckPassed=true;
  let previous=performance.now(),maxLoopLagMs=0;timer=setInterval(()=>{const now=performance.now();maxLoopLagMs=Math.max(maxLoopLagMs,now-previous-5);previous=now;},5);
  evidence.phase='first_command';console.log('phase: first native GitHub writer command');const firstAt=performance.now();let first;try{first=await persist();}catch(error){evidence.commandFailure=String(error);throw error;}evidence.firstCommandMs=performance.now()-firstAt;
  assert.deepEqual(first,{config:expected(true)});assert.deepEqual(await listed(),first.config);assert.equal(sourceRow().created_at,11);assert.equal(row().created_at,13);assert.equal(sourceRow().updated_at,row().updated_at);assert.equal(row().settings_json,JSON.stringify(first.config.settings));assert.equal(sourceRow().polling_intent,1);assert.equal(sourceRow().filter_current_user,0);const afterFirst=listGitHubWatchedRepos(main,spaceId),normal=afterFirst.find(r=>r.repo==='repo-one')!,hook=afterFirst.find(r=>r.repo==='repo-two')!,inactive=afterFirst.find(r=>r.repo==='repo-disabled')!;assert.equal(normal.pollingEnabled,true);assert.equal(inactive.pollingEnabled,true);assert.equal(inactive.enabled,false);assert.deepEqual(hook,watched.find(r=>r.repo==='repo-two'));assert.deepEqual(normal.pollCursor,{lastSeenAt:15,etags:{issues:'synthetic-etag'},checkRunPollingEnabledAt:normal.pollCursor!.checkRunPollingEnabledAt,endpointLastSeenAt:{issues:6},endpointPendingLastSeenAt:{pulls:8}});assert.equal(typeof normal.pollCursor!.checkRunPollingEnabledAt,'number');assert(!JSON.stringify(first).includes('synthetic-webhook-only'));assert(!JSON.stringify(first).includes('synthetic-etag'));evidence.atomicReceiptVisibleThroughPublicRpc=true;evidence.eligibleFlagsWebhookSkipAndCursorPreserved=true;
  const disabled=await persist(false);assert.deepEqual(disabled,{config:expected(false)});assert.deepEqual(await listed(),disabled.config);assert(listGitHubWatchedRepos(main,spaceId).every(r=>!r.pollingEnabled));assert.equal(sourceRow().created_at,11);assert.equal(row().created_at,13);assert.equal(sourceRow().updated_at,row().updated_at);evidence.creationAndPostLoopSharedTimesPreserved=true;
  assert.deepEqual({source:main.prepare("SELECT * FROM space_github_source_settings WHERE space_id='synthetic-other-space'").get(),watched:main.prepare("SELECT * FROM space_github_watched_repos WHERE space_id='synthetic-other-space'").all()},otherBefore);evidence.otherSpaceAndConstructorBackfillUntouched=true;
  evidence.phase='rollback';const beforeFailure=state();main.exec("CREATE TRIGGER reject_synthetic_github_snapshot AFTER UPDATE ON space_external_event_source_configs WHEN NEW.space_id='synthetic-github-polling-command' BEGIN SELECT RAISE(ABORT,'synthetic snapshot rollback');END");await assert.rejects(persist(true),/synthetic snapshot rollback/);assert.deepEqual(state(),beforeFailure);main.exec('DROP TRIGGER reject_synthetic_github_snapshot');evidence.snapshotFailureRollsBackFlagsIntentAndConfig=true;
  main.exec("CREATE TRIGGER reject_synthetic_cursor BEFORE UPDATE OF poll_cursor ON space_github_watched_repos WHEN NEW.repo='repo-one' BEGIN SELECT RAISE(ABORT,'synthetic cursor rollback');END");await assert.rejects(persist(true),/synthetic cursor rollback/);assert.deepEqual(state(),beforeFailure);main.exec('DROP TRIGGER reject_synthetic_cursor');evidence.cursorWriteFailureRollsBackEarlierFlagWrite=true;
  measuring=false;main.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run('{broken',normal.id);measuring=true;const beforeCursorFailure=state();await assert.rejects(persist(true),/JSON|Unexpected|Expected/i);assert.deepEqual(state(),beforeCursorFailure);measuring=false;main.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(JSON.stringify(cursor),normal.id);measuring=true;evidence.malformedCursorLeavesNoPartialState=true;
  const beforeOrphan=state();await assert.rejects(persist(true,'synthetic-missing'),/FOREIGN KEY/i);assert.deepEqual(state(),beforeOrphan);await assert.rejects(persist(true,' synthetic-invalid'),/Space id must be non-empty/);assert.deepEqual(state(),beforeOrphan);evidence.orphanAndInvalidIdLeaveNoPartialState=true;
  evidence.phase='held_writer';console.log('phase: held writer and public reader responsiveness');main.exec('CREATE TABLE synthetic_github_lock(value INTEGER);INSERT INTO synthetic_github_lock VALUES(0)');lock=new Database(app.db.getDbPath());lock.exec('BEGIN IMMEDIATE');lock.prepare('UPDATE synthetic_github_lock SET value=1').run();const beforeHeld=commandPosts;let settled=false;const heldAt=performance.now();const pending=persist(true).finally(()=>{settled=true;});const deadline=performance.now()+4000;while(commandPosts===beforeHeld){assert(performance.now()<deadline);await new Promise(done=>setTimeout(done,5));}assert.equal(settled,false);assert.deepEqual(await listed(),disabled.config);const healthAt=performance.now();assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.healthWhileWriterHeldMs=performance.now()-healthAt;await new Promise(done=>setTimeout(done,1200));assert.equal(settled,false);lock.exec('COMMIT');lock.close();lock=undefined;assert.deepEqual(await pending,{config:expected(true)});assert.deepEqual(await listed(),expected(true));assert.equal(sourceRow().updated_at,row().updated_at);evidence.deliberatelyHeldWriterMs=performance.now()-heldAt;evidence.ackWaitsForAtomicCommit=true;
  evidence.phase='failure_fences';const beforeRefused=commandPosts,beforeAdmission=state();rejectNext=true;await assert.rejects(persist(false),/admission rejected/);assert.deepEqual(state(),beforeAdmission);assert.equal(commandPosts,beforeRefused+1);evidence.admissionFailureDoesNotWriteOrReplay=true;
  const beforeLoss=commandPosts;loseNext=true;await assert.rejects(persist(false),/outcome unknown/);assert.deepEqual(await listed(),expected(false));assert.equal(sourceRow().updated_at,row().updated_at);await new Promise(done=>setTimeout(done,100));assert.equal(commandPosts,beforeLoss+1);evidence.actualCommittedReplyLossDoesNotReplay=true;
  assert(listGitHubWatchedRepos(main,spaceId).every(r=>!r.pollingEnabled));evidence.finalFlagsIntentAndSnapshotConverged=true;assert.equal(mainSqlAttempts,0);assert(maxLoopLagMs<1000);evidence.maxLoopLagMs=maxLoopLagMs;evidence.commandPosts=commandPosts;evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0;evidence.phase='complete';evidence.pass=true;
}finally{measuring=false;if(timer)clearInterval(timer);if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;Database.prototype.prepare=original.prepare;globalThis.Worker=original.Worker;globalThis.fetch=original.fetch;evidence.mainSqlAttempts=mainSqlAttempts;evidence.metrics=metrics;writeFileSync(join(run,'evidence/github-polling-command.json'),JSON.stringify(evidence,null,2));}}
console.log('ok native polling writer atomically commits flags, intent and public snapshot with rollback, held-writer responsiveness and no main target SQL or unknown-outcome replay; public mutation wiring separate');
