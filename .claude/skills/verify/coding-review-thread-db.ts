import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPollFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/poll-facts.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
for (const folder of ['home', 'bin', 'evidence']) mkdirSync(join(run, folder), { recursive: true });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const url = 'https://github.com/synthetic/threads/pull/7', head = 'a'.repeat(40);
const control = (phase: string) => writeFileSync(join(run, 'phase'), phase);
control('cold'); writeFileSync(join(run, 'late-release'), 'waiting');
writeFileSync(join(run, 'bin/gh'), String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root=dirname(dirname(process.argv[1])),args=process.argv.slice(2),phase=readFileSync(join(root,'phase'),'utf8');
const family=args[0]==='pr'?args[1]:args.includes('graphql')?'threads':args.some(a=>a.endsWith('/reviews'))?'reviews':null;
appendFileSync(join(root,'evidence/requests.jsonl'),JSON.stringify({phase,family,args})+'\n');
if(family==='view')console.log(JSON.stringify({url:args[2],body:'Synthetic',state:'OPEN',headRefOid:'a'.repeat(40),isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',author:{login:'synthetic'},changedFiles:1,files:[{path:'src/synthetic.ts'}],labels:[]}));
else if(family==='checks')console.log('[]');
else if(family==='reviews')console.log('[[]]');
else if(family==='threads'){
 const later=args.includes('cursor=next');
 if(phase==='late'&&!later){appendFileSync(join(root,'late-start'),'ready');while(readFileSync(join(root,'late-release'),'utf8')!=='release')await Bun.sleep(10);}
 await Bun.sleep(150);
 if(phase==='failed'){process.stderr.write('Synthetic unavailable');process.exit(1);}
 const info=phase==='partial'?{hasNextPage:true,endCursor:null}:{hasNextPage:!later,endCursor:later?null:'next'};
 console.log(JSON.stringify({data:{repository:{pullRequest:{url:'https://github.com/synthetic/threads/pull/7',headRefOid:(phase==='head-change'&&later?'b':'a').repeat(40),reviewThreads:{nodes:later?[]:[{id:'thread',isResolved:false,comments:{nodes:[{url:'https://github.com/synthetic/threads/pull/7#finding'}]}}],pageInfo:info}}}}}));
}else{process.stderr.write('Unsupported synthetic request');process.exit(2);}
`, { mode: 0o700 });
const subject = { credentialId:'github-connector', url, accept:'application/vnd.hyperneo.pr-review-threads+json', apiVersion:'v1' };
const evidence: Record<string, any> = { mode, verified:false, consumer:'neo.coding.merge.prepare RPC', limitation:'No assignments are seeded: merge admission refuses after reading GitHub facts; no merge or model turn is attempted.' };
const mainSql: string[] = [], commands: Record<string,unknown>[] = [], rpcMetrics: Record<string,unknown>[] = [];
let measuring=false, maxLagMs=0, last=performance.now();
const timer=setInterval(()=>{const t=performance.now();if(measuring)maxLagMs=Math.max(maxLagMs,t-last-10);last=t;},10);
let app: Awaited<ReturnType<typeof createDaemonApp>>|undefined, ws:WebSocket|undefined, lock:ReturnType<typeof spawn>|undefined, outstanding:Promise<any>|undefined;
const pending=new Map<string,{done:(v:any)=>void;fail:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
async function open(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
 await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const db=app.db.getDatabase(),prepare=db.prepare.bind(db);
 db.prepare=((sql:string)=>{if(measuring&&(/pack_coding_poll_facts/.test(sql)||(/pack_coding_repo_aliases/.test(sql)&&new Error().stack?.includes('/connector-pr-reader.ts'))))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
 const send=app.db.gateway.run.bind(app.db.gateway);
 app.db.gateway.run=(async(op,args)=>{const start=performance.now(),value=await send(op,args);if(op.name.startsWith('coding.pollPage.')||op.name==='coding.connector.identity')commands.push({operation:op.name,method:(args as {method?:string}).method,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value)??'null')});return value;}) as typeof app.db.gateway.run;
 ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
 await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('connect'));});
 ws.onmessage=event=>{const msg=JSON.parse(String(event.data)),id=pending.has(msg.requestId)?msg.requestId:msg.id,p=pending.get(id);if(!p)return;pending.delete(id);clearTimeout(p.timer);if(msg.error)p.fail(new Error(JSON.stringify(msg.error)));else p.done(msg.data);};
}
function rpc(health=false, target=url){return new Promise<any>((done,fail)=>{
 const id=crypto.randomUUID(),start=performance.now(),timeout=setTimeout(()=>{pending.delete(id);fail(new Error('RPC timeout'));},15000);
 pending.set(id,{done:value=>{rpcMetrics.push({health,durationMs:performance.now()-start});done(value);},fail,timer:timeout});
 ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:health?'system.health':'operation.invoke',data:health?{}:{name:'neo.coding.merge.prepare',input:{todoId:'synthetic-unassigned',url:target}},timestamp:new Date().toISOString(),version:'1.0.0'}));
});}
function fixture<T>(fn:()=>T):T{const before=measuring;measuring=false;try{return fn();}finally{measuring=before;}}
const rows=()=>fixture(()=>app!.db.getDatabase().prepare('SELECT * FROM pack_coding_poll_facts').all() as Record<string,any>[]);
const requests=()=>readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const count=(phase:string)=>requests().filter(r=>r.phase===phase&&r.family==='threads').length;
try{
 await open();measuring=true;
 evidence.cold=await Promise.all(Array.from({length:5},()=>rpc()));assert(evidence.cold.every((r:any)=>r.accepted===false));assert.equal(count('cold'),2);assert.equal(rows().length,1);assert.equal(rows()[0].observation_revision,1);
 control('repeat');await rpc();assert.equal(count('repeat'),2);assert.equal(rows()[0].fact_revision,1);assert.equal(rows()[0].observation_revision,2);
 const prior=rows()[0];
 for(const phase of ['failed','partial','head-change']){control(phase);evidence[phase]=await rpc();assert.equal(evidence[phase].accepted,false);const saved=rows()[0];assert.equal(saved.value_json,prior.value_json);assert.equal(saved.observed_at,prior.observed_at);assert.equal(saved.reason,phase==='failed'?'failed':'partial');}
 control('recovered');await rpc();assert.equal(rows()[0].reason,null);
 fixture(()=>app!.db.getDatabase().prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)').run('old/repo','synthetic/threads'));
 control('alias');await rpc(false,'https://github.com/OLD/REPO/pull/7');assert.equal(count('alias'),2);assert.equal(rows().length,1);
 const retained=rows();measuring=false;ws!.close();await app!.cleanup();app=undefined;await open();assert.deepEqual(rows(),retained);
 measuring=true;control('reopen');await rpc();assert.equal(rows()[0].observation_revision,retained[0].observation_revision+1);
 if(mode==='verify'){
  const facts=new CodingPollFactsRepository(app!.db.getDatabase()),before=rows()[0];control('late');outstanding=rpc();
  for(let i=0;!existsSync(join(run,'late-start'));i++){assert(i<500,'late acquisition did not start');await new Promise(done=>setTimeout(done,10));}
  const winner=await facts.observeCurrent(subject,{value:{headOid:head,unresolvedThreadUrls:['winner']},etag:null,next:null},Date.now(),before.observation_revision);assert(winner.accepted);
  writeFileSync(join(run,'late-release'),'release');evidence.late=await outstanding;outstanding=undefined;assert.equal(evidence.late.accepted,false);assert.equal(rows()[0].observation_revision,winner.facts.observationRevision);assert.deepEqual(JSON.parse(rows()[0].value_json),{headOid:head,unresolvedThreadUrls:['winner']});
  const loser=await facts.observeCurrent(subject,{reason:'failed'},Date.now(),before.observation_revision);assert.equal(loser.accepted,false);assert.deepEqual(loser.facts,winner.facts);evidence.fence={winner,loser};
  measuring=false;lock=spawn('/usr/bin/python3',['-c',"import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()",join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
  const unlocked=new Promise<void>((done,fail)=>{lock!.once('error',fail);lock!.once('exit',code=>code===0?done():fail(new Error('synthetic lock failed')));});await new Promise<void>(done=>lock!.stdout!.once('data',()=>done()));
  measuring=true;control('held');const start=performance.now();outstanding=rpc();await new Promise(done=>setTimeout(done,400));const healthStart=performance.now();evidence.health=await rpc(true);const healthMs=performance.now()-healthStart;await outstanding;outstanding=undefined;const affectedMs=performance.now()-start;await unlocked;lock=undefined;
  evidence.contention={healthMs,affectedMs,affectedOperationUnder250ms:affectedMs<250};assert(healthMs<250);assert(affectedMs>1000);assert(maxLagMs<1000);
  assert.equal(mainSql.length,0,'review-thread identity, snapshot and admission SQL must leave main');
 }else assert(mainSql.length>0,'baseline must reproduce target SQL on main');
 evidence.rows=rows();evidence.counts=Object.fromEntries([...new Set(requests().map(r=>r.phase))].map(phase=>[phase,count(phase)]));evidence.verified=true;
}finally{
 measuring=false;writeFileSync(join(run,'late-release'),'release');lock?.kill();await outstanding?.catch(()=>{});clearInterval(timer);
 evidence.mainSql=mainSql;evidence.commands=commands;evidence.rpcMetrics=rpcMetrics;evidence.maxLagMs=maxLagMs;
 if(existsSync(join(run,'evidence/requests.jsonl')))evidence.requests=requests();
 writeFileSync(join(run,'evidence/coding-review-thread-db.json'),JSON.stringify(evidence,null,2));
 for(const p of pending.values())clearTimeout(p.timer);pending.clear();ws?.close();await app?.cleanup();globalThis.fetch=network;
}
