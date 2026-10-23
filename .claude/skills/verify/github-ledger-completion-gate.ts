import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../packages/daemon/src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-run-repository.ts';
import { WorkflowHookStateRepository } from '../../../packages/daemon/src/storage/repositories/workflow-hook-state-repository.ts';
import { SessionRepository } from '../../../packages/daemon/src/storage/repositories/session-repository.ts';

const run=resolve(process.argv[2]),mode=process.argv[3]??'verify';
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));
assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const dir of ['home','bin','evidence'])mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
writeFileSync(join(run,'phase'),'cold');
writeFileSync(join(run,'bin/gh'),`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(run)},args=process.argv.slice(2),phase=readFileSync(root+'/phase','utf8');
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase,args})+'\\n');
if(args[0]!=='pr'||args[1]!=='view')process.exit(2);
await Bun.sleep(200);
if(['known','failed'].includes(phase)){process.stderr.write('Synthetic unavailable');process.exit(1);}
const state=phase==='open'?'OPEN':phase==='closed'?'CLOSED':'MERGED';
process.stdout.write(JSON.stringify({url:args[2],state,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',mergeCommit:phase==='partial'?null:state==='MERGED'?{oid:'a'.repeat(40)}:null}));
`,{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;
const evidence:Record<string,any>={mode,verified:false,workerMcpAdapter:true,newRpc:false};
const requests=()=>existsSync(join(run,'evidence/requests.jsonl'))?readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
try{
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
 await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});
 const db=app.db.getDatabase(),tasks=new SpaceTaskRepository(db),sessions=new SessionRepository(db);
 const space=new SpaceRepository(db).createSpace({name:'Synthetic completion',slug:'synthetic-completion',workspacePath:join(run,'home')});
 const workflow=new SpaceWorkflowRepository(db).createWorkflow({spaceId:space.id,name:'Synthetic coding',nodes:[],templateName:'Coder-Only Workflow'});
 const ledger=new CodingPrLedgerRepository(db),source='synthetic-github-observation',merged={state:'MERGED',mergeCommit:'a'.repeat(40)} as const;
 function fixture(number:number){
  const pinned=new SpaceWorkflowRunRepository(db).createPinnedRun({spaceId:space.id,workflowId:workflow.id,title:'Synthetic run',rawWorkflow:workflow});
  new WorkflowHookStateRepository(db).ensure(pinned.id,'__pr_ready_validated_identity__',{pr_url:`https://github.com/synthetic/ledger/pull/${number}`});
  const task=tasks.createTask({spaceId:space.id,title:'Synthetic task',status:'approved',workflowRunId:pinned.id});
  const sessionId=`synthetic:task:${task.id}:post-approval:worker`,at=new Date().toISOString();
  sessions.createSession({id:sessionId,title:'Synthetic worker',workspacePath:join(run,'home'),type:'worker',context:{spaceId:space.id,taskId:task.id},status:'active',createdAt:at,lastActiveAt:at,config:{model:'unregistered',maxTokens:8192,temperature:1},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}},{enforceWorkspaceOwnership:false});
  db.prepare('UPDATE space_tasks SET post_approval_session_id=? WHERE id=?').run(sessionId,task.id);
  const invoke=createOperationMcpHandler(()=>app!.sessionManager.getOperationRegistry(),()=>({sessionId,spaceId:space.id,role:'workflow_worker'}));
  return {id:task.id,complete:async()=>{const response=await invoke({name:'task.transition',input:{taskId:task.id,status:'done'}});assert(!response.isError,JSON.stringify(response));return JSON.parse(response.content[0].text);}};
 }
 const phase=(name:string)=>writeFileSync(join(run,'phase'),name);
 if(mode!=='baseline'){
  phase('known');ledger.mergeFacts.record('synthetic/ledger',7,{value:merged,source},Date.now(),0);
  const known=fixture(7);evidence.known=await known.complete();evidence.knownStatus=tasks.getTask(known.id)?.status;
  assert.equal(evidence.knownStatus,'done','Covered merge fact must settle the worker task while GitHub refuses');
  assert.equal(requests().length,0,'Covered merge fact must need no direct GitHub read');
 }
 phase('cold');const cold=Array.from({length:5},()=>fixture(8));evidence.cold=await Promise.all(cold.map(t=>t.complete()));
 assert(cold.every(t=>tasks.getTask(t.id)?.status==='done'),JSON.stringify(evidence.cold));
 const coldReads=requests().filter(r=>r.phase==='cold').length;evidence.coldReads=coldReads;
 if(mode==='baseline'){assert.equal(coldReads,5);evidence.verified=true;}
 else{
  assert.equal(coldReads,1,'Five missing state reads must share one ledger acquisition');
  phase('repeat');const repeat=fixture(8);evidence.repeat=await repeat.complete();assert.equal(tasks.getTask(repeat.id)?.status,'done');
  assert.equal(requests().filter(r=>r.phase==='repeat').length,0);
  for(const state of ['open','closed']){
   phase(state);const task=fixture(9);evidence[state]=await task.complete();assert.equal(tasks.getTask(task.id)?.status,'approved');assert.match(evidence[state].detail,new RegExp(state.toUpperCase()));
  }
  phase('merged');const recovered=fixture(9);evidence.merged=await recovered.complete();assert.equal(tasks.getTask(recovered.id)?.status,'done','A newly merged PR must not be blocked by cached CLOSED state');
  ledger.mergeFacts.record('synthetic/ledger',10,{value:merged,source},Date.now()-180_000,0);
  const prior=ledger.mergeFacts.read('synthetic/ledger',10,Date.now(),Infinity);
  phase('failed');const failed=fixture(10);evidence.failed=await failed.complete();assert.equal(tasks.getTask(failed.id)?.status,'approved');assert.match(evidence.failed.detail,/could not verify/);
  const row=ledger.mergeFacts.read('synthetic/ledger',10,Date.now(),Infinity);assert.equal(row.merge.status,'unknown');assert.equal(row.merge.observedAt,prior.merge.observedAt);
  phase('partial');const partial=fixture(11);evidence.partial=await partial.complete();assert.equal(tasks.getTask(partial.id)?.status,'approved');assert.match(evidence.partial.detail,/could not verify/);
  evidence.verified=true;
 }
 evidence.counts=Object.fromEntries([...new Set(requests().map(r=>r.phase))].map(p=>[p,requests().filter(r=>r.phase===p).length]));
 console.log(JSON.stringify({verified:evidence.verified,coldReads,evidence:join(run,'evidence/completion-gate.json')}));
}finally{
 evidence.requests=requests();writeFileSync(join(run,'evidence/completion-gate.json'),JSON.stringify(evidence,null,2));await app?.cleanup();globalThis.fetch=network;
}
