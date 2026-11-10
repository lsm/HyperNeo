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
let measuring=false,mainReads=0;
const evidence:Record<string,unknown>={mainThreadMovementClaim:false,workerActivation:false};
const cases=[
 {source:'synthetic-global-valid',enabled:1,capabilities:'{"polling":true,"extra":{"preserved":1}}',settings:'{"label":"Synthetic 🦊","nested":{"off":false}}',secret:'synthetic/reference',expected:{source:'synthetic-global-valid',globallyEnabled:true,capabilities:{polling:true,extra:{preserved:1}},secretsRef:'synthetic/reference',settings:{label:'Synthetic 🦊',nested:{off:false}}}},
 {source:'synthetic-global-invalid',enabled:0,capabilities:'{',settings:'[]',secret:'',expected:{source:'synthetic-global-invalid',globallyEnabled:false,capabilities:{},secretsRef:'',settings:{}}},
 {source:'synthetic-global-null',enabled:0,capabilities:'null',settings:'null',secret:null,expected:{source:'synthetic-global-null',globallyEnabled:false,capabilities:{},settings:{}}},
 {source:'synthetic-global-primitive',enabled:0,capabilities:'42',settings:'"text"',secret:null,expected:{source:'synthetic-global-primitive',globallyEnabled:false,capabilities:{},settings:{}}},
];
const missing='synthetic-global-missing';
Database.prototype.prepare=function(sql,...rest){const db=this,statement=Reflect.apply(original.prepare,this,[sql,...rest]);if(sql!=='SELECT * FROM external_event_extension_configs WHERE source = ?')return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(measuring&&db===main&&key==='get')mainReads++;return Reflect.apply(value,target,args);};}});};
globalThis.fetch=(()=>{throw new Error('External HTTP refused by config lookup fixture');})as typeof fetch;
try{
 JobQueueProcessor.prototype.start=function(){processors.add(this);return original.start.call(this);};ExternalEventExtensionManager.prototype.register=function(extension){manager=this;return original.register.call(this,extension);};
 try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;}
 assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);assert(manager);
 const seed=(db:InstanceType<typeof Database>)=>{for(const row of cases)db.prepare('INSERT INTO external_event_extension_configs(source,globally_enabled,capabilities_json,secrets_ref,settings_json,created_at,updated_at)VALUES(?,?,?,?,?,1,1)').run(row.source,row.enabled,row.capabilities,row.secret,row.settings);};seed(main);
 for(const source of [...cases.map(row=>row.source),missing])manager.register({sourceId:source,async start(){throw new Error('Lookup fixture must not start providers');},async stop(){}});
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false,createSocket:url=>createLocalSocket(url,join(run,'data/local-rpc.credential'))});hub.registerTransport(transport);await transport.initialize();measuring=true;
 const at=performance.now();const listed=await hub.request<{extensions:{source:string;config:unknown}[]}>('externalEvents.extensions.list',{});evidence.publicRpcMs=performance.now()-at;
 for(const row of cases)assert.deepEqual(listed.extensions.find(item=>item.source===row.source)?.config,row.expected);assert.deepEqual(listed.extensions.find(item=>item.source===missing)?.config,{source:missing,globallyEnabled:false,capabilities:{}});assert.equal(mainReads,0);evidence.publicGetterNowReaderBacked=true;evidence.publicListCharacterized=true;evidence.publicMainReads=mainReads;
 const path=new URL('../../../packages/daemon/src/storage/repositories/global-extension-config-lookup.ts',import.meta.url);if(!existsSync(path))throw new Error('Constructor-free global config lookup unavailable');const {lookupGlobalExtensionConfig}=await import(path.href);
 scratch=new Database(':memory:');(await import('../../../packages/daemon/tests/unit/helpers/external-event-config-store.ts')).createExternalEventConfigStore(scratch);seed(scratch);
 for(const row of cases)assert.deepEqual(lookupGlobalExtensionConfig(scratch,row.source),row.expected);assert.deepEqual(lookupGlobalExtensionConfig(scratch,missing),{source:missing,globallyEnabled:false,capabilities:{}});
 assert.throws(()=>scratch!.transaction(()=>{scratch!.prepare('UPDATE external_event_extension_configs SET globally_enabled=0 WHERE source=?').run(cases[0].source);assert.equal(lookupGlobalExtensionConfig(scratch!,cases[0].source).globallyEnabled,false);throw new Error('synthetic rollback');})(),/synthetic rollback/);assert.deepEqual(lookupGlobalExtensionConfig(scratch,cases[0].source),cases[0].expected);evidence.suppliedConnectionAndRollbackPreserved=true;
 const store=new ExternalEventExtensionConfigStore(main),before=mainReads;await assert.rejects(store.getGlobalConfig(' bad '),/whitespace/);assert.equal(mainReads,before);evidence.validationBeforeLookupPreserved=true;
 assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.completeConfigs=cases.map(row=>row.expected);evidence.rssBytes=process.memoryUsage().rss;evidence.walBytes=existsSync(join(run,'data/daemon.db-wal'))?statSync(join(run,'data/daemon.db-wal')).size:0;evidence.pass=true;
}finally{measuring=false;scratch?.close();try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;Database.prototype.prepare=original.prepare;globalThis.fetch=original.fetch;evidence.mainReads=mainReads;writeFileSync(join(run,'evidence/extension-global-read-extract.json'),JSON.stringify(evidence,null,2));}}
console.log('ok global config lookup extraction preserves public list/defaults/JSON/source scope and supplied connection rollback; public getter now uses reader; constructor ownership separate');
