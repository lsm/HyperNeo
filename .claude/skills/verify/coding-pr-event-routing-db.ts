import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrEventRepository, deliverCodingPrEvents } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert(['before', 'verify'].includes(mode));assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const part of ['home','bin','evidence'])mkdirSync(join(run,part),{recursive:true});process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,measuring=false,accept=false,changeOwner=false;
const owner={adapter:'codex-desktop',id:'synthetic-owner'}, successor={adapter:'codex-desktop',id:'synthetic-successor'};
const row={repo:'synthetic/events',number:1,title:'Synthetic PR',body:'Large immutable event body 甲乙🙂\n'.repeat(5000),branch:'work',head:'head',state:'merged',from:'waiting_ci',closedAt:1};
const attempts:{key:string;text:string;owner:unknown}[]=[],mainSql:string[]=[],commands:unknown[]=[];
const evidence:Record<string,any>={mode,verified:false,consumer:'Real persisted daemon jobs run the production PR-event delivery pipeline',limitation:'Synthetic pending ledger event and notification receiver, no actual Neo mailbox, GitHub, model, GUI or entire pack sweep. No latency target claim.'};
function fixture<T>(fn:()=>T):T{const prior=measuring;measuring=false;try{return fn();}finally{measuring=prior;}}
const state=()=>fixture(()=>app!.db.getDatabase().prepare('SELECT terminal_event_json AS event,owner,told_at AS at FROM pack_coding_pr_ledger WHERE repo=? AND number=?').get(row.repo,row.number) as {event:string|null;owner:string;at:number|null});
function seed(){fixture(()=>app!.db.getDatabase().prepare(`INSERT INTO pack_coding_pr_ledger
(repo,number,title,branch,head,state,state_since,read_at,closed_at,owner,terminal_event_json)
VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo,number) DO UPDATE SET terminal_event_json=excluded.terminal_event_json,owner=excluded.owner,told_at=NULL`).run(row.repo,row.number,row.title,row.branch,row.head,row.state,1,1,1,JSON.stringify(owner),JSON.stringify(row)));}
function watch(enabled:boolean){fixture(()=>app!.db.getDatabase().prepare("UPDATE neo_pack_preferences SET value_json=? WHERE pack='coding' AND scope_kind='global' AND key='watchedRepos'").run(JSON.stringify(enabled?[row.repo]:[])));}
async function open(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});
 const db=app.db.getDatabase(),prepare=db.prepare.bind(db),send=app.db.gateway.run.bind(app.db.gateway);
 db.prepare=((sql:string)=>{if(measuring&&/pack_coding_pr_ledger|neo_pack_preferences|pack_coding_repo_aliases/.test(sql))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
 app.db.gateway.run=(async(op,args)=>{const start=performance.now(),reply=await send(op,args);if(op.name==='coding.prEvent.reads'||(op.name==='coding.ledgerWrites'&&(args as {method:string}).method==='acceptTerminalEvent'))commands.push({name:op.name,method:(args as {method:string}).method,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(reply)??'null')});return reply;}) as typeof app.db.gateway.run;
 const events=new CodingPrEventRepository(db);
 const deps={tell:async(ref:unknown,key:string,text:string)=>{
   const before=state();assert(before.event,'Event must remain durable until external receiver accepts');assert.equal(before.owner,JSON.stringify(ref));assert(text.includes('was merged'));attempts.push({key,text,owner:ref});
   if(changeOwner){changeOwner=false;fixture(()=>db.prepare('UPDATE pack_coding_pr_ledger SET owner=? WHERE repo=? AND number=?').run(JSON.stringify(successor),row.repo,row.number));}
   return accept;
 },wake:async()=>{throw new Error('No unowned wake expected');}};
 app.jobProcessor.register('verify.coding.pr-event-routing',async job=>{await Promise.all(Array.from({length:Number(job.payload.count)},()=>deliverCodingPrEvents(events,[],deps)));return {completed:true};});
}
async function deliver(count=1){const job=app!.jobQueue.enqueue({queue:'verify.coding.pr-event-routing',payload:{count},maxRetries:0,priority:100});await app!.jobProcessor.start();try{for(let i=0;i<300;i++){const r=app!.jobQueue.getJob(job.id)!;if(r.status==='completed')return {status:r.status,result:r.result};if(r.error)throw new Error(r.error);await new Promise(done=>setTimeout(done,25));}throw new Error('Synthetic delivery job timed out');}finally{await app!.jobProcessor.stop();}}
try{
 await open();seed();watch(true);measuring=true;
 evidence.rejected=await deliver();assert.equal(attempts.length,1);assert(state().event);const retained=state();
 evidence.retry=await deliver();assert.equal(attempts.length,2);assert.equal(attempts[0].key,attempts[1].key);assert.deepEqual(state(),retained);
 measuring=false;await app!.cleanup();app=undefined;await open();assert.deepEqual(state(),retained);measuring=true;
 accept=true;evidence.reopened=await deliver(2);assert.equal(attempts.length,3);assert.equal(state().event,null);assert(state().at);assert.deepEqual(attempts[2],attempts[0]);
 await deliver();assert.equal(attempts.length,3);
 seed();watch(false);await deliver();assert.equal(attempts.length,3);assert(state().event);
 watch(true);changeOwner=true;await deliver();assert.equal(attempts.length,4);assert(state().event,'Old owner acknowledgement must not clear a new owner event');assert.equal(state().owner,JSON.stringify(successor));
 await deliver(2);assert.equal(attempts.length,5);assert.deepEqual(attempts[4].owner,successor);assert.equal(state().event,null);await deliver();assert.equal(attempts.length,5);
 if(mode==='verify'){assert.deepEqual(mainSql,[],'PR pending events, owner routing and watch SQL must leave main');assert(commands.some((op:any)=>op.method==='route'));}else assert(mainSql.length>0,'Baseline must reproduce PR event routing SQL on main');
 evidence.immutableEventBodyBytes=Buffer.byteLength(row.body);evidence.attempts=attempts;evidence.finalState=state();evidence.verified=true;
}finally{measuring=false;evidence.mainSql=mainSql;evidence.commands=commands;writeFileSync(join(run,'evidence/coding-pr-event-routing-db.json'),JSON.stringify(evidence,null,2));await app?.cleanup();globalThis.fetch=network;}
