import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { createNeoCodingReaders } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createGithubConnector } from '../../../packages/daemon/src/lib/github/connectors/github-connector.ts';

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
await Bun.sleep(100);
if(phase==='failed'){process.stderr.write('Synthetic GitHub unavailable');process.exit(1);}
process.stdout.write(JSON.stringify({url:args[2],state:['merged','recovered'].includes(phase)?'MERGED':'OPEN',mergeable:phase==='partial'?undefined:'MERGEABLE',mergeStateStatus:'CLEAN'}));
`,{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;
const evidence:Record<string,any>={baseline,verified:false,productionConnectorWired:false};
const requests=()=>existsSync(join(run,'evidence/requests.jsonl'))?readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
try{
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
 await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});
 evidence.runtime={commit:BUILD_METADATA.commit,pid:process.pid,port:app.server.port};
 const db=app.db.getDatabase(),url='https://github.com/synthetic/ledger/pull/7',ctx={workspacePath:join(run,'home'),params:{},hookLocalState:{}};
 const read=baseline?(url:string,cwd:string)=>createGithubConnector().ops.getPr({prUrl:url},{...ctx,workspacePath:cwd}):createNeoCodingReaders(()=>db).readConnectorPr;
 evidence.cold=await Promise.all(Array.from({length:5},()=>read(url,ctx.workspacePath)));
 for(const outcome of evidence.cold)assert.deepEqual(outcome,{ok:true,data:{url,state:'OPEN',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'}});
 evidence.coldReads=requests().length;assert.equal(evidence.coldReads,baseline?5:1);
 if(!baseline){
  const phase=(name:string)=>writeFileSync(join(run,'phase'),name);
  const row=()=>db.prepare('SELECT value_json,observed_at,fact_revision,observation_revision,reason FROM pack_coding_poll_facts').all();
  phase('repeat');evidence.repeat=await read(url,ctx.workspacePath);assert.equal(evidence.repeat.ok,true);assert.equal(requests().filter(r=>r.phase==='repeat').length,1,'Read-before-write demands must refresh');
  phase('merged');evidence.merged=await read(url,ctx.workspacePath);assert.equal(evidence.merged.data.state,'MERGED');
  const prior=row()[0];assert.equal(row().length,1);evidence.prior=prior;
  phase('failed');evidence.failed=await read(url,ctx.workspacePath);assert.equal(evidence.failed.ok,false);assert.match(evidence.failed.error,/unavailable/);
  const failed=row()[0];assert.equal(failed.value_json,prior.value_json);assert.equal(failed.observed_at,prior.observed_at);assert.equal(failed.reason,'failed');
  phase('partial');evidence.partial=await read(url,ctx.workspacePath);assert.equal(evidence.partial.ok,false);assert.match(evidence.partial.error,/partial/);
  const partial=row()[0];assert.equal(partial.value_json,prior.value_json);assert.equal(partial.observed_at,prior.observed_at);assert.equal(partial.reason,'partial');
  phase('recovered');evidence.recovered=await read(url,ctx.workspacePath);assert.equal(evidence.recovered.ok,true);
  db.prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)').run('old/repo','synthetic/ledger');
  phase('alias');evidence.alias=await Promise.all([read('https://github.com/OLD/REPO/pull/7',ctx.workspacePath),read(url,ctx.workspacePath)]);assert(evidence.alias.every((o:any)=>o.ok));assert.equal(row().length,1);assert.equal(requests().filter(r=>r.phase==='alias').length,1);
  const count=requests().length;phase('invalid');evidence.invalid=await read('https://untrusted.invalid/synthetic/ledger/pull/7',ctx.workspacePath);assert.equal(evidence.invalid.ok,false);assert.equal(requests().length,count);
  evidence.rows=row();evidence.historyPreserved=true;
 }
 evidence.counts=Object.fromEntries([...new Set(requests().map(r=>r.phase))].map(p=>[p,requests().filter(r=>r.phase===p).length]));evidence.verified=true;
 console.log(JSON.stringify({verified:true,coldReads:evidence.coldReads,evidence:join(run,'evidence/connector-pr.json')}));
}finally{
 evidence.requests=requests();writeFileSync(join(run,'evidence/connector-pr.json'),JSON.stringify(evidence,null,2));await app?.cleanup();globalThis.fetch=network;
}
