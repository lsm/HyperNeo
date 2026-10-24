import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { createNeoCodingReaders } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';

const run=resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));
assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const part of ['home','bin','evidence'])mkdirSync(join(run,part),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;writeFileSync(join(run,'phase'),'cold');
writeFileSync(join(run,'bin/gh'),`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(run)},args=process.argv.slice(2),phase=readFileSync(root+'/phase','utf8');
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase,args})+'\\n');
if(args[0]!=='api'||!args.includes('graphql')||!args.some(a=>a.includes('reviewThreads')))process.exit(2);
await Bun.sleep(120);
if(phase==='failed'||phase==='partial-stderr'){process.stderr.write(phase==='failed'?'Synthetic GitHub unavailable':'Synthetic transport failure: partial');process.exit(1);}
const later=args.includes('cursor=next'),headRefOid=(phase==='head'&&later?'b':'a').repeat(40);
const nodes=later?[]:[{id:'thread',isResolved:false,comments:{nodes:[{url:'https://github.com/synthetic/threads/pull/7#discussion_1'}]}}];
const info=phase==='partial'?{hasNextPage:true,endCursor:null}:{hasNextPage:!later,endCursor:later?null:'next'};
process.stdout.write(JSON.stringify({data:{repository:{pullRequest:{url:'https://github.com/synthetic/threads/pull/7',headRefOid,reviewThreads:{nodes,pageInfo:info}}}}}));
`,{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;
const proof:Record<string,any>={verified:false,productionConsumerWired:false};
const calls=()=>readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const phase=(name:string)=>writeFileSync(join(run,'phase'),name);
const rows=()=>app!.db.getDatabase().prepare('SELECT subject,value_json,observed_at,reason FROM pack_coding_poll_facts').all();
const read=()=>createNeoCodingReaders(()=>app!.db.getDatabase()).readReviewThreads('https://github.com/synthetic/threads/pull/7',join(run,'home'));
async function start(){app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});}
try{
 await start();proof.runtime={commit:BUILD_METADATA.commit,pid:process.pid,port:app!.server.port};
 proof.cold=await Promise.all(Array.from({length:5},read));assert(proof.cold.every((r:any)=>r.ok));
 assert.deepEqual(proof.cold[0].data,{headOid:'a'.repeat(40),unresolvedThreadUrls:['https://github.com/synthetic/threads/pull/7#discussion_1']});
 assert.equal(calls().length,2);proof.coldAcquisitions=2;
 const prior=rows();assert.equal(prior.length,1);await app!.cleanup();app=undefined;await start();assert.deepEqual(rows(),prior);
 phase('repeat');assert((await read()).ok);const saved=rows()[0];
 for(const name of ['failed','partial-stderr','partial','head']){
  phase(name);const result=await read();assert.equal(result.ok,false);proof[name]=result;
  assert.equal(rows()[0].value_json,saved.value_json);assert.equal(rows()[0].observed_at,saved.observed_at);assert.equal(rows()[0].reason,name==='failed'||name==='partial-stderr'?'failed':'partial');
 }
 phase('recovered');assert((await read()).ok);assert.equal(rows()[0].reason,null);
 proof.counts=Object.fromEntries([...new Set(calls().map(r=>r.phase))].map(p=>[p,calls().filter(r=>r.phase===p).length]));
 assert.deepEqual(proof.counts,{cold:2,repeat:2,failed:1,'partial-stderr':1,partial:1,head:2,recovered:2});
 proof.historyPreserved=true;proof.verified=true;
 console.log(JSON.stringify({verified:true,coldAcquisitions:2,productionConsumerWired:false}));
}finally{
 await app?.cleanup();globalThis.fetch=network;proof.resourcesStopped=true;
 writeFileSync(join(run,'evidence/review-threads.json'),JSON.stringify(proof,null,2));
}
