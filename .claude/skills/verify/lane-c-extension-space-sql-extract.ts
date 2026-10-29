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
const evidence: Record<string, unknown> = { mainThreadMovementClaim: false, boundary: 'Space configuration SQL extraction only; public writes remain on main and other GitHub repository writes are outside this extraction' };
const source = 'github', spaceId = 'synthetic-space-config';
const settings = { pollingIntent: false, filterCurrentUser: true, watchedRepos: [] };
const config = { spaceId, source, enabled: true, settings };
globalThis.fetch = (() => { throw new Error('External HTTP refused by extension extraction fixture'); }) as typeof fetch;
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return original.start.call(this); };
  ExternalEventExtensionManager.prototype.register = function (extension) { manager = this; return original.register.call(this, extension); };
  try { app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run,'data/daemon.db'), workspaceRoot: join(run,'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false }); }
  finally { JobQueueProcessor.prototype.start = original.start; ExternalEventExtensionManager.prototype.register = original.register; }
  assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);assert(manager);
  const now=Date.now();main.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(spaceId,'synthetic-space-config',join(run,'workspace'),'Synthetic config',now,now);
  const store=new ExternalEventExtensionConfigStore(main);await store.setGlobalConfig('github',{source:'github',globallyEnabled:false,capabilities:{rpcConfig:true,polling:false,webhooks:false}});
  const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
  assert.deepEqual(await hub.request('externalEvents.extensions.setGlobalEnabled',{source:'github',enabled:true}),{source:'github',globallyEnabled:true});
  Database.prototype.prepare=function(sql,...rest){const db=this,statement=Reflect.apply(original.prepare,this,[sql,...rest]);if(!/INSERT INTO space_external_event_source_configs/i.test(sql))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(measuring&&db===main&&key==='run')bindings.push(args);return Reflect.apply(value,target,args);};}});};
  measuring=true;const replies=[];let createdAt:unknown;const at=performance.now();
  for(const enabled of [true,false]){const reply=await hub.request(`space.github.${enabled?'enable':'disable'}`,{spaceId});assert.deepEqual(reply,{spaceId,source,enabled});assert.deepEqual(await hub.request('space.github.listConfig',{spaceId}),{...config,enabled});const row=main.prepare('SELECT * FROM space_external_event_source_configs WHERE space_id=? AND source=?').get(spaceId,source)!;createdAt??=row.created_at;assert.equal(row.created_at,createdAt);assert.equal(row.enabled,enabled?1:0);assert.equal(row.settings_json,'{"pollingIntent":false,"filterCurrentUser":true,"watchedRepos":[]}');assert((row.updated_at as number)>=(row.created_at as number));replies.push(reply);}
  evidence.publicRpcMs=performance.now()-at;assert.equal(bindings.length,2);assert.deepEqual(bindings.map(b=>b.slice(0,4)),[true,false].map(enabled=>[spaceId,source,enabled?1:0,'{"pollingIntent":false,"filterCurrentUser":true,"watchedRepos":[]}']));evidence.publicRpc={replies,mainUpsertRuns:bindings.length,exactSettingsAndCreationTimePreserved:true};measuring=false;
  const helper=new URL('../../../packages/daemon/src/storage/repositories/space-extension-config-persist.ts',import.meta.url);assert(existsSync(helper),'Space extension SQL helper is unavailable');const {persistSpaceExtensionConfig}=await import(helper.href);
  scratch=new Database(':memory:');scratch.exec("PRAGMA foreign_keys=ON;CREATE TABLE spaces(id TEXT PRIMARY KEY);INSERT INTO spaces VALUES('synthetic-space-config')");new ExternalEventExtensionConfigStore(scratch);persistSpaceExtensionConfig(scratch,spaceId,source,config,41);const saved=scratch.prepare('SELECT * FROM space_external_event_source_configs').get()!;assert.equal(saved.created_at,41);assert.equal(saved.updated_at,41);
  assert.throws(()=>scratch!.transaction(()=>{persistSpaceExtensionConfig(scratch!,spaceId,source,{...config,enabled:false},99);throw new Error('synthetic rollback');})(),/synthetic rollback/);assert.deepEqual({...scratch.prepare('SELECT * FROM space_external_event_source_configs').get()!},{...saved});scratch.prepare('DELETE FROM spaces WHERE id=?').run(spaceId);assert.equal(scratch.prepare('SELECT COUNT(*) AS n FROM space_external_event_source_configs').get()!.n,0);evidence.suppliedTimeRollbackAndCascadePreserved=true;
  assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.pass=true;
}finally{measuring=false;scratch?.close();try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;Database.prototype.prepare=original.prepare;globalThis.fetch=original.fetch;writeFileSync(join(run,'evidence/extension-space-sql-extract.json'),JSON.stringify(evidence,null,2));}}
console.log('ok Space config SQL extraction preserves real GitHub Space enable/disable/list RPC and settings/time/rollback/cascade; no off-main claim');
