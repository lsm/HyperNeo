import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '../../../packages/shared/src/mod.ts';
import type { SessionToolSelection } from '../../../packages/shared/src/types/session-tool-choice.ts';
import { commitToolDefaultUpdate, captureToolPreferenceRow } from '../../../packages/daemon/src/storage/repositories/tool-preference-commit.ts';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { Server } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { ListToolsRequestSchema } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

import { createSessionToolPreferenceWriter, type PreferenceDatabase } from '../../../packages/daemon/src/lib/tools/write-session-tool-preferences.ts';

const run=resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
assert(!existsSync(join(run,'data')));
for(const name of ['home','workspace','evidence']) mkdirSync(join(run,name),{recursive:true});
const {createDaemonApp}=await import('../../../packages/daemon/src/app.ts');
const {getConfig}=await import('../../../packages/daemon/src/config.ts');
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const mcp=new Server({name:'synthetic-browser',version:'1'},{capabilities:{tools:{}}});
mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'navigate',inputSchema:{type:'object'}}]}));
const client=new Client({name:'synthetic-projection',version:'1'});
const [a,b]=InMemoryTransport.createLinkedPair();
await mcp.connect(a);
await client.connect(b);
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;
let transport:InstanceType<typeof WebSocketClientTransport>|undefined;
const evidence:Record<string,unknown>={coordinatorInvokedDirectly:true,sdkConsumerWired:false,sdkApplyVerified:false,queryStarted:false};
try {
  app=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});
  assert.notEqual(app.server.port,8399);
  const hub=new MessageHub({defaultSessionId:'global'});
  transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});
  hub.registerTransport(transport);
  await transport.initialize();
  const registry=await hub.request<{servers:{id:string}[]}>('mcp.registry.list',{});
  for(const server of registry.servers) await hub.request('mcp.registry.setEnabled',{id:server.id,enabled:false});
  const {server}=await hub.request<{server:{id:string}}>('mcp.registry.create',{name:'fixture-registry',sourceType:'stdio',command:'not-executed',enabled:false,env:{FIXTURE_ONLY:'synthetic'}});
  const {skill:wrapper}=await hub.request<{skill:{id:string}}>('skill.create',{params:{name:'fixture-wrapper',displayName:'Fixture wrapper',description:'Fixture only',sourceType:'mcp_server',config:{type:'mcp_server',appMcpServerId:server.id},enabled:false,validationStatus:'valid'}});
  const {skill:instruction}=await hub.request<{skill:{id:string}}>('skill.create',{params:{name:'fixture-instruction',displayName:'Fixture instruction',description:'Fixture only',sourceType:'builtin',config:{type:'builtin',commandName:'fixture-instruction'},enabled:false,validationStatus:'valid'}});
  const {sessionId}=await hub.request<{sessionId:string}>('session.create',{workspacePath:join(run,'workspace'),config:{model:'haiku',provider:'anthropic',queryMode:'manual',sdkToolsPreset:['Read']}});
  const raw=app.db.getDatabase();
  const seeded:SessionToolSelection={version:1,choices:{[`mcp:${server.id}`]:{selected:false,aliases:['frozen-fixture']},[`skill:${instruction.id}`]:{selected:false}}};
  await hub.request('tools.save',{sessionId,tools:{disabledSkills:[wrapper.id,instruction.id]}});
  assert.equal(await app.db.casSessionRuntimeSettings(app.db.captureSessionRuntimeSettings(sessionId)!,{toolSelection:seeded}),'won');
  const notices:string[]=[];
  const write=createSessionToolPreferenceWriter(app.db,async id=>{notices.push(id);});
  const tools={disabledSkills:[],useClaudeCodePreset:false};
  const mainTransaction=raw.transaction;
  const mainPrepare=raw.prepare;
  let mainSqlAttempts=0;
  const checkMainSql=()=>{
    if (/\/(?:write-session-tool-preferences|session-tool-preference-read)\.ts/.test(new Error().stack??'')) {
      mainSqlAttempts++;
      throw new Error('preference coordinator used main-thread SQLite');
    }
  };
  raw.transaction=(...args)=>{checkMainSql();return Reflect.apply(mainTransaction,raw,args);};
  raw.prepare=(...args)=>{checkMainSql();return Reflect.apply(mainPrepare,raw,args);};
  let saved:Awaited<ReturnType<typeof write>>;
  try {
    saved=await write(sessionId,{kind:'skills',disabledSkills:[]},tools);
  } finally {
    raw.transaction=mainTransaction;
    raw.prepare=mainPrepare;
  }
  assert.equal(mainSqlAttempts,0);
  evidence.captureAndCommitOffMain=true;
  assert(saved.ok);
  assert.equal(saved.selection.choices[`mcp:${server.id}`]?.selected,true);
  assert.equal(saved.selection.choices[`skill:${instruction.id}`]?.selected,true);
  assert.deepEqual(saved.selection.choices[`mcp:${server.id}`]?.aliases,['frozen-fixture']);
  await app.sessionManager.interruptInMemorySession(sessionId);
  const reload=async()=>(await hub.request<{session:Session}>('session.get',{sessionId})).session;
  let session=await reload();
  assert.deepEqual(session.config.toolSelection,saved.selection);
  assert.deepEqual(session.config.tools,tools);
  assert.deepEqual(session.config.sdkToolsPreset,['Read']);
  const disabled=await write(sessionId,{kind:'skills',disabledSkills:[instruction.id]});
  assert(disabled.ok);
  await app.sessionManager.interruptInMemorySession(sessionId);
  session=await reload();
  assert.deepEqual(session.config.tools,{...tools,disabledSkills:[instruction.id]});
  assert.equal(session.config.toolSelection!.choices[`skill:${instruction.id}`]?.selected,false);
  const enabled=await write(sessionId,{kind:'skills',disabledSkills:[]});
  assert(enabled.ok);
  await app.sessionManager.interruptInMemorySession(sessionId);
  session=await reload();
  assert.deepEqual(session.config.tools,tools);
  assert.equal(session.config.toolSelection!.choices[`skill:${instruction.id}`]?.selected,true);
  evidence.requestOnlyDisableEnableRoundTrip=true;
  assert((await write(sessionId,{kind:'mcp',serverId:server.id,enabled:true})).ok);
  let entries=(await hub.request<{entries:{server:{id:string};enabled:boolean;source:string}[]}>('session.mcp.list',{sessionId})).entries;
  assert(entries.some(entry=>entry.server.id===server.id && entry.enabled && entry.source==='session'));
  const target=captureToolPreferenceRow(raw,{table:'global_settings',id:1});
  const defaults:SessionToolSelection={version:1,choices:{[`mcp:${server.id}`]:{selected:false,aliases:['global-default']}}};
  assert.equal(commitToolDefaultUpdate(raw,target,[],defaults,()=>true),'won');
  const cleared=await write(sessionId,{kind:'mcp',serverId:server.id,enabled:null});
  assert(cleared.ok && cleared.deleted);
  assert.deepEqual(cleared.selection.choices[`mcp:${server.id}`],{selected:false,aliases:['frozen-fixture']});
  assert.equal(cleared.selection.choices[`skill:${instruction.id}`]?.selected,true);
  await app.sessionManager.interruptInMemorySession(sessionId);
  session=await reload();
  assert.deepEqual(session.config.toolSelection,cleared.selection);
  assert.equal(app.db.mcpEnablement.getOverride('session',sessionId,server.id),null);
  function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
  const captured=deferred();const held=deferred();
  const data:PreferenceDatabase={gateway:app.db.gateway,casSessionToolPreferences:async(...args)=>{captured.resolve();await held.promise;return app!.db.casSessionToolPreferences(...args);}};
  const racingWrite=createSessionToolPreferenceWriter(data,async()=>{throw new Error('stale write must not notify');});
  const pending=racingWrite(sessionId,{kind:'mcp',serverId:server.id,enabled:true});
  void pending.catch(()=>{});
  try {
    await captured.promise;
    await hub.request('mcp.enablement.setOverride',{scopeType:'session',scopeId:sessionId,serverId:server.id,enabled:false});
  } finally {held.resolve();}
  assert.deepEqual(await pending,{ok:false,reason:'superseded'});
  assert.deepEqual(app.db.getSession(sessionId)!.config.toolSelection,cleared.selection);
  assert.equal(app.db.mcpEnablement.getOverride('session',sessionId,server.id)?.enabled,false);
  const before=app.db.captureSessionRuntimeSettings(sessionId)!;
  raw.exec("CREATE TRIGGER coordinator_failure BEFORE UPDATE ON mcp_enablement BEGIN SELECT RAISE(ABORT,'synthetic coordinator failure'); END");
  await assert.rejects(write(sessionId,{kind:'mcp',serverId:server.id,enabled:true},{disabledSkills:[wrapper.id]}),/synthetic coordinator failure/);
  raw.exec('DROP TRIGGER coordinator_failure');
  assert.equal(app.db.captureSessionRuntimeSettings(sessionId)!.config,before.config);
  assert.equal(app.db.mcpEnablement.getOverride('session',sessionId,server.id)?.enabled,false);
  assert.deepEqual(notices,[sessionId,sessionId,sessionId,sessionId,sessionId]);
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['navigate']);
  assert.equal((await hub.request<{state:string}>('session.getToolInventory',{sessionId})).state,'not_running');
  evidence.selection=cleared.selection;
  evidence.tools=tools;
  evidence.sessionId=sessionId;
  evidence.serverId=server.id;
  evidence.rpcReadback=session.config.toolSelection;
  evidence.coordinatorSavesBothKinds=true;
  evidence.inheritedClearKeptAlias=true;
  evidence.staleSourceRefused=true;
  evidence.sqlFailureRolledBack=true;
  evidence.onlyAcceptedWritesNotified=true;
} finally {
  await transport?.close();
  await app?.cleanup();
  await client.close();
  await mcp.close();
  writeFileSync(join(run,'evidence/session-tool-writer.json'),JSON.stringify(evidence,null,2));
}
const restarted=await createDaemonApp({config:{...getConfig({host:'127.0.0.1',port:0,dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});
const hub2=new MessageHub({defaultSessionId:'global'});
const connection=new WebSocketClientTransport({url:`ws://127.0.0.1:${restarted.server.port}/ws`,autoReconnect:false});
hub2.registerTransport(connection);
try {
  assert.notEqual(restarted.server.port,8399);
  await connection.initialize();
  const session=(await hub2.request<{session:Session}>('session.get',{sessionId:evidence.sessionId})).session;
  assert.deepEqual(session.config.toolSelection,evidence.selection);
  assert.deepEqual(session.config.tools,evidence.tools);
  const entries=(await hub2.request<{entries:{server:{id:string};enabled:boolean;source:string}[]}>('session.mcp.list',{sessionId:evidence.sessionId})).entries;
  assert(entries.some(entry=>entry.server.id===evidence.serverId && !entry.enabled && entry.source==='session'));
  evidence.restartRetainedCanonicalAndLegacy=true;
  evidence.pass=true;
  console.log('PASS coordinator Build: skills/override saves, inherited clear, real-worker race and SQL rollback, cold RPC readback/restart; direct coordinator proof; SDK consumer remains unwired');
} finally {
  await connection.close();
  await restarted.cleanup();
  writeFileSync(join(run,'evidence/session-tool-writer.json'),JSON.stringify(evidence,null,2));
}
