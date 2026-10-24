import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { HookExecutor } from '../../../packages/daemon/src/lib/hooks/hook-executor.ts';
import { createNeoCodingReaders } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createGithubConnector } from '../../../packages/daemon/src/lib/github/connectors/github-connector.ts';
import type { WorkflowHook } from '../../../packages/shared/src/types/space.ts';

const run=resolve(process.argv[2]),baseline=process.argv[3]==='baseline';
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));
assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const dir of ['home','bin','evidence'])mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;writeFileSync(join(run,'phase'),'cold');
writeFileSync(join(run,'bin/gh'),`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(run)},args=process.argv.slice(2),phase=readFileSync(root+'/phase','utf8');
const family=args[0]==='pr'&&args[1]==='view'?'basic':args[0]==='api'&&args.includes('graphql')?'threads':'unknown';
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase,family,args})+'\\n');
if(family==='unknown')process.exit(2);
await Bun.sleep(150);
if(family==='threads'){if(phase==='thread-failed'){process.stderr.write('Synthetic threads unavailable');process.exit(1);}if(phase==='thread-partial'){process.stdout.write('{}');process.exit(0);}const nodes=phase==='unresolved'?[{id:'thread',isResolved:false,comments:{nodes:[{url:'https://github.com/synthetic/ready/pull/7#discussion_1'}]}}]:[];process.stdout.write(JSON.stringify({data:{repository:{pullRequest:{url:'https://github.com/synthetic/ready/pull/7',headRefOid:'a'.repeat(40),reviewThreads:{nodes,pageInfo:{hasNextPage:false,endCursor:null}}}}}}));process.exit(0);}
if(phase==='failed'){process.stderr.write('Synthetic GitHub unavailable');process.exit(1);}
process.stdout.write(JSON.stringify({url:args[2],state:phase==='closed'?'CLOSED':'OPEN',mergeable:phase==='unknown'?'UNKNOWN':'MERGEABLE',mergeStateStatus:'CLEAN'}));
`,{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
const hook:WorkflowHook={id:'ready',enabled:true,sourceNode:'worker',method:'send_message',validator:{kind:'built_in',id:'pr_ready'}};
const url='https://github.com/synthetic/ready/pull/7',workspacePath=join(run,'home');
const context={workspacePath,runId:'run',hookId:'ready',methodName:'send_message',params:{data:{pr_url:url}},nodeId:'worker',nodeName:'worker',sessionId:'worker',taskId:'task',hookLocalState:{},currentArtifacts:[],permittedExternalLookups:['github']};
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;
const evidence:Record<string,any>={verified:false,baseline,productionPrReady:true};
const requests=()=>existsSync(join(run,'evidence/requests.jsonl'))?readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
async function start(){app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});}
const readers=()=>createNeoCodingReaders(()=>app!.db.getDatabase());
const config=()=>({workspacePath,readGithubPr:readers().readConnectorPr,...(baseline?{}:{readGithubReviewThreads:readers().readReviewThreads})});
const execute=()=>new HookExecutor(config()).execute(hook,context);
const connector=()=>createGithubConnector().ops.getPrReadiness({prUrl:url},{workspacePath,params:{},hookLocalState:{},readPr:readers().readConnectorPr,...(baseline?{}:{readReviewThreads:readers().readReviewThreads})});
const rows=()=>app!.db.getDatabase().prepare('SELECT subject,value_json,observed_at,reason FROM pack_coding_poll_facts ORDER BY subject').all();
try{
 await start();evidence.runtime={commit:BUILD_METADATA.commit,pid:process.pid,port:app!.server.port};
 [evidence.cold,evidence.connectorCold]=await Promise.all([Promise.all(Array.from({length:3},execute)),Promise.all(Array.from({length:2},connector))]);assert(evidence.cold.every((r:any)=>r.result.type==='allow'));assert(evidence.connectorCold.every((r:any)=>r.ok));
 evidence.coldReads=requests().length;assert.equal(evidence.coldReads,baseline?6:2);
 if(!baseline){
  const phase=(p:string)=>writeFileSync(join(run,'phase'),p);
  evidence.beforeRestart=rows();assert.equal(evidence.beforeRestart.length,2);await app!.cleanup();app=undefined;await start();assert.deepEqual(rows(),evidence.beforeRestart);
  phase('repeat');evidence.repeat=await execute();assert.equal(evidence.repeat.result.type,'allow');
  phase('unknown');evidence.unknown=await execute();assert.equal(evidence.unknown.result.type,'retryable_block');
  phase('closed');evidence.closed=await execute();assert.equal(evidence.closed.result.type,'block');
  const prior=rows()[0];phase('failed');evidence.failed=await execute();assert.equal(evidence.failed.result.type,'block');assert.match(evidence.failed.result.reason,/unavailable/);
  const failed=rows()[0];assert.equal(failed.value_json,prior.value_json);assert.equal(failed.observed_at,prior.observed_at);assert.equal(failed.reason,'failed');
  phase('unresolved');evidence.unresolved=await execute();assert.equal(evidence.unresolved.result.type,'block');assert.match(evidence.unresolved.result.reason,/#discussion_1/);
  const threadBefore=rows()[1];
  for(const name of ['thread-failed','thread-partial']){phase(name);const result=await execute();assert.equal(result.result.type,'block');evidence[name]=result;assert.equal(rows()[1].value_json,threadBefore.value_json);assert.equal(rows()[1].observed_at,threadBefore.observed_at);}
  phase('recovered');evidence.recovered=await execute();assert.equal(evidence.recovered.result.type,'allow');
 }
 evidence.counts=Object.fromEntries([...new Set(requests().map(r=>r.phase))].map(p=>[p,Object.fromEntries(['basic','threads'].map(f=>[f,requests().filter(r=>r.phase===p&&r.family===f).length]))]));
 assert.deepEqual(evidence.counts,baseline?{cold:{basic:1,threads:5}}:{cold:{basic:1,threads:1},repeat:{basic:1,threads:1},unknown:{basic:1,threads:0},closed:{basic:1,threads:0},failed:{basic:1,threads:0},unresolved:{basic:1,threads:1},'thread-failed':{basic:1,threads:1},'thread-partial':{basic:1,threads:1},recovered:{basic:1,threads:1}});
 evidence.verified=true;console.log(JSON.stringify({verified:true,baseline,coldReads:evidence.coldReads,evidence:join(run,'evidence/pr-ready.json')}));
}finally{await app?.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;evidence.requests=requests();writeFileSync(join(run,'evidence/pr-ready.json'),JSON.stringify(evidence,null,2));}
