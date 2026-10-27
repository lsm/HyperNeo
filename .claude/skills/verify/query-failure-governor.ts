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
const failures:Record<string,string>={startup:'SDK startup timeout - query aborted',auth:'401 Claude authentication failed',transient:'ECONNRESET connection closed',provider:'503 service unavailable',resume:'No message found with message.uuid of: synthetic',deadline:'Query preparation timed out'};
const attempts:number[]=[],failure=failures[phase]??'Synthetic unknown query start failure 9093';const hollowResults:number[]=[];let healthy=phase==='hollow'||phase==='large'||phase==='scoped',finish=()=>{};
let scopedCount=0,releaseParent=()=>{},armCompaction=()=>{};const recipientStarts:number[]=[];
mock.module('@anthropic-ai/claude-agent-sdk',()=>({...sdk,query:({prompt,options}:{prompt:AsyncIterable<unknown>|string;options?:{cwd?:string}})=>{
 const recipient=phase==='consumer'&&options?.cwd===join(run,'neo-workspace');
 if(typeof prompt!=='string'){
  if(recipient)recipientStarts.push(Date.now());
  else{attempts.push(Date.now());if(phase==='scoped'&&attempts.length===1)throw new Error(failure);if(!healthy)throw new Error(failure);}
 }
 let endQuery=()=>{};const ended=new Promise<void>(resolve=>{endQuery=resolve;finish=resolve;});
 return {async *[Symbol.asyncIterator](){
  if(typeof prompt==='string'){yield {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Synthetic title'}]}};return;}
  const feed=prompt[Symbol.asyncIterator]();await feed.next();let nextInput=feed.next();void nextInput.catch(()=>{});
  yield {type:'system',subtype:'init',uuid:crypto.randomUUID(),session_id:crypto.randomUUID(),cwd:join(run,'workspace'),model:'claude-haiku-4-5-20251001',permissionMode:'default',apiKeySource:'user',claude_code_version:'synthetic',tools:[],skills:[],plugins:[],mcp_servers:[],slash_commands:[],output_style:'default'};
  if(phase==='scoped'){
   const parentGate=new Promise<void>(resolve=>{releaseParent=resolve;});
   for(const [isError,parent,text] of [[true,'child','Synthetic child failure'],[false,'child','Synthetic child success'],[true,'child','401 Claude authentication failed'],[false,null,'Synthetic compact'],[true,null,'API Error: 429 rate_limit_error: too many requests']] as const){
    const compact=text==='Synthetic compact';if(compact)armCompaction();
    yield {type:'result',subtype:'success',uuid:crypto.randomUUID(),session_id:crypto.randomUUID(),parent_tool_use_id:parent,is_error:isError,result:text,duration_ms:1,duration_api_ms:1,num_turns:compact?0:1,total_cost_usd:0,usage:{input_tokens:compact?0:1,output_tokens:compact?0:1},modelUsage:{},permission_denials:[],...(text.startsWith('API Error: 429')?{api_error_status:429,terminal_reason:'blocking_limit'}:{})};scopedCount++;
   }
   await parentGate;
  }
  if(phase==='large'){
   for(let turn=0;turn<3;turn++)yield {type:'result',subtype:'error_during_execution',uuid:crypto.randomUUID(),session_id:crypto.randomUUID(),parent_tool_use_id:null,is_error:true,errors:['Synthetic huge error: '+ 'x'.repeat(100_000)],duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0},modelUsage:{},permission_denials:[]};
   await ended;return;
  }
  if(phase==='hollow'){
   for(let turn=0;turn<6;turn++){
    hollowResults.push(Date.now());
    yield {type:'result',subtype:'success',uuid:crypto.randomUUID(),session_id:crypto.randomUUID(),parent_tool_use_id:null,origin:{kind:'task-notification'},is_error:false,result:'',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0},modelUsage:{},permission_denials:[]};
    yield {type:'system',subtype:'session_state_changed',state:'idle',uuid:crypto.randomUUID(),session_id:crypto.randomUUID()};
    if(turn<5){await nextInput;nextInput=feed.next();void nextInput.catch(()=>{});}
   }
   await ended;return;
  }
  yield {type:'result',subtype:'success',uuid:crypto.randomUUID(),session_id:crypto.randomUUID(),parent_tool_use_id:null,is_error:false,result:'Recovered synthetic reply',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},modelUsage:{},permission_denials:[]};
  await ended;
 },close:()=>endQuery(),interrupt:async()=>endQuery(),supportedModels:async()=>[],supportedCommands:async()=>[],setMcpServers:async()=>({added:[],removed:[],errors:{}})};
}}));
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
const {createDaemonApp}=await import('../../../packages/daemon/src/app.ts');
const {getConfig}=await import('../../../packages/daemon/src/config.ts');
const {NeoRepository}=await import('../../../packages/daemon/src/storage/repositories/neo-repository.ts');
const {sdkMessageBodyAt}=await import('../../../packages/daemon/src/storage/repositories/sdk-message-body-read.ts');
const {ErrorCategory}=await import('../../../packages/daemon/src/lib/error-manager.ts');
const {MessageHub,WebSocketClientTransport}=await import('../../../packages/shared/src/mod.ts');
const app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db'),workspaceRoot:join(run,'workspace')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});assert.notEqual(app.server.port,8399);
const hub=new MessageHub({defaultSessionId:'global'}),transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});hub.registerTransport(transport);
const evidence:Record<string,unknown>={phase,passed:false,scriptedSdk:true,syntheticOnly:true};
const errors:{sessionId:string;error:string;details?:unknown}[]=[];const stopErrors=app.internalEventBus.subscribe('session.error',event=>{errors.push(event);},{subscriberName:'query-failure-governor-proof'});
const until=async(check:()=>boolean|Promise<boolean>,label:string,ms=20000)=>{const end=Date.now()+ms;while(!await check()){assert(Date.now()<end,label);await new Promise(done=>setTimeout(done,25));}};
try{
 await transport.initialize();
 const consumerRoot='neo:10000000-0000-4000-8000-000000009095';
 if(phase==='consumer'){
  mkdirSync(join(run,'neo-workspace'),{recursive:true});
  await app.db.createSession({id:consumerRoot,title:'Synthetic Neo recipient',workspacePath:join(run,'neo-workspace'),status:'active',type:'general',createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),config:{queryMode:'manual',model:'haiku',provider:'anthropic'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0,titleGenerated:true,titleSetBy:'user'}});
  new NeoRepository(app.db.getDatabase()).reserveBinding({sessionId:consumerRoot,kind:'neo',projectId:null});
 }
 await hub.request('providers.create',{params:{providerId:'anthropic',displayName:'Synthetic only',kind:'built_in',authType:'api_key',isEnabled:true,isDefault:true,sortOrder:0},credentials:{apiKey:'synthetic-never-sent'}});
 const registry=await hub.request<{servers:{id:string}[]}>('mcp.registry.list',{});for(const server of registry.servers)await hub.request('mcp.registry.setEnabled',{id:server.id,enabled:false});
 const {sessionId}=await hub.request<{sessionId:string}>('session.create',{workspacePath:join(run,'workspace'),title:'Synthetic failure governor',config:{model:'haiku',provider:'anthropic'}});
 if(phase==='consumer'){
  const manager=app.sessionManager.getSession(sessionId)!.errorManager;
  for(let prior=0;prior<5;prior++)await manager.handleError(sessionId,failure,ErrorCategory.SYSTEM);
  evidence.throttleSaturated=true;
 }
 let releaseLate=()=>{};
 if(phase==='scoped'){const agent=app.sessionManager.getSession(sessionId)!;agent.onResultLimitError=async()=>true;armCompaction=()=>agent.messageQueue.armInternalCompactionResultAttribution();}
 if(phase==='deadline'){
  const agent=app.sessionManager.getSession(sessionId)!;const options=await agent.optionsBuilder.build();
  agent.optionsBuilder.build=()=>new Promise(resolve=>{releaseLate=()=>resolve(options);});
  process.env.HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS='100';
 }
 await hub.request('message.send',{sessionId,content:'Synthetic fake-start regression'});
 const read=async()=>(await hub.request<{session:Session}>('session.get',{sessionId})).session;
 if(phase==='scoped'){
  await until(()=>scopedCount===5,'scoped results incorrectly stopped the owning query');
  const prior=(await read()).metadata.queryFailureEpisode!;assert.equal(prior.failures,1);assert.equal(prior.failed,false);assert(prior.error.includes(failure));
  const rows=app.db.getDatabase().prepare("SELECT parent_tool_use_id,internal_compaction_turn,recovery_intercepted,recovery_billing_terminal FROM sdk_messages WHERE session_id=? AND message_type='result'").all(sessionId) as Record<string,unknown>[];
  assert.equal(rows.filter(row=>row.parent_tool_use_id==='child').length,3);assert(rows.some(row=>row.internal_compaction_turn===1));assert(rows.some(row=>row.recovery_intercepted===1&&row.recovery_billing_terminal===0));
  evidence.priorEpisode=prior;evidence.classifiedResults=rows;releaseParent();
  await until(async()=>(await read()).metadata.queryFailureEpisode?.failures===0,'real parent success did not reset the episode');evidence.recovered=(await read()).metadata.queryFailureEpisode;assert.equal(attempts.length,2);
 }else if(phase==='large'){
  await until(async()=>(await read()).metadata.queryFailureEpisode?.failed===true,'large result did not reach the cap');
  const episode=(await read()).metadata.queryFailureEpisode!;assert(episode.error.includes('Synthetic huge error'));assert(episode.error.length<=4096);
  await until(()=>errors.some(event=>(event.details as {metadata?:{queryFailureEpisode?:{failed:boolean}}})?.metadata?.queryFailureEpisode?.failed),'large result terminal event missing');
  const terminal=errors.find(event=>(event.details as {metadata?:{queryFailureEpisode?:{failed:boolean}}})?.metadata?.queryFailureEpisode?.failed)!;assert(((terminal.details as {metadata:{queryFailureEpisode:{error:string}}}).metadata.queryFailureEpisode.error).length<=4096);evidence.episode=episode;evidence.errorLength=episode.error.length;
 }else if(phase==='hollow'){
  evidence.hollowResults=hollowResults;evidence.errors=errors;
  await until(()=>errors.some(event=>JSON.stringify(event).includes('re-query budget exhausted')),'hollow recovery did not reach its existing exhaustion owner');
  assert.equal(hollowResults.length,6);assert(hollowResults[1]-hollowResults[0]>=450);
  const state=(await read()).metadata.queryFailureEpisode;assert.equal(state?.failures,0);assert.equal(state?.failed,false);
  evidence.hollowResults=hollowResults;evidence.escalation=errors.find(event=>JSON.stringify(event).includes('re-query budget exhausted'));evidence.episode=state;
  await new Promise(done=>setTimeout(done,1000));assert.equal(hollowResults.length,6);
 }else if(phase==='before'){
  await until(()=>attempts.length>=5,'baseline did not reproduce repeated fake failures',45000);
  const jobs=app.db.getDatabase().prepare("SELECT retry_count AS retryCount,json_extract(payload,'$.__parkCount') AS parks FROM job_queue WHERE queue='message_delivery' AND json_extract(payload,'$.sessionId')=?").all(sessionId) as {retryCount:number;parks:number}[];assert(jobs.some(job=>job.retryCount===0 && job.parks>=4));evidence.jobs=jobs;
  evidence.baselineReproduced=true;evidence.attempts=[...attempts];
 }else{
  await until(async()=>(await read()).metadata.queryFailureEpisode?.failed===true,'failure cap never became public');
  await until(()=>errors.some(event=>event.error.includes('Query stopped after 3 failures')),'terminal error was not published');
  const terminal=errors.find(event=>event.sessionId===sessionId && event.error.includes('Query stopped after 3 failures'))!;assert((terminal.details as {metadata:{queryFailureEpisode:{failed:boolean}}}).metadata.queryFailureEpisode.failed);evidence.terminalEvent=terminal;
  const failed=await read();assert.equal(failed.metadata.queryFailureEpisode?.failures,3);assert(failed.metadata.queryFailureEpisode?.error.includes(failure));assert.equal(attempts.length,phase==='deadline'?0:3);
  if(phase!=='deadline')assert(attempts[1]-attempts[0]>=950 && attempts[2]-attempts[1]>=1950);
  const beforeCount=attempts.length;await new Promise(done=>setTimeout(done,2200));assert.equal(attempts.length,beforeCount);
  evidence.failed=failed.metadata.queryFailureEpisode;evidence.attempts=[...attempts];
  const row=app.db.getDatabase().prepare('SELECT metadata FROM sessions WHERE id=?').get(sessionId) as {metadata:string};assert.deepEqual(JSON.parse(row.metadata).queryFailureEpisode,failed.metadata.queryFailureEpisode);evidence.persisted=true;
  if(phase==='consumer'){
   const episode=failed.metadata.queryFailureEpisode!;
   assert.equal(typeof episode.error,'string');assert(episode.error.includes(failure));
   const publicStatus=await hub.request<{ok:boolean;value:{status:string;lastReply?:string}}>('operation.invoke',{name:'work.status',input:{ref:{adapter:'hyperneo',id:sessionId}}});
   assert.equal(publicStatus.ok,true);assert.equal(publicStatus.value.status,'failed');assert.equal(publicStatus.value.lastReply,episode.error);
   const inputs=()=>app.db.getDatabase().prepare(`SELECT ${sdkMessageBodyAt('m.rowid')} AS body,send_status FROM sdk_messages m WHERE session_id=? AND message_type='user' ORDER BY seq`).all(consumerRoot) as {body:string;send_status:string}[];
   await until(()=>inputs().length>0,'real capped query never woke Neo');
   const recipient=inputs();assert.equal(recipient.length,1);assert(recipient[0].body.includes(episode.error));assert.equal(JSON.parse(recipient[0].body).neoWakeEvent,true);
   assert.deepEqual((terminal.details as {metadata:{queryFailureEpisode:unknown}}).metadata.queryFailureEpisode,episode);
   await until(()=>recipientStarts.length>0,'Neo wake did not reach its scripted SDK');assert.equal(recipientStarts.length,1);
   evidence.workStatus=publicStatus;evidence.recipientInputs=recipient;evidence.recipientSdkStarts=recipientStarts;evidence.originalErrorPersistedWithFailure=true;
  }
  const old=failed.metadata.queryFailureEpisode!.id;healthy=true;
  releaseLate();await new Promise(done=>setTimeout(done,150));assert.equal(attempts.length,beforeCount);delete process.env.HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS;
  const reset=await hub.request<{success:boolean}>('session.resetQuery',{sessionId,restartQuery:false});assert(reset.success);
  await hub.request('message.send',{sessionId,content:'Explicit recovery after fixing the cause'});
  await until(async()=>{const state=(await read()).metadata.queryFailureEpisode;return !!state && state.id!==old && state.failures===0 && attempts.length>beforeCount;},'explicit recovery did not start a fresh successful episode');
  evidence.recovered=(await read()).metadata.queryFailureEpisode;evidence.originalError=failure;evidence.noHotLoop=true;
  if(phase==='consumer'){
   const after=app.db.getDatabase().prepare("SELECT COUNT(*) AS count FROM sdk_messages WHERE session_id=? AND message_type='user'").get(consumerRoot) as {count:number};assert.equal(after.count,1);evidence.recipientCountAfterRecovery=after.count;
  }
 }
 evidence.passed=true;
}finally{
 stopErrors();releaseParent();finish();await transport.close();await app.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;
 writeFileSync(join(run,'evidence/query-failure-governor.json'),JSON.stringify(evidence,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(evidence).replaceAll(run,'<synthetic-run>'));
