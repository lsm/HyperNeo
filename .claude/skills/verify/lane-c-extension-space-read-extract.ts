import '../../../packages/daemon/tests/unit/helpers/register-space-schema.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const run=resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data')));
for(const key of ['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','GITHUB_TOKEN'])assert.equal(process.env[key],undefined);
for(const name of ['home','workspace','bin','evidence'])mkdirSync(join(run,name),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o755});process.env.PATH=join(run,'bin')+':'+process.env.PATH;
const {createDaemonApp}=await import('../../../packages/daemon/src/app.ts');
const {getConfig}=await import('../../../packages/daemon/src/config.ts');
const {JobQueueProcessor}=await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const {ExternalEventExtensionManager}=await import('../../../packages/daemon/src/lib/external-events/extension-manager.ts');
const {ExternalEventExtensionConfigStore}=await import('../../../packages/daemon/src/lib/external-events/extension-config-store.ts');
const {Database}=await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const original={start:JobQueueProcessor.prototype.start,register:ExternalEventExtensionManager.prototype.register,prepare:Database.prototype.prepare,fetch:globalThis.fetch};
const processors=new Set<InstanceType<typeof JobQueueProcessor>>();
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,transport:InstanceType<typeof WebSocketClientTransport>|undefined,manager:InstanceType<typeof ExternalEventExtensionManager>|undefined,main:InstanceType<typeof Database>|undefined,scratch:InstanceType<typeof Database>|undefined;
let measuring=false,mainGets=0,mainLists=0;
const evidence:Record<string,unknown>={workerActivation:false,mainThreadMovementClaim:false};
const source='github';
const cases=[
 {spaceId:'synthetic-a',enabled:1,settings:'{"label":"Synthetic 🦊","nested":{"off":false}}',expected:{spaceId:'synthetic-a',source,enabled:true,settings:{label:'Synthetic 🦊',nested:{off:false}}}},
 {spaceId:'synthetic-b',enabled:0,settings:'{',expected:{spaceId:'synthetic-b',source,enabled:false,settings:{}}},
 {spaceId:'synthetic-c',enabled:1,settings:'[]',expected:{spaceId:'synthetic-c',source,enabled:true,settings:{}}},
 {spaceId:'synthetic-d',enabled:1,settings:'null',expected:{spaceId:'synthetic-d',source,enabled:true,settings:{}}},
 {spaceId:'synthetic-e',enabled:1,settings:'42',expected:{spaceId:'synthetic-e',source,enabled:true,settings:{}}},
];
const seed=(db:InstanceType<typeof Database>,native:boolean)=>{
 for(const row of [...cases].reverse()){
  if(native)db.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,1,1)').run(row.spaceId,row.spaceId,join(run,'workspace',row.spaceId),row.spaceId);else db.prepare('INSERT INTO spaces(id)VALUES(?)').run(row.spaceId);
  db.prepare('INSERT INTO space_external_event_source_configs(space_id,source,enabled,settings_json,created_at,updated_at)VALUES(?,?,?,?,1,1)').run(row.spaceId,source,row.enabled,row.settings);
 }
 db.prepare('INSERT INTO space_external_event_source_configs(space_id,source,enabled,settings_json,created_at,updated_at)VALUES(?,?,?,?,1,1)').run(cases[0].spaceId,'synthetic-other',1,'{"other":true}');
};
Database.prototype.prepare=function(sql,...rest){const db=this,statement=Reflect.apply(original.prepare,this,[sql,...rest]);if(!sql.startsWith('SELECT * FROM space_external_event_source_configs'))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(measuring&&db===main){if(key==='get')mainGets++;if(key==='all')mainLists++;}return Reflect.apply(value,target,args);};}});};
globalThis.fetch=(()=>{throw new Error('External HTTP refused by Space lookup fixture');})as typeof fetch;
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return original.start.call(this);};ExternalEventExtensionManager.prototype.register=function(extension){manager=this;return original.register.call(this,extension);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);assert(manager);seed(main,true);
 const store=new ExternalEventExtensionConfigStore(main);await store.setGlobalConfig(source,{source,globallyEnabled:false,capabilities:{rpcConfig:true,polling:false,webhooks:false}});
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false,createSocket:url=>createLocalSocket(url,join(run,'data/local-rpc.credential'))});hub.registerTransport(transport);await transport.initialize();await hub.request('externalEvents.extensions.setGlobalEnabled',{source,enabled:true});measuring=true;
 const at=performance.now();for(const row of cases)assert.deepEqual(await hub.request('space.github.listConfig',{spaceId:row.spaceId}),row.expected);assert.equal(await hub.request('space.github.listConfig',{spaceId:'synthetic-missing'}),null);evidence.publicRpcMs=performance.now()-at;assert.equal(mainGets,cases.length+1);evidence.publicRpcValuesPreserved=true;
 const enabled=cases.filter(row=>row.enabled===1).map(row=>row.expected);assert.deepEqual(await store.listEnabledSpaces(source),enabled);assert.deepEqual(await store.listEnabledSpaces('synthetic-missing'),[]);assert.deepEqual(await store.getSpaceConfig(cases[0].spaceId,'synthetic-other'),{spaceId:cases[0].spaceId,source:'synthetic-other',enabled:true,settings:{other:true}});assert.equal(mainLists,2);evidence.enabledOrderingAndSourceIsolationPreserved=true;
 const before=[mainGets,mainLists];await assert.rejects(store.getSpaceConfig(' bad ',source),/Space id/);await assert.rejects(store.getSpaceConfig(cases[0].spaceId,' bad '),/External event source/);await assert.rejects(store.listEnabledSpaces(''),/non-empty/);assert.deepEqual([mainGets,mainLists],before);evidence.validationBeforeQueriesPreserved=true;
 const path=new URL('../../../packages/daemon/src/storage/repositories/space-extension-config-lookup.ts',import.meta.url);assert(existsSync(path),'Constructor-free Space config queries unavailable');const {lookupSpaceExtensionConfig,listEnabledSpaceExtensionConfigs}=await import(path.href);
 scratch=new Database(':memory:');scratch.exec('CREATE TABLE spaces(id TEXT PRIMARY KEY)');(await import('../../../packages/daemon/tests/unit/helpers/external-event-config-store.ts')).createExternalEventConfigStore(scratch);seed(scratch,false);
 for(const row of cases)assert.deepEqual(lookupSpaceExtensionConfig(scratch,row.spaceId,source),row.expected);assert.equal(lookupSpaceExtensionConfig(scratch,'synthetic-missing',source),null);assert.deepEqual(listEnabledSpaceExtensionConfigs(scratch,source),enabled);
 assert.throws(()=>scratch!.transaction(()=>{scratch!.prepare('UPDATE space_external_event_source_configs SET enabled=1,settings_json=? WHERE space_id=? AND source=?').run('{"pending":true}',cases[1].spaceId,source);assert.deepEqual(lookupSpaceExtensionConfig(scratch!,cases[1].spaceId,source),{spaceId:cases[1].spaceId,source,enabled:true,settings:{pending:true}});assert.equal(listEnabledSpaceExtensionConfigs(scratch!,source).length,cases.length);throw new Error('synthetic rollback');})(),/synthetic rollback/);assert.deepEqual(lookupSpaceExtensionConfig(scratch,cases[1].spaceId,source),cases[1].expected);assert.deepEqual(listEnabledSpaceExtensionConfigs(scratch,source),enabled);evidence.suppliedConnectionAndRollbackPreserved=true;
 assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(join(run,'data/daemon.db-wal'))?statSync(join(run,'data/daemon.db-wal')).size:0;evidence.pass=true;
}finally{measuring=false;scratch?.close();try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;Database.prototype.prepare=original.prepare;globalThis.fetch=original.fetch;evidence.mainGets=mainGets;evidence.mainLists=mainLists;writeFileSync(join(run,'evidence/extension-space-read-extract.json'),JSON.stringify(evidence,null,2));}}
console.log('ok Space config queries preserve public GitHub config RPC, enabled ordering/source scope, validation and supplied connection rollback; reads remain on main');
