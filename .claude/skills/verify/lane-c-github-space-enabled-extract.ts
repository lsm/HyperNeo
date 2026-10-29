import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
const evidence: Record<string, unknown> = { mainThreadMovementClaim: false, boundary: 'Verbatim GitHub source setting/watched enable SQL extraction only; public writes stay on main, constructor/backfill untouched' };
const source = 'github', spaceId = 'synthetic-source-enabled';

globalThis.fetch = (() => { throw new Error('External HTTP refused by extension extraction fixture'); }) as typeof fetch;
try{
  JobQueueProcessor.prototype.start=function(){processors.add(this);return original.start.call(this);};ExternalEventExtensionManager.prototype.register=function(extension){manager=this;return original.register.call(this,extension);};
  try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;}
  assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);assert(manager);
  const now=Date.now();main.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(spaceId,'synthetic-source-enabled',join(run,'workspace'),'Synthetic source',now,now);
  const store=new ExternalEventExtensionConfigStore(main);await store.setGlobalConfig(source,{source,globallyEnabled:false,capabilities:{rpcConfig:true,polling:false,webhooks:false}});
  const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();assert.deepEqual(await hub.request('externalEvents.extensions.setGlobalEnabled',{source,enabled:true}),{source,globallyEnabled:true});
  for(const repo of ['repo-one','repo-two'])await hub.request('space.github.watchRepo',{spaceId,owner:'synthetic-owner',repo,enabled:false,pollingEnabled:false,webhookEnabled:false});
  const created=new Map((main.prepare('SELECT id,created_at FROM space_github_watched_repos WHERE space_id=?').all(spaceId) as {id:string;created_at:number}[]).map(row=>[row.id,row.created_at]));
  Database.prototype.prepare=function(sql,...rest){const db=this,statement=Reflect.apply(original.prepare,this,[sql,...rest]);if(!/INSERT INTO space_github_source_settings|UPDATE space_github_watched_repos SET enabled/i.test(sql))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(measuring&&db===main&&key==='run')bindings.push(args);return Reflect.apply(value,target,args);};}});};
  measuring=true;let sourceCreated:unknown;const replies=[];const at=performance.now();
  for(const enabled of [true,false]){const reply=await hub.request(`space.github.${enabled?'enable':'disable'}`,{spaceId});assert.deepEqual(reply,{spaceId,source,enabled});const listed=await hub.request<{repositories:{id:string;enabled:boolean;createdAt:number;updatedAt:number;pollingEnabled:boolean;webhookEnabled:boolean}[]}>('space.github.listWatchedRepos',{spaceId});assert.equal(listed.repositories.length,2);const row=main.prepare('SELECT * FROM space_github_source_settings WHERE space_id=?').get(spaceId)!;sourceCreated??=row.created_at;assert.equal(row.created_at,sourceCreated);assert.equal(row.enabled,enabled?1:0);for(const repo of listed.repositories){assert.equal(repo.enabled,enabled);assert.equal(repo.createdAt,created.get(repo.id));assert.equal(repo.updatedAt,row.updated_at);assert.equal(repo.pollingEnabled,false);assert.equal(repo.webhookEnabled,false);}const config=await hub.request<{spaceId:string;source:string;enabled:boolean;settings:{pollingIntent:boolean;filterCurrentUser:boolean;watchedRepos:{id:string;enabled:boolean;updatedAt:number}[]}}>('space.github.listConfig',{spaceId});assert.equal(config.enabled,enabled);assert.equal(config.settings.watchedRepos.length,2);assert.equal(config.settings.pollingIntent,false);assert.equal(config.settings.filterCurrentUser,true);for(const watched of config.settings.watchedRepos){assert.equal(watched.enabled,enabled);assert.equal(watched.updatedAt,row.updated_at);}replies.push(reply);}
  evidence.publicRpcMs=performance.now()-at;assert.equal(bindings.length,4);for(const[i,enabled]of [true,false].entries()){assert.deepEqual(bindings[i*2].slice(0,2),[spaceId,enabled?1:0]);assert.equal(bindings[i*2][2],bindings[i*2][3]);assert.deepEqual(bindings[i*2+1],[enabled?1:0,bindings[i*2][2],spaceId]);}evidence.publicRpc={replies,mainStatementRuns:bindings.length,watchedRows:2,sourceWatchedAndSnapshotStayAligned:true,creationAndSharedCommandTimesPreserved:true};measuring=false;
  const helper=new URL('../../../packages/daemon/src/storage/repositories/github-space-enabled-persist.ts',import.meta.url);assert(existsSync(helper),'GitHub Space enabled SQL helper is unavailable');const{persistGitHubSpaceEnabled}=await import(helper.href);
  scratch=new Database(':memory:');scratch.exec("CREATE TABLE space_github_source_settings(space_id TEXT PRIMARY KEY,enabled INTEGER,created_at INTEGER,updated_at INTEGER);CREATE TABLE space_github_watched_repos(id TEXT PRIMARY KEY,space_id TEXT,enabled INTEGER,updated_at INTEGER);INSERT INTO space_github_watched_repos VALUES('synthetic-watched','synthetic-source-enabled',0,5)");assert.equal(persistGitHubSpaceEnabled(scratch,spaceId,true,41),1);const first={...scratch.prepare('SELECT * FROM space_github_source_settings').get()!};assert.deepEqual(first,{space_id:spaceId,enabled:1,created_at:41,updated_at:41});assert.throws(()=>scratch!.transaction(()=>{persistGitHubSpaceEnabled(scratch!,spaceId,false,99);throw new Error('synthetic rollback');})(),/synthetic rollback/);assert.deepEqual({...scratch.prepare('SELECT * FROM space_github_source_settings').get()!},first);assert.deepEqual({...scratch.prepare('SELECT * FROM space_github_watched_repos').get()!},{id:'synthetic-watched',space_id:spaceId,enabled:1,updated_at:41});evidence.suppliedTimeResultAndCallerRollbackPreserved=true;
  assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.pass=true;
}finally{measuring=false;scratch?.close();try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;Database.prototype.prepare=original.prepare;globalThis.fetch=original.fetch;writeFileSync(join(run,'evidence/github-space-enabled-extract.json'),JSON.stringify(evidence,null,2));}}
console.log('ok actual GitHub Space enable/disable/list RPC keeps source/watched/snapshot flags, counts, creation/shared time and caller rollback; SQL extraction only');
