import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import type { Session } from '@hyperneo/shared';
const [phase,directory]=process.argv.slice(2),run=resolve(directory);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const name of ['workspace','bin','evidence'])mkdirSync(join(run,name),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const sdk=await import('../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const attempts:number[]=[],failure='Synthetic unknown query start failure 9093';let healthy=false,finish=()=>{};
mock.module('@anthropic-ai/claude-agent-sdk',()=>({...sdk,query:({prompt}:{prompt:AsyncIterable<unknown>|string})=>{
 if(typeof prompt!=='string'){attempts.push(Date.now());if(!healthy)throw new Error(failure);}
 const ended=new Promise<void>(resolve=>{finish=resolve;});
 return {async *[Symbol.asyncIterator](){
  if(typeof prompt==='string'){yield {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Synthetic title'}]}};return;}
  const feed=prompt[Symbol.asyncIterator]();await feed.next();void feed.next().catch(()=>{});
  yield {type:'system',subtype:'init',uuid:crypto.randomUUID(),session_id:crypto.randomUUID(),cwd:join(run,'workspace'),model:'claude-haiku-4-5-20251001',permissionMode:'default',apiKeySource:'user',claude_code_version:'synthetic',tools:[],skills:[],plugins:[],mcp_servers:[],slash_commands:[],output_style:'default'};
  yield {type:'result',subtype:'success',uuid:crypto.randomUUID(),session_id:crypto.randomUUID(),parent_tool_use_id:null,is_error:false,result:'Recovered synthetic reply',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},modelUsage:{},permission_denials:[]};
  await ended;
 },close:()=>finish(),interrupt:async()=>finish(),supportedModels:async()=>[],supportedCommands:async()=>[],setMcpServers:async()=>({added:[],removed:[],errors:{}})};
}}));
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
const {createDaemonApp}=await import('../../../packages/daemon/src/app.ts');
const {getConfig}=await import('../../../packages/daemon/src/config.ts');
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});assert.notEqual(app.server.port,8399);
const hub=new MessageHub({defaultSessionId:'global'}),transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);
const evidence:Record<string,unknown>={phase,passed:false,scriptedSdk:true,syntheticOnly:true};
const until=async(check:()=>boolean|Promise<boolean>,label:string,ms=20000)=>{const end=Date.now()+ms;while(!await check()){assert(Date.now()<end,label);await new Promise(done=>setTimeout(done,25));}};
try{
 await transport.initialize();
 await hub.request('providers.create',{params:{providerId:'anthropic',displayName:'Synthetic only',kind:'built_in',authType:'api_key',isEnabled:true,isDefault:true,sortOrder:0},credentials:{apiKey:'synthetic-never-sent'}});
 const registry=await hub.request<{servers:{id:string}[]}>('mcp.registry.list',{});for(const server of registry.servers)await hub.request('mcp.registry.setEnabled',{id:server.id,enabled:false});
 const {sessionId}=await hub.request<{sessionId:string}>('session.create',{workspacePath:join(run,'workspace'),title:'Synthetic failure governor',config:{model:'haiku',provider:'anthropic'}});
 await hub.request('message.send',{sessionId,content:'Synthetic fake-start regression'});
 const read=async()=>(await hub.request<{session:Session}>('session.get',{sessionId})).session;
 if(phase==='before'){
  await until(()=>attempts.length>=5,'baseline did not reproduce repeated fake failures',15000);
  evidence.baselineReproduced=true;evidence.attempts=[...attempts];
 }else{
  await until(async()=>(await read()).metadata.queryFailureEpisode?.failed===true,'failure cap never became public');
  const failed=await read();assert.equal(failed.metadata.queryFailureEpisode?.failures,3);assert(failed.metadata.queryFailureEpisode?.error.includes(failure));assert.equal(attempts.length,3);
  assert(attempts[1]-attempts[0]>=950 && attempts[2]-attempts[1]>=1950);
  const beforeCount=attempts.length;await new Promise(done=>setTimeout(done,2200));assert.equal(attempts.length,beforeCount);
  evidence.failed=failed.metadata.queryFailureEpisode;evidence.attempts=[...attempts];
  const row=app.db.getDatabase().prepare('SELECT metadata FROM sessions WHERE id=?').get(sessionId) as {metadata:string};assert.deepEqual(JSON.parse(row.metadata).queryFailureEpisode,failed.metadata.queryFailureEpisode);evidence.persisted=true;
  const old=failed.metadata.queryFailureEpisode!.id;healthy=true;
  const reset=await hub.request<{success:boolean}>('session.resetQuery',{sessionId,restartQuery:false});assert(reset.success);
  await hub.request('message.send',{sessionId,content:'Explicit recovery after fixing the cause'});
  await until(async()=>{const state=(await read()).metadata.queryFailureEpisode;return !!state && state.id!==old && state.failures===0 && attempts.length>beforeCount;},'explicit recovery did not start a fresh successful episode');
  evidence.recovered=(await read()).metadata.queryFailureEpisode;evidence.originalError=failure;evidence.noHotLoop=true;
 }
 evidence.passed=true;
}finally{
 finish();await transport.close();await app.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;
 writeFileSync(join(run,'evidence/query-failure-governor.json'),JSON.stringify(evidence,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(evidence).replaceAll(run,'<synthetic-run>'));
