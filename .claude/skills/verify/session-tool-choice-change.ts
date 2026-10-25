import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '../../../packages/shared/src/mod.ts';
import { changeSessionToolChoice, type SessionToolChoiceChangeDependencies } from '../../../packages/daemon/src/lib/tools/change-session-tool-choice.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { pinnedSlotVetoes } = await import('../../../packages/daemon/src/storage/repositories/session-tool-selection-migration.ts');
const { SpaceRepository } = await import('../../../packages/daemon/src/storage/repositories/space-repository.ts');
const { SpaceWorkflowRepository } = await import('../../../packages/daemon/src/storage/repositories/space-workflow-repository.ts');
const { SpaceWorkflowRunRepository } = await import('../../../packages/daemon/src/storage/repositories/space-workflow-run-repository.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const evidence: Record<string, unknown> = { activeConsumerWired: false, sdkApplyVerified: false, queryStarted: false };
let sessionId = '';
let serverId = '';
let prior: unknown;
let pinnedSessionId = '';
let pinnedPrior: unknown;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
for (const boot of [1, 2]) {
  const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  let release = () => {};
  try {
    await transport.initialize();
    if (boot === 1) {
      const registry = await hub.request<{ servers: {id:string}[] }>('mcp.registry.list', {});
      for (const server of registry.servers) await hub.request('mcp.registry.setEnabled', {id:server.id,enabled:false});
      const {server} = await hub.request<{server:{id:string}}>('mcp.registry.create',{name:'fixture-registry',sourceType:'stdio',command:'not-executed',enabled:false});
      serverId = server.id;
      await hub.request('skill.create', {params:{name:'fixture-alias',displayName:'Synthetic browser',description:'Fixture only',sourceType:'mcp_server',config:{type:'mcp_server',appMcpServerId:serverId},enabled:false,validationStatus:'valid'}});
      ({sessionId} = await hub.request<{sessionId:string}>('session.create',{workspacePath:join(run,'workspace'),title:'Synthetic choice change',config:{model:'haiku',provider:'anthropic',queryMode:'manual',autoScroll:true,sdkToolsPreset:['Read']}}));
      const deps: SessionToolChoiceChangeDependencies = {
        capture: app.db.captureSessionRuntimeSettings.bind(app.db),
        commit: app.db.casSessionRuntimeSettings.bind(app.db),
        catalog: snapshot => ({skills:app.db.skills.findAll(),registry:app.db.appMcpServers.list(),overrides:app.db.mcpEnablement.listAll(),disabledSkillIds:(JSON.parse(snapshot.config) as Session['config']).tools?.disabledSkills}),
        pinnedSlotVetoes: snapshot => pinnedSlotVetoes(app.db.getDatabase(), snapshot.metadata),
      };
      const input = {sessionId,key:`mcp:${serverId}` as const,selected:true};
      const accepted = await changeSessionToolChoice(input,deps);
      assert(accepted.ok && accepted.changed);
      assert.deepEqual(accepted.selection.choices[input.key],{selected:true,aliases:['fixture-alias']});
      assert.deepEqual(app.db.getDatabase().prepare("SELECT json_type(config,'$.toolSelection') AS type FROM sessions WHERE id=?").get(sessionId),{type:'object'});
      await app.sessionManager.interruptInMemorySession(sessionId);
      const reloaded = (await hub.request<{session:Session}>('session.get',{sessionId})).session;
      assert.deepEqual(reloaded.config.toolSelection,accepted.selection);
      assert.equal(reloaded.config.autoScroll,true);
      assert.deepEqual(reloaded.config.sdkToolsPreset,['Read']);
      assert.deepEqual(await changeSessionToolChoice(input,deps),{ok:true,changed:false,selection:accepted.selection});
      const waiting = deferred();
      const held = deferred();
      release = held.resolve;
      const stale = changeSessionToolChoice({...input,selected:false},{...deps,commit:async(snapshot,patch)=>{waiting.resolve();await held.promise;return deps.commit(snapshot,patch);}});
      void stale.catch(() => {});
      await waiting.promise;
      await hub.request('session.update',{sessionId,config:{autoScroll:false}});
      held.resolve();
      assert.deepEqual(await stale,{ok:false,reason:'superseded'});
      const after = app.db.getSession(sessionId)!;
      assert.equal(after.config.autoScroll,false);
      assert.deepEqual(after.config.toolSelection,accepted.selection);
      assert(!app.sessionManager.getSession(sessionId)?.queryObject);
      evidence.accepted = accepted;
      evidence.reloaded = reloaded.config.toolSelection;
      evidence.concurrentEditWon = true;
      prior = after.config.toolSelection;
      const space = new SpaceRepository(app.db.getDatabase()).createSpace({name:'Pinned fixture',slug:'pinned-fixture',workspacePath:join(run,'workspace')});
      const {server: pinnedServer} = await hub.request<{server:{id:string}}>('mcp.registry.create',{name:'fixture-pinned-server',sourceType:'stdio',command:'not-executed',enabled:true});
      const {skill: pinnedSkill} = await hub.request<{skill:{id:string}}>('skill.create',{params:{name:'fixture-pinned-alias',displayName:'Pinned fixture',description:'Fixture only',sourceType:'mcp_server',config:{type:'mcp_server',appMcpServerId:pinnedServer.id},enabled:true,validationStatus:'valid'}});
      const workflows = new SpaceWorkflowRepository(app.db.getDatabase());
      const workflow = workflows.createWorkflow({spaceId:space.id,name:'Pinned workflow',nodes:[{id:'fixture-node',name:'Build',agents:[{agentId:'fixture-agent',name:'Coder',disabledSkillIds:[pinnedSkill.id]}]}]});
      const workflowRun = new SpaceWorkflowRunRepository(app.db.getDatabase()).createPinnedRun({spaceId:space.id,workflowId:workflow.id,title:'Pinned run',rawWorkflow:workflow});
      app.db.getDatabase().prepare("UPDATE space_workflow_runs SET status='done' WHERE id=?").run(workflowRun.id);
      workflows.updateWorkflow(workflow.id,{nodes:[{id:'fixture-node',name:'Build',agents:[{agentId:'fixture-agent',name:'Coder'}]}]});
      pinnedSessionId = crypto.randomUUID();
      await app.db.createSession({id:pinnedSessionId,title:'Pinned legacy worker',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'paused',config:{model:'haiku',maxTokens:8192,temperature:1,queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0,promptProvenance:{source:'fixture',hash:'fixture',workflowRunId:workflowRun.id,nodeId:'fixture-node',agentId:'fixture-agent',agentName:'Coder'}},context:{spaceId:space.id}});
      const pinnedChange = await changeSessionToolChoice({...input,sessionId:pinnedSessionId},deps);
      assert(pinnedChange.ok);
      assert.deepEqual(pinnedChange.selection.choices[`mcp:${pinnedServer.id}`],{selected:false,aliases:['fixture-pinned-alias']});
      const pinnedRead = (await hub.request<{session:Session}>('session.get',{sessionId:pinnedSessionId})).session;
      assert.deepEqual(pinnedRead.config.toolSelection,pinnedChange.selection);
      assert(!app.sessionManager.getSession(pinnedSessionId)?.queryObject);
      pinnedPrior = pinnedRead.config.toolSelection;
      evidence.pinnedLegacySelection = pinnedPrior;
    } else {
      const restored = (await hub.request<{session:Session}>('session.get',{sessionId})).session;
      assert.deepEqual(restored.config.toolSelection,prior);
      assert.equal(restored.config.autoScroll,false);
      assert(!app.sessionManager.getSession(sessionId)?.queryObject);
      evidence.restarted = restored.config.toolSelection;
      const pinnedRead = (await hub.request<{session:Session}>('session.get',{sessionId:pinnedSessionId})).session;
      assert.deepEqual(pinnedRead.config.toolSelection,pinnedPrior);
      assert(!app.sessionManager.getSession(pinnedSessionId)?.queryObject);
      evidence.pinnedRestarted = pinnedRead.config.toolSelection;
    }
  } finally { release(); await transport.close(); await app.cleanup(); }
}
evidence.pass = true;
writeFileSync(join(run,'evidence/session-tool-choice-change.json'),JSON.stringify(evidence,null,2));
console.log('PASS choice-change foundation: real CAS, JSON-object storage, cold RPC reload, stale-write refusal and daemon restart; no active-consumer flip');
