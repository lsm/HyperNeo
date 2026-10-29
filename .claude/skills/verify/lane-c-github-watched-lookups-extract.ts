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
const evidence: Record<string, unknown> = { mainThreadMovementClaim: false, boundary: 'Verbatim watched key/id SELECT extraction only; public reads/writes remain main-side, constructor/backfill and UPSERT/cursor policy unchanged' };
const source = 'github', spaceId = 'synthetic-watched-lookup';

globalThis.fetch = (() => { throw new Error('External HTTP refused by extension extraction fixture'); }) as typeof fetch;
try{
  JobQueueProcessor.prototype.start=function(){processors.add(this);return original.start.call(this);};ExternalEventExtensionManager.prototype.register=function(extension){manager=this;if(extension.sourceId==='github'){const options=(extension as unknown as {options:{getPollIntervalMs?:()=>number;autoReconcileWebhooks?:boolean}}).options;options.getPollIntervalMs=()=>60_000;options.autoReconcileWebhooks=false;}return original.register.call(this,extension);};
  try{app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;}
  assert.notEqual(app.server.port,8399);await Promise.all([...processors].map(p=>p.stop()));main=app.db.getDatabase();await waitForSdkBodyCopy(main);assert(manager);
  const at=Date.now();for(const id of [spaceId,'synthetic-watched-lookup-peer'])main.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(id,id,join(run,'workspace',id),'Synthetic watched lookup',at,at);
  const store=new ExternalEventExtensionConfigStore(main);await store.setGlobalConfig(source,{source,globallyEnabled:false,capabilities:{rpcConfig:true,polling:false,webhooks:false}});
  const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);await transport.initialize();await hub.request('externalEvents.extensions.setGlobalEnabled',{source,enabled:true});
  Database.prototype.prepare=function(sql,...rest){const db=this,statement=Reflect.apply(original.prepare,this,[sql,...rest]);if(!sql.includes('SELECT * FROM space_github_watched_repos WHERE')||(!sql.includes('lower(owner)')&&!sql.includes('WHERE id = ?')))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(measuring&&db===main&&key==='get')bindings.push([sql,...args]);return Reflect.apply(value,target,args);};}});};
  measuring=true;const replies=[];const started=performance.now();let firstId='',createdAt=0;
  for(const [id,owner,repo,enabled]of [[spaceId,'OwnerZ','RepoZ',true],[spaceId,'ownerz','repoz',false],['synthetic-watched-lookup-peer','OWNERZ','REPOZ',true]]as const){const reply=await hub.request<{watchedRepo:{id:string;spaceId?:string;owner:string;repo:string;enabled:boolean;webhookEnabled:boolean;pollingEnabled:boolean;webhookSecret:unknown;createdAt:number};webhookUrl:string}>('space.github.watchRepo',{spaceId:id,owner,repo,enabled,webhookEnabled:false,pollingEnabled:false});assert.equal(reply.webhookUrl,'/webhook/github/space');const w=reply.watchedRepo;assert.equal(w.enabled,enabled);assert.equal(w.webhookEnabled,false);assert.equal(w.pollingEnabled,false);assert.equal(w.webhookSecret,null);if(!firstId){firstId=w.id;createdAt=w.createdAt;}else if(id===spaceId){assert.equal(w.id,firstId);assert.equal(w.createdAt,createdAt);assert.equal(w.owner,'OwnerZ');assert.equal(w.repo,'RepoZ');}else assert.notEqual(w.id,firstId);const config=await hub.request<{settings:{watchedRepos:{id:string;enabled:boolean}[]}}>('space.github.listConfig',{spaceId:id});assert.equal(config.settings.watchedRepos.length,1);assert.equal(config.settings.watchedRepos[0].id,w.id);assert.equal(config.settings.watchedRepos[0].enabled,enabled);replies.push({spaceId:id,id:w.id,enabled:w.enabled});}
  assert(bindings.some(b=>String(b[0]).includes('lower(owner)')));assert(bindings.some(b=>String(b[0]).includes('WHERE id = ?')));evidence.publicRpcMs=performance.now()-started;evidence.publicRpc={replies,mainLookupReads:bindings.length,lookupReadsObserved:true,sameIdentityAndCreationTimePreserved:true,spaceIsolationAndSavedConfigPreserved:true};measuring=false;
  const helper=new URL('../../../packages/daemon/src/storage/repositories/github-watched-repo-lookups.ts',import.meta.url);assert(existsSync(helper),'Constructor-free GitHub watched lookups are unavailable');const {findGitHubWatchedRepo,findGitHubWatchedRepoById}=await import(helper.href);
  scratch=new Database(':memory:');createWatchedTable(scratch);insertWatchedRow(scratch);insertWatchedRow(scratch,{id:'synthetic-other',space_id:'another-space'});scratch.exec('PRAGMA query_only=ON');assert.deepEqual(findGitHubWatchedRepo(scratch,'synthetic-space','ownerz','REPO-Z'),mappedWatchedRow);assert.deepEqual(findGitHubWatchedRepoById(scratch,'synthetic-one'),mappedWatchedRow);assert.equal(findGitHubWatchedRepo(scratch,'another-space','OWNERZ','repo-z')?.id,'synthetic-other');assert.equal(findGitHubWatchedRepo(scratch,'missing','ownerz','repo-z'),null);assert.equal(findGitHubWatchedRepoById(scratch,'SYNTHETIC-ONE'),null);assert.equal(scratch.prepare("SELECT name FROM sqlite_master WHERE name='space_github_source_settings'").get(),null);scratch.exec('PRAGMA query_only=OFF');scratch.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run('{broken','synthetic-one');scratch.exec('PRAGMA query_only=ON');assert.throws(()=>findGitHubWatchedRepo(scratch!,'synthetic-space','ownerz','repo-z'),SyntaxError);assert.throws(()=>findGitHubWatchedRepoById(scratch!,'synthetic-one'),SyntaxError);evidence.constructorFreeQueryOnlyRowsAndCursorErrorsPreserved=true;
  assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok');evidence.pass=true;
}finally{measuring=false;scratch?.close();try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;Database.prototype.prepare=original.prepare;globalThis.fetch=original.fetch;writeFileSync(join(run,'evidence/github-watched-lookups-extract.json'),JSON.stringify(evidence,null,2));}}
console.log('ok real watched RPC preserves case-insensitive identity, flags, timestamps and saved config; constructor-free query-only lookups preserve rows/null/cursor errors');
