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
const evidence: Record<string, unknown> = { mainThreadMovementClaim: false, boundary: 'Verbatim filter UPSERT extraction only; Current public filter routes the atomic writer; legacy helper contracts and constructor/backfill stay unchanged' };
const source = 'github', spaceId = 'synthetic-filter';

globalThis.fetch = (() => { throw new Error('External HTTP refused by extension extraction fixture'); }) as typeof fetch;
try{
  JobQueueProcessor.prototype.start=function(){processors.add(this);return original.start.call(this);};ExternalEventExtensionManager.prototype.register=function(extension){manager=this;return original.register.call(this,extension);};
  try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;}
  assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);assert(manager);
  const at=Date.now();for(const id of [spaceId,'synthetic-filter-empty'])main.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(id,id,join(run,'workspace',id),'Synthetic filter',at,at);
  const store=new ExternalEventExtensionConfigStore(main);await store.setGlobalConfig(source,{source,globallyEnabled:false,capabilities:{rpcConfig:true,polling:false,webhooks:false}});
  const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();await hub.request('externalEvents.extensions.setGlobalEnabled',{source,enabled:true});
  main.prepare('INSERT INTO space_github_source_settings(space_id,enabled,polling_intent,filter_current_user,created_at,updated_at)VALUES(?,0,1,1,11,12)').run(spaceId);
  Database.prototype.prepare=function(sql,...rest){const db=this,statement=Reflect.apply(original.prepare,this,[sql,...rest]);if(!/INSERT INTO space_github_source_settings/.test(sql)||!sql.includes('filter_current_user'))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(measuring&&db===main&&key==='run')bindings.push(args);return Reflect.apply(value,target,args);};}});};
  measuring=true;const replies=[];const started=performance.now();
  for(const [id,enabled]of [[spaceId,false],[spaceId,true],['synthetic-filter-empty',false]]as const){const before=bindings.length;const reply=await hub.request('space.github.setFilterCurrentUser',{spaceId:id,enabled});assert.deepEqual(reply,{spaceId:id,filterCurrentUser:enabled});assert.equal(bindings.length,before);const row=main.prepare('SELECT * FROM space_github_source_settings WHERE space_id=?').get(id)!;const updated=row.updated_at;assert.equal(typeof updated,'number');assert.equal(row.enabled,id===spaceId?0:1);assert.equal(row.polling_intent,id===spaceId?1:0);assert.equal(row.filter_current_user,enabled?1:0);assert.equal(row.created_at,id===spaceId?11:updated);assert.equal(main.prepare('SELECT updated_at FROM space_external_event_source_configs WHERE space_id=? AND source=?').get(id,source)!.updated_at,updated);const config=await hub.request<{spaceId:string;source:string;enabled:boolean;settings:{filterCurrentUser:boolean;pollingIntent:boolean;watchedRepos:unknown[]}}>('space.github.listConfig',{spaceId:id});assert.equal(config.enabled,id!==spaceId);assert.equal(config.settings.filterCurrentUser,enabled);assert.equal(config.settings.pollingIntent,id===spaceId);assert.deepEqual(config.settings.watchedRepos,[]);replies.push(reply);}
  evidence.publicRpcMs=performance.now()-started;evidence.publicRpc={replies,mainStatementRuns:bindings.length,snapshotAndCreationTimesPreserved:true,enabledAndPollingIntentPreserved:true};measuring=false;
  const helper=new URL('../../../packages/daemon/src/storage/repositories/github-filter-persist.ts',import.meta.url);assert(existsSync(helper),'GitHub filter SQL helper is unavailable');const {persistGitHubFilterCurrentUser}=await import(helper.href);
  scratch=new Database(':memory:');scratch.exec('CREATE TABLE space_github_source_settings(space_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,polling_intent INTEGER NOT NULL DEFAULT 0,filter_current_user INTEGER NOT NULL DEFAULT 1)');assert.equal(persistGitHubFilterCurrentUser(scratch,spaceId,false,41),undefined);const first={...scratch.prepare('SELECT * FROM space_github_source_settings').get()!};assert.deepEqual(first,{space_id:spaceId,enabled:1,created_at:41,updated_at:41,polling_intent:0,filter_current_user:0});assert.throws(()=>scratch!.transaction(()=>{persistGitHubFilterCurrentUser(scratch!,spaceId,true,99);throw new Error('synthetic rollback');})(),/synthetic rollback/);assert.deepEqual({...scratch.prepare('SELECT * FROM space_github_source_settings').get()!},first);evidence.suppliedTimeVoidResultAndCallerRollbackPreserved=true;
  assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.pass=true;
}finally{measuring=false;scratch?.close();try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;Database.prototype.prepare=original.prepare;globalThis.fetch=original.fetch;writeFileSync(join(run,'evidence/github-filter-extract.json'),JSON.stringify(evidence,null,2));}}
console.log('ok real filter RPC preserves defaults, flags, caller time and saved config; exact SQL extraction only');
