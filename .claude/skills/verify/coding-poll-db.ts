import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createPollingGitFixture } from './github-poll-git.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import type { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { CodingPollFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/poll-facts.ts';

const [mode,directory]=process.argv.slice(2);assert(['before','verify'].includes(mode));
const run=resolve(directory);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));
assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const dir of ['bin','evidence','home/a','home/b'])mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const when=Date.now()-10000,head=createPollingGitFixture(run,['synthetic/shared']);
const control=(phase:string)=>writeFileSync(join(run,'phase'),phase);control('initial');
writeFileSync(join(run,'bin/gh'),`#!/usr/bin/env bun
import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(run)},args=process.argv.slice(2),phase=readFileSync(root+'/phase','utf8');
if(args[0]!=='api'||!args.includes('--include')){appendFileSync(root+'/evidence/unsupported.jsonl',JSON.stringify({phase,args})+'\\n');process.exit(2);}
const path=args.find(a=>a.startsWith('/repos/')||a==='/user');if(!path)process.exit(2);
const url=new URL(path,'https://api.github.com'),conditional=args.some(a=>a.startsWith('If-None-Match:'));
const status=phase==='failed'&&path!=='/user'?503:phase==='repeat'&&conditional?304:200;
let body=[];
const at=new Date(${when}+(phase==='recovered'?1000:0)).toISOString(),head=${JSON.stringify(head)};
if(path==='/user')body={login:'synthetic-human'};
else if(url.pathname==='/repos/synthetic/shared')body={default_branch:'main'};
else if(url.pathname==='/repos/synthetic/shared/git/ref/heads/main')body={object:{sha:head}};
else if(url.pathname.endsWith('/check-runs'))body={check_runs:[]};
else if(url.pathname.endsWith('/reviews'))body=[{id:phase==='recovered'?42:41,state:'APPROVED',commit_id:head,body:'Synthetic approval',submitted_at:at,html_url:'https://github.com/synthetic/shared/pull/7#review',user:{login:'synthetic-reviewer'}}];
else if(/\\/pulls\\/7$/.test(url.pathname))body={number:7,state:'open',mergeable:true,head:{sha:head}};
else if(url.pathname.endsWith('/pulls'))body=[{number:7,state:'open',updated_at:at,created_at:at,html_url:'https://github.com/synthetic/shared/pull/7',head:{sha:head},user:{login:'synthetic-author'}}];
if(status===503)body={message:'Synthetic unavailable'};
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase,path,status,conditional,bodyBytes:status===304?0:Buffer.byteLength(JSON.stringify(body))})+'\\n');
process.stdout.write('HTTP/2.0 '+status+' Synthetic\\r\\nETag: "pin"\\r\\nX-RateLimit-Remaining: 4900\\r\\nX-RateLimit-Limit: 5000\\r\\nX-RateLimit-Resource: core\\r\\nAuthorization: SYNTHETIC_OMIT_HEADER\\r\\nSet-Cookie: SYNTHETIC_OMIT_COOKIE\\r\\nContent-Type: application/json\\r\\n\\r\\n'+(status===304?'':JSON.stringify(body)));
process.exitCode=status>=400||status===304?1:0;
`,{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined;
let measuring=false,maxLagMs=0,last=performance.now();
const mainSql:string[]=[],commands:Record<string,unknown>[]=[],rpcMetrics:Record<string,unknown>[]=[];
const timer=setInterval(()=>{const at=performance.now();if(measuring)maxLagMs=Math.max(maxLagMs,at-last-10);last=at;},10);
let outstanding:Promise<unknown>|undefined,lock:ReturnType<typeof spawn>|undefined,release:((response:Response)=>void)|undefined;
const evidence:Record<string,any>={mode,cycles:[],head};
const waiting=new Map<string,{done:(value:any)=>void;fail:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const db=()=>app!.db.getDatabase();
const rows=()=>db().prepare('SELECT * FROM pack_coding_poll_facts ORDER BY subject').all() as Record<string,any>[];
const requests=()=>readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
async function open(){
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
 await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const main=db(),prepare=main.prepare.bind(main);
 main.prepare=((sql:string)=>{if(measuring&&sql.includes('pack_coding_poll_facts'))mainSql.push(sql);return prepare(sql);}) as typeof main.prepare;
 const send=app.db.gateway.run.bind(app.db.gateway);
 app.db.gateway.run=(async(op,args)=>{const start=performance.now(),value=await send(op,args);if(op.name.startsWith('coding.pollPage.'))commands.push({operation:op.name,method:(args as {method?:string}).method,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value)??'null')});return value;}) as typeof app.db.gateway.run;
 ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
 await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('RPC unavailable'));});
 ws.onmessage=event=>{const msg=JSON.parse(String(event.data)),id=waiting.has(msg.requestId)?msg.requestId:msg.id,held=waiting.get(id);if(!held)return;waiting.delete(id);clearTimeout(held.timer);if(msg.error)held.fail(new Error(JSON.stringify(msg.error)));else held.done(msg.data);};
}
const rpc=(method:string,data:unknown={})=>new Promise<any>((done,fail)=>{
 const start=performance.now(),id=crypto.randomUUID(),timer=setTimeout(()=>{waiting.delete(id);fail(new Error('RPC deadline'));},30000);
 waiting.set(id,{done:value=>{if(measuring)rpcMetrics.push({name:method,durationMs:performance.now()-start});done(value);},fail,timer});
 ws!.send(JSON.stringify({id,type:'REQ',method,data,sessionId:'global',timestamp:new Date().toISOString(),version:'1.0.0'}));
});
const poll=async()=>{measuring=true;try{return await rpc('space.github.pollOnce');}finally{measuring=false;}};
const approvals=()=>db().prepare("SELECT id,space_id,topic,payload_json FROM space_external_events WHERE topic LIKE 'github/synthetic/shared/pull_request/7.review_submitted'").all() as Record<string,any>[];
const legacyKey='["pre-existing-unscoped"]';
try{
 await open();app!.db.updateGlobalSettings({neo:{packs:[]}});
 const github=app!.extensionManager.getExtension('github') as GitHubEventExtension;
 const spaces=['a','b'].map(name=>new SpaceRepository(db()).createSpace({name:`Synthetic ${name}`,slug:`synthetic-${name}`,workspacePath:join(run,'home',name)}));
 for(const space of spaces){const row=github.repo.upsertWatchedRepo({spaceId:space.id,owner:'synthetic',repo:'shared',pollingEnabled:true});db().prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(JSON.stringify({lastSeenAt:when-3600000,recentPullRequestNumbers:[7],recentPullRequestHeadShas:{7:head},etags:{issue_comments:'"pin"',review_comments:'"pin"',pulls:'"pin"'},selfLogin:'synthetic-human'}),row.id);}
 await new ExternalEventExtensionConfigStore(db()).setGlobalConfig('github',{source:'github',globallyEnabled:true,capabilities:{polling:true,rpcConfig:true}});
 db().prepare('INSERT INTO pack_coding_poll_facts(subject,fact_revision,observation_revision,value_json,observed_at,attempted_at) VALUES(?,?,?,?,?,?)').run(legacyKey,3,5,' { "kept" : true } ',100,110);
 const legacy=rows().find(row=>row.subject===legacyKey);
 for(const phase of ['initial','repeat','failed','recovered','expired']){
  control(phase);
  if(phase==='expired')db().prepare("UPDATE pack_coding_poll_facts SET attempted_at=? WHERE json_extract(subject,'$[0]') GLOB 'external-event-page:v1:*'").run(Date.now()-16*60000);
  const reply=await poll(),watched=[];
  for(const space of spaces)watched.push(await rpc('space.github.listWatchedRepos',{spaceId:space.id}));
  const events=approvals(),pages=rows();evidence.cycles.push({phase,reply,watched,events,pages});
  assert.deepEqual(pages.find(row=>row.subject===legacyKey),legacy);if(phase==='expired')assert(pages.length<=10,'Expired raw pages must stay bounded');
  assert.equal(new Set(events.map(event=>event.id)).size,events.length);
  for(const space of spaces)assert.equal(events.filter(event=>event.space_id===space.id).length,['recovered','expired'].includes(phase)?2:1);
  for(const event of events)assert.equal(JSON.parse(event.payload_json).commitId,head);
  if(phase==='failed'){
   assert.equal(reply.errors,2);assert(pages.some(page=>page.reason==='failed'));
   for(let i=0;i<watched.length;i++){const current=watched[i].repositories[0],prior=evidence.cycles[1].watched[i].repositories[0];assert.equal(current.lastPollAt,prior.lastPollAt);assert.equal(current.pollCursor.lastSeenAt,prior.pollCursor.lastSeenAt);assert.match(current.pollCursor.lastPollError,/Synthetic unavailable/);}
   const prior=evidence.cycles[1].pages.filter((row:any)=>row.subject!==legacyKey);
   for(const saved of pages.filter(row=>row.reason==='failed')){const before=prior.find((row:any)=>row.subject===saved.subject);if(before){assert.equal(saved.value_json,before.value_json);assert.equal(saved.observed_at,before.observed_at);}}
  }else assert.equal(reply.errors,undefined);
  assert(!JSON.stringify(pages).includes('SYNTHETIC_OMIT'));
 }
 const observed=requests();assert.equal(observed.filter(r=>r.phase==='initial'&&r.path.includes('/pulls/7/reviews')).length,1);
 assert(observed.some(r=>r.phase==='repeat'&&r.status===304));assert(observed.some(r=>r.phase==='failed'&&r.status===503));
 assert(!observed.some(r=>['initial','expired'].includes(r.phase)&&r.path!=='/user'&&r.conditional),'Cold or expired validators cannot certify coverage');
 const saved=rows();ws!.close();await app!.cleanup();app=undefined;await open();assert.deepEqual(rows(),saved);
 control('reopen');const reopened=await poll();assert.equal(reopened.errors,undefined);assert.equal(approvals().length,4);evidence.reopened={reply:reopened,events:approvals(),pages:rows()};
 if(mode==='verify'){
  const facts=new CodingPollFactsRepository(db());
  const subject={credentialId:'opaque-synthetic-race',url:'https://api.github.com/repos/synthetic/shared/late',accept:'application/vnd.github+json',apiVersion:'2022-11-28'};
  let started!:()=>void;const ready=new Promise<void>(done=>{started=done;});const gate=new Promise<Response>(done=>{release=done;});
  measuring=true;const late=facts.collect(subject,'old-cycle',null,async()=>{started();return gate;});outstanding=late;await ready;
  const winner=await facts.observeCurrent(subject,{value:[{id:2}],etag:'"winner"',next:null,http:{cycle:'new-cycle',status:200,headers:{}}},Date.now(),0);assert(winner.accepted);
  release!(Response.json([{id:1}]));await assert.rejects(late,/superseded/);outstanding=undefined;
  const loser=await facts.observeCurrent(subject,{reason:'failed'},Date.now(),0);assert.equal(loser.accepted,false);assert.deepEqual(loser.facts,winner.facts);assert.equal(winner.facts.observationRevision,1);
  evidence.fence={winner,loserAccepted:loser.accepted};measuring=false;
  lock=spawn('/usr/bin/python3',['-c',"import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()",join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
  const unlocked=new Promise<void>((done,fail)=>{lock!.once('error',fail);lock!.once('exit',code=>code===0?done():fail(new Error('synthetic lock failed')));});await new Promise<void>(done=>lock!.stdout!.once('data',()=>done()));
  measuring=true;const begin=performance.now(),held=facts.collectExternalEventPage({...subject,url:subject.url+'/held'},'held-cycle',null,async()=>{await new Promise(done=>setTimeout(done,300));return Response.json([{id:3}]);});outstanding=held;
  await new Promise(done=>setTimeout(done,400));const healthStart=performance.now();evidence.health=await rpc('system.health');const healthMs=performance.now()-healthStart;
  assert.deepEqual(await (await held).json(),[{id:3}]);outstanding=undefined;const collectionMs=performance.now()-begin;await unlocked;lock=undefined;
  evidence.contention={healthMs,collectionMs,affectedCollectionUnder250ms:collectionMs<250};assert(healthMs<250);assert(collectionMs>1200);assert(maxLagMs<1000);
  assert.equal(mainSql.length,0,'HTTP page snapshot, admission, persistence and cleanup must leave main');assert(commands.some(command=>command.method==='prune'));assert(commands.some(command=>command.method==='observe'));
 }else assert(mainSql.length>0,'Baseline must reproduce poll-page SQL on main');
 evidence.verified=true;console.log(JSON.stringify({verified:true,cycles:evidence.cycles.map((cycle:any)=>({phase:cycle.phase,events:cycle.events.length}))}));
}finally{
 measuring=false;release?.(Response.json([]));lock?.kill();await outstanding?.catch(()=>{});clearInterval(timer);
 evidence.mainSql=mainSql;evidence.commands=commands;evidence.rpcMetrics=rpcMetrics;evidence.maxLagMs=maxLagMs;
 if(existsSync(join(run,'evidence/requests.jsonl')))evidence.requests=requests();
 writeFileSync(join(run,'evidence/coding-poll-db.json'),JSON.stringify(evidence,null,2));
 for(const held of waiting.values())clearTimeout(held.timer);waiting.clear();ws?.close();await app?.cleanup();globalThis.fetch=network;
}
