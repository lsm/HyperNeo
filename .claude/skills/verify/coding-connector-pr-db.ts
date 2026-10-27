import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { HookExecutor } from '../../../packages/daemon/src/lib/hooks/hook-executor.ts';
import { createNeoCodingReaders } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { CodingPollFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/poll-facts.ts';
import type { WorkflowHook } from '../../../packages/shared/src/types/space.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data/daemon.db')));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
for (const dir of ['home', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const url = 'https://github.com/synthetic/basic/pull/7';
const phase = (value: string) => writeFileSync(join(run, 'phase'), value);
phase('cold'); writeFileSync(join(run, 'release'), 'waiting');
writeFileSync(join(run, 'bin/gh'), String.raw`#!/usr/bin/env bun
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const root=dirname(dirname(process.argv[1])),args=process.argv.slice(2),phase=readFileSync(join(root,'phase'),'utf8');
appendFileSync(join(root,'evidence/requests.jsonl'),JSON.stringify({phase,args})+'\n');
if(args[0]!=='pr'||args[1]!=='view'){process.stderr.write('Synthetic request refused');process.exit(2);}
if(phase==='late'){writeFileSync(join(root,'late-start'),'ready');while(readFileSync(join(root,'release'),'utf8')!=='release')await Bun.sleep(10);}
await Bun.sleep(150);
if(phase==='failed'){process.stderr.write('Synthetic GitHub unavailable');process.exit(1);}
console.log(JSON.stringify({url:phase==='wrong-identity'?'https://github.com/synthetic/wrong/pull/7':args[2],state:phase==='open'?'OPEN':'MERGED',mergeable:phase==='partial'?undefined:'MERGEABLE',mergeStateStatus:'CLEAN'}));
`, { mode: 0o700 });
const hook: WorkflowHook = { id:'merged', enabled:true, sourceNode:'worker', method:'send_message', validator:{kind:'built_in',id:'pr_merged'} };
const evidence: Record<string, any> = {mode,verified:false,consumer:'Persisted synthetic job invoking production HookExecutor/pr_merged with the same reader wiring as TaskAgentManager',limitation:'Synthetic job wrapper; no real workflow run, model, GitHub or merge is started.'};
const mainSql: string[] = [], commands: unknown[] = [];
const requests = () => existsSync(join(run,'evidence/requests.jsonl')) ? readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)) : [];
const counts = (name: string) => requests().filter(r=>r.phase===name).length;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, measuring=false, outstanding: Promise<any> | undefined;
const network = globalThis.fetch; globalThis.fetch = (()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
function fixture<T>(read:()=>T):T { const previous=measuring; measuring=false; try{return read();}finally{measuring=previous;} }
const rows = () => fixture(()=>app!.db.getDatabase().prepare('SELECT * FROM pack_coding_poll_facts ORDER BY subject').all() as Record<string,any>[]);
async function open() {
  app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); assert.notEqual(app.server.port,8399);
  app.db.updateGlobalSettings({neo:{packs:[]}});
  const db=app.db.getDatabase(),prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{if(measuring&&/pack_coding_(poll_facts|repo_aliases)/.test(sql))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
  const send=app.db.gateway.run.bind(app.db.gateway);
  app.db.gateway.run=(async(op,args)=>{const start=performance.now(),value=await send(op,args);if(op.name.startsWith('coding.pollPage.')||op.name==='coding.connector.identity')commands.push({name:op.name,method:(args as {method?:string}).method,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value)??'null')});return value;}) as typeof app.db.gateway.run;
  const read=createNeoCodingReaders(()=>db).readConnectorPr;
  app.jobProcessor.register('verify.coding.connector-pr', async job=>{
    const target=String(job.payload.url), executor=new HookExecutor({workspacePath:join(run,'home'),readGithubPr:read});
    const context={workspacePath:join(run,'home'),runId:'synthetic',hookId:'merged',methodName:'send_message',params:{data:{pr_url:target}},nodeId:'worker',nodeName:'worker',sessionId:'worker',taskId:'task',hookLocalState:{},currentArtifacts:[],permittedExternalLookups:['github']};
    return {results:await Promise.all(Array.from({length:Number(job.payload.count)},()=>executor.execute(hook,context)))};
  });
}
async function health() {
  const start=performance.now(),ws=new WebSocket(`ws://127.0.0.1:${app!.server.port}/ws`);
  try {
    await new Promise<void>((done,fail)=>{ws.onopen=()=>done();ws.onerror=()=>fail(new Error('Health connect failed'));});
    const id=crypto.randomUUID();
    const result=await new Promise<unknown>((done,fail)=>{
      const timer=setTimeout(()=>fail(new Error('Health RPC timed out')),2000);
      ws.onmessage=event=>{const reply=JSON.parse(String(event.data));if(reply.id!==id&&reply.requestId!==id)return;clearTimeout(timer);if(reply.error)fail(new Error(JSON.stringify(reply.error)));else done(reply.data);};
      ws.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'system.health',data:{},timestamp:new Date().toISOString(),version:'1.0.0'}));
    });
    const elapsedMs=performance.now()-start;assert(elapsedMs<250);return {elapsedMs,result};
  } finally {ws.close();}
}
async function execute(count=1,target=url) {
  const job=app!.jobQueue.enqueue({queue:'verify.coding.connector-pr',payload:{url:target,count},maxRetries:0,priority:100});
  await app!.jobProcessor.start();
  try {
    for(let i=0;i<300;i++){
      const observed=app!.jobQueue.getJob(job.id)!;
      if(observed.status==='completed'){assert(observed.result);return observed.result.results as any[];}
      assert(!['dead','failed'].includes(observed.status),JSON.stringify(observed));
      await new Promise(done=>setTimeout(done,25));
    }
    throw new Error('Synthetic hook job timed out');
  }finally{await app!.jobProcessor.stop();}
}
try {
  await open(); measuring=true;
  evidence.cold=await execute(5);assert(evidence.cold.every((r:any)=>r.result.type==='allow'));assert.equal(counts('cold'),1);assert.equal(rows().length,1);assert.equal(rows()[0].observation_revision,1);
  phase('repeat');await execute();assert.equal(rows()[0].fact_revision,1);assert.equal(rows()[0].observation_revision,2);
  phase('open');evidence.open=await execute();assert.equal(evidence.open[0].result.type,'retryable_block');assert.equal(JSON.parse(rows()[0].value_json).state,'OPEN');
  const prior=rows()[0];
  for(const name of ['failed','partial','wrong-identity']){phase(name);evidence[name]=await execute();assert.equal(evidence[name][0].result.type,'block');const current=rows()[0];assert.equal(current.value_json,prior.value_json);assert.equal(current.observed_at,prior.observed_at);assert.equal(current.reason,name==='failed'?'failed':'partial');}
  phase('recovered');await execute();assert.equal(rows()[0].reason,null);
  fixture(()=>app!.db.getDatabase().prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)').run('old/repo','synthetic/basic'));
  phase('alias');evidence.alias=await execute(5,'https://github.com/OLD/REPO/pull/7');assert(evidence.alias.every((r:any)=>r.result.type==='allow'));assert.equal(counts('alias'),1);assert.equal(rows().length,1);
  const retained=rows();measuring=false;await app!.cleanup();app=undefined;await open();assert.deepEqual(rows(),retained);measuring=true;
  phase('reopen');await execute();assert.equal(rows()[0].observation_revision,retained[0].observation_revision+1);
  if(mode==='verify'){
    const facts=new CodingPollFactsRepository(app!.db.getDatabase()),before=rows()[0],subject={credentialId:'github-connector',url,accept:'application/vnd.hyperneo.pr-basic+json',apiVersion:'v1'};
    phase('late');outstanding=execute();
    for(let i=0;!existsSync(join(run,'late-start'));i++){assert(i<500,'Late GitHub read did not start');await new Promise(done=>setTimeout(done,10));}
    evidence.health=await health();
    const value={url,state:'CLOSED',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'};
    const winner=await facts.observeCurrent(subject,{value,etag:null,next:null},Date.now(),before.observation_revision);assert(winner.accepted);
    writeFileSync(join(run,'release'),'release');evidence.late=await outstanding;outstanding=undefined;assert.equal(evidence.late[0].result.type,'block');assert.equal(rows()[0].observation_revision,winner.facts.observationRevision);assert.deepEqual(JSON.parse(rows()[0].value_json),value);
    const loser=await facts.observeCurrent(subject,{reason:'failed'},Date.now(),before.observation_revision);assert.equal(loser.accepted,false);assert.deepEqual(loser.facts,winner.facts);evidence.fence={winner,loser};
    assert.deepEqual(mainSql,[],'Basic PR connector snapshots and writes must leave main');
  }else assert(mainSql.length>0,'Baseline must show poll SQL on main');
  evidence.rows=rows();evidence.counts=Object.fromEntries([...new Set(requests().map(r=>r.phase))].map(name=>[name,counts(name)]));evidence.verified=true;
} finally {
  measuring=false;writeFileSync(join(run,'release'),'release');await outstanding?.catch(()=>{});
  evidence.mainSql=mainSql;evidence.commands=commands;evidence.requests=requests();
  writeFileSync(join(run,'evidence/coding-connector-pr-db.json'),JSON.stringify(evidence,null,2));await app?.cleanup();globalThis.fetch=network;
}
