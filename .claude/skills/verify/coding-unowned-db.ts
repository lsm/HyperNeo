import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
const [mode,directory]=process.argv.slice(2),run=resolve(directory);
assert(['before','verify'].includes(mode));assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const part of ['home','bin','evidence'])mkdirSync(join(run,part),{recursive:true});process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,measuring=false,accept=false,now=0;
const attempts:{key:string;text:string}[]=[],accepted=new Set<string>(),mainSql:string[]=[],commands:unknown[]=[];
const evidence:Record<string,any>={mode,verified:false,consumer:'Real persisted job -> production coding-pack sweep -> unowned wake pipeline',limitation:'Synthetic scheduled job and repository read; notification receiver records keys after checking commit. No actual Neo model, external notification, GitHub or GUI.'};
function fixture<T>(fn:()=>T):T{const prior=measuring;measuring=false;try{return fn();}finally{measuring=prior;}}
const rows=()=>fixture(()=>app!.db.getDatabase().prepare('SELECT * FROM pack_coding_pr_unowned ORDER BY key').all());
const state=()=>fixture(()=>app!.db.getDatabase().prepare('SELECT * FROM pack_coding_pr_unowned_state').get() as {pending_key:string|null;pending_rows:string|null});
async function open(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});
 const db=app.db.getDatabase(),prepare=db.prepare.bind(db),send=app.db.gateway.run.bind(app.db.gateway);
 db.prepare=((sql:string)=>{if(measuring&&/pack_coding_pr_unowned/.test(sql))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
 app.db.gateway.run=(async(op,args)=>{const start=performance.now(),reply=await send(op,args);if(op.name==='coding.unowned.commands')commands.push({name:op.name,method:(args as {method:string}).method,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(reply)??'null')});return reply;}) as typeof app.db.gateway.run;
 const activatedAt=fixture(()=>db.prepare('SELECT activated_at AS at FROM pack_coding_pr_unowned_state').get() as {at:number}).at;
 now=Date.now()+100;
 fixture(()=>db.prepare("UPDATE neo_pack_preferences SET value_json='[\"synthetic/unowned\"]' WHERE pack='coding' AND key='watchedRepos'").run());
 const node=(number:number,more:Record<string,unknown>={})=>({number,title:`Synthetic PR ${number}`,headRefName:`work-${number}`,headRefOid:`head-${number}`,state:'OPEN',isDraft:false,mergeable:'MERGEABLE',reviewDecision:null,closedAt:null,createdAt:new Date(activatedAt+1).toISOString(),author:{login:'synthetic',__typename:'User'},...more});
 const ledger=new CodingPrLedgerRepository(db);
 const pack=createCodingPack({database:()=>db,readPrs:async()=>[],readClaudeOwners:async()=>[],todoPrs:new CodingTodoPrRepository(db),prLedger:ledger,prEvents:new CodingPrEventRepository(db),prSweep:new CodingPrSweepRepository(db),projectRepos:()=>['synthetic/unowned'],readLedgerRepo:async()=>({data:{rateLimit:{remaining:4000},repository:{nameWithOwner:'synthetic/unowned',open:{pageInfo:{hasNextPage:false},nodes:[node(1),node(2),node(3,{isDraft:true}),node(4,{author:{login:'bot',__typename:'Bot'}}),node(5,{createdAt:new Date(activatedAt-1).toISOString()})]},done:{nodes:[]}}}}),prSweepDeps:{tell:async()=>{throw new Error('No owned PR delivery expected')},wake:async(key,text)=>{
  assert(text.includes('synthetic/unowned#1')&&text.includes('synthetic/unowned#2'));for(const n of [3,4,5])assert(!text.includes(`synthetic/unowned#${n}`));
  assert.equal(rows().length,2,'Reservation must commit before wake');assert.equal(state().pending_key,key,'Pending receipt must commit before wake');attempts.push({key,text});if(accept)accepted.add(key);return accept;
 }}});
 app.jobProcessor.register('verify.coding.unowned',async job=>{for(let i=0;i<Number(job.payload.count);i++)await pack.sweep!(now);return {completed:true}});
}
async function sweep(count=1){const job=app!.jobQueue.enqueue({queue:'verify.coding.unowned',payload:{count},maxRetries:0,priority:100});await app!.jobProcessor.start();try{for(let i=0;i<300;i++){const r=app!.jobQueue.getJob(job.id)!;if(r.status==='completed')return {status:r.status,result:r.result};if(r.error)throw new Error(r.error);await new Promise(done=>setTimeout(done,25));}throw new Error('Synthetic sweep job timed out');}finally{await app!.jobProcessor.stop();}}
try{
 await open();measuring=true;evidence.rejected=await sweep();assert.equal(attempts.length,1);assert.equal(accepted.size,0);assert(state().pending_key);const receipt=state(),listed=rows();
 evidence.retry=await sweep();assert.equal(attempts.length,2);assert.equal(attempts[0].key,attempts[1].key);assert.deepEqual(rows(),listed);
 measuring=false;await app!.cleanup();app=undefined;await open();assert.deepEqual(state(),receipt);assert.deepEqual(rows(),listed);measuring=true;
 accept=true;evidence.reopened=await sweep();assert.equal(attempts.length,3);assert.equal(accepted.size,1);assert.equal(state().pending_key,null);assert.deepEqual(rows(),listed);
 evidence.confirmed=await sweep(2);assert.equal(attempts.length,3);assert.equal(accepted.size,1);assert.equal(state().pending_key,null);
 if(mode==='verify')assert.deepEqual(mainSql,[],'Unowned reservation and confirmation SQL must leave main');else assert(mainSql.length>0,'Baseline must show unowned SQL on main');
 evidence.rows=rows();evidence.state=state();evidence.attempts=attempts;evidence.acceptedKeys=[...accepted];evidence.verified=true;
}finally{measuring=false;evidence.mainSql=mainSql;evidence.commands=commands;writeFileSync(join(run,'evidence/coding-unowned-db.json'),JSON.stringify(evidence,null,2));await app?.cleanup();globalThis.fetch=network;}
