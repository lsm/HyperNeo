import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createWatchedTable, insertWatchedRow, mappedWatchedRow } from '../../../packages/daemon/tests/unit/helpers/github-watched-read-fixture.ts';
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
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { ExternalEventExtensionManager } = await import('../../../packages/daemon/src/lib/external-events/extension-manager.ts');
const { ExternalEventExtensionConfigStore } = await import('../../../packages/daemon/src/lib/external-events/extension-config-store.ts');
const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const original = { start: JobQueueProcessor.prototype.start, register: ExternalEventExtensionManager.prototype.register, prepare: Database.prototype.prepare, fetch: globalThis.fetch };
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let manager: InstanceType<typeof ExternalEventExtensionManager> | undefined;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
let main: InstanceType<typeof Database> | undefined;
let scratch: InstanceType<typeof Database> | undefined;
let measuring = false;
const bindings: unknown[][] = [];
const evidence: Record<string, unknown> = { mainThreadMovementClaim: false, boundary: 'Verbatim existing-row UPDATE extraction; fresh envelope 199, excluded audited stable data modules 102, total known 301. Public writes remain main-side; full public/shared-barrel/runtime closure unclaimed' };
const source = 'github', spaceId = 'synthetic-watched-update';

globalThis.fetch = (() => { throw new Error('External HTTP refused by extension extraction fixture'); }) as typeof fetch;
try{
  JobQueueProcessor.prototype.start=function(){processors.add(this);return original.start.call(this);};ExternalEventExtensionManager.prototype.register=function(extension){manager=this;if(extension.sourceId==='github'){const options=(extension as unknown as {options:{getPollIntervalMs?:()=>number;autoReconcileWebhooks?:boolean}}).options;options.getPollIntervalMs=()=>60_000;options.autoReconcileWebhooks=false;}return original.register.call(this,extension);};
  try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;}
  assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);assert(manager);
  const at=Date.now();for(const id of [spaceId,'synthetic-watched-update-peer'])main.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(id,id,join(run,'workspace',id),'Synthetic watched UPDATE',at,at);
  const store=new ExternalEventExtensionConfigStore(main);await store.setGlobalConfig(source,{source,globallyEnabled:false,capabilities:{rpcConfig:true,polling:false,webhooks:false}});
  const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();await hub.request('externalEvents.extensions.setGlobalEnabled',{source,enabled:true});
  const targetId='synthetic-update-target',peerId='synthetic-update-peer';for(const [id,space]of [[targetId,spaceId],[peerId,'synthetic-watched-update-peer']]as const)insertWatchedRow(main,{id,space_id:space,enabled:1,polling_enabled:0,webhook_enabled:0,webhook_secret:null,webhook_auto_registered:0});const updates:{args:unknown[];row:Record<string,unknown>}[]=[];
  Database.prototype.prepare=function(sql,...rest){const db=this,statement=Reflect.apply(original.prepare,this,[sql,...rest]);if(!sql.includes('webhook_secret = COALESCE'))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{const result=Reflect.apply(value,target,args);if(measuring&&db===main&&key==='run'){const row=Reflect.apply(original.prepare,db,['SELECT * FROM space_github_watched_repos WHERE id=?']).get(String(args[12]))!;updates.push({args,row:{...row}});}return result;};}});};
  measuring=true;const started=performance.now();const peerBefore={...main.prepare('SELECT * FROM space_github_watched_repos WHERE id=?').get(peerId)!};
  for(const [id,space,enabled,polling]of [[targetId,spaceId,false,false],[targetId,spaceId,true,true],[peerId,'synthetic-watched-update-peer',false,false]]as const){const reply=await hub.request<{watchedRepo:{id:string;owner:string;repo:string;createdAt:number;enabled:boolean;webhookEnabled:boolean;pollingEnabled:boolean;webhookSecret:unknown}}>('space.github.watchRepo',{spaceId:space,owner:'ownerz',repo:'REPO-Z',enabled,pollingEnabled:polling,webhookEnabled:false});const w=reply.watchedRepo;assert.equal(w.id,id);assert.equal(w.owner,'OwnerZ');assert.equal(w.repo,'repo-z');assert.equal(w.createdAt,17);assert.equal(w.enabled,enabled);assert.equal(w.pollingEnabled,polling);assert.equal(w.webhookEnabled,false);assert.equal(w.webhookSecret,null);const last=updates.at(-1)!;assert.equal(last.args[12],id);assert.equal(last.row.updated_at,last.args[11]);assert.equal(last.row.enabled,enabled?1:0);assert.equal(last.row.polling_enabled,polling?1:0);assert.equal(last.row.created_at,17);assert.equal(last.row.last_poll_at,14);const config=await hub.request<{settings:{watchedRepos:{id:string;enabled:boolean;pollingEnabled:boolean}[]}}>('space.github.listConfig',{spaceId:space});assert.equal(config.settings.watchedRepos.length,1);assert.equal(config.settings.watchedRepos[0].id,id);assert.equal(config.settings.watchedRepos[0].enabled,enabled);assert.equal(config.settings.watchedRepos[0].pollingEnabled,polling);if(id===targetId)assert.deepEqual({...main.prepare('SELECT * FROM space_github_watched_repos WHERE id=?').get(peerId)!},peerBefore);}
  assert.equal(updates.length,3);const activated=main.prepare('SELECT * FROM space_github_watched_repos WHERE id=?').get(targetId)!;const cursor=JSON.parse(String(activated.poll_cursor));assert.equal(cursor.lastSeenAt,15);assert.equal(cursor.etags.issues,'synthetic-etag');assert.equal(typeof cursor.checkRunPollingEnabledAt,'number');assert(cursor.checkRunPollingEnabledAt>0);evidence.publicRpcMs=performance.now()-started;evidence.publicRpc={mainUpdates:updates.length,existingUpdatesObserved:true,identityTimeAndCursorPolicyPreserved:true,peerIsolationAndSavedConfigPreserved:true};measuring=false;
  const helper=new URL('../../../packages/daemon/src/storage/repositories/github-watched-update-persist.ts',import.meta.url);assert(existsSync(helper),'Constructor-free GitHub watched UPDATE is unavailable');const {persistGitHubWatchedRepoUpdate}=await import(helper.href);
  scratch=new Database(':memory:');createWatchedTable(scratch);insertWatchedRow(scratch);const before={...scratch.prepare('SELECT * FROM space_github_watched_repos').get()!};const params={spaceId:'synthetic-space',owner:'ownerz',repo:'REPO-Z',enabled:false,pollingEnabled:false};assert.equal(persistGitHubWatchedRepoUpdate(scratch,params,mappedWatchedRow,41),undefined);const saved={...scratch.prepare('SELECT * FROM space_github_watched_repos').get()!};assert.deepEqual(saved,{...before,enabled:0,polling_enabled:0,updated_at:41});assert.equal(scratch.prepare("SELECT name FROM sqlite_master WHERE name='space_github_source_settings'").get(),null);assert.throws(()=>scratch!.transaction(()=>{persistGitHubWatchedRepoUpdate(scratch!,{...params,enabled:true},mappedWatchedRow,99);throw new Error('synthetic rollback');})(),/synthetic rollback/);assert.deepEqual({...scratch.prepare('SELECT * FROM space_github_watched_repos').get()!},saved);scratch.exec("CREATE TRIGGER reject_update AFTER UPDATE ON space_github_watched_repos BEGIN SELECT RAISE(ABORT,'synthetic UPDATE rejected');END");assert.throws(()=>persistGitHubWatchedRepoUpdate(scratch!,params,mappedWatchedRow,99),/synthetic UPDATE rejected/);assert.deepEqual({...scratch.prepare('SELECT * FROM space_github_watched_repos').get()!},saved);evidence.constructorFreeSuppliedTimeFailureAndRollbackPreserved=true;
  assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.pass=true;
}finally{measuring=false;scratch?.close();try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;Database.prototype.prepare=original.prepare;globalThis.fetch=original.fetch;writeFileSync(join(run,'evidence/github-watched-update-extract.json'),JSON.stringify(evidence,null,2));}}
console.log('ok real watched RPC preserves existing-row UPDATE, cursor policy and saved config; constructor-free UPDATE retains supplied time, failure and rollback');
