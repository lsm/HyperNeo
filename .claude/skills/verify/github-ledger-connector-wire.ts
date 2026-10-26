import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { HookExecutor } from '../../../packages/daemon/src/lib/hooks/hook-executor.ts';
import { createNeoCodingReaders } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
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
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase,args})+'\\n');
if(args[0]!=='pr'||args[1]!=='view')process.exit(2);
await Bun.sleep(150);
if(phase==='failed'){process.stderr.write('Synthetic GitHub unavailable');process.exit(1);}
process.stdout.write(JSON.stringify({url:args[2],state:phase==='open'?'OPEN':'MERGED',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'}));
`,{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
const hook:WorkflowHook={id:'merged',enabled:true,sourceNode:'worker',method:'send_message',validator:{kind:'built_in',id:'pr_merged'}};
const url='https://github.com/synthetic/wire/pull/7',workspacePath=join(run,'home');
const context={workspacePath,runId:'run',hookId:'merged',methodName:'send_message',params:{data:{pr_url:url}},nodeId:'worker',nodeName:'worker',sessionId:'worker',taskId:'task',hookLocalState:{},currentArtifacts:[],permittedExternalLookups:['github']};
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;
const evidence:Record<string,any>={verified:false,baseline,hookExecutor:true,productionConnector:true};
const requests=()=>existsSync(join(run,'evidence/requests.jsonl'))?readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
async function start(){app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});}
const execute=()=>new HookExecutor({workspacePath,...(baseline?{}:{readGithubPr:createNeoCodingReaders(()=>app!.db.getDatabase()).readConnectorPr})}).execute(hook,context);
const rows=()=>app!.db.getDatabase().prepare('SELECT value_json,observed_at,reason FROM pack_coding_poll_facts').all();
try{
 await start();evidence.runtime={commit:BUILD_METADATA.commit,pid:process.pid,port:app!.server.port};
 evidence.cold=await Promise.all(Array.from({length:5},execute));assert(evidence.cold.every((r:any)=>r.result.type==='allow'));
 evidence.coldReads=requests().length;assert.equal(evidence.coldReads,baseline?5:1);
 if(!baseline){
  const phase=(p:string)=>writeFileSync(join(run,'phase'),p);
  evidence.beforeRestart=rows();assert.equal(evidence.beforeRestart.length,1);
  await app!.cleanup();app=undefined;await start();assert.deepEqual(rows(),evidence.beforeRestart);
  phase('repeat');evidence.repeat=await execute();assert.equal(evidence.repeat.result.type,'allow');
  phase('open');evidence.open=await execute();assert.equal(evidence.open.result.type,'retryable_block');
  const prior=rows()[0];phase('failed');evidence.failed=await execute();assert.equal(evidence.failed.result.type,'block');assert.match(evidence.failed.result.reason,/unavailable/);
  const failed=rows()[0];assert.equal(failed.value_json,prior.value_json);assert.equal(failed.observed_at,prior.observed_at);assert.equal(failed.reason,'failed');
  phase('recovered');evidence.recovered=await execute();assert.equal(evidence.recovered.result.type,'allow');
  evidence.rows=rows();
 }
 evidence.counts=Object.fromEntries([...new Set(requests().map(r=>r.phase))].map(p=>[p,requests().filter(r=>r.phase===p).length]));
 assert.deepEqual(evidence.counts,baseline?{cold:5}:{cold:1,repeat:1,open:1,failed:1,recovered:1});
 evidence.verified=true;console.log(JSON.stringify({verified:true,baseline,coldReads:evidence.coldReads,evidence:join(run,'evidence/workflow-connector.json')}));
}finally{await app?.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;evidence.requests=requests();writeFileSync(join(run,'evidence/workflow-connector.json'),JSON.stringify(evidence,null,2));}
