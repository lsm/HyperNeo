import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { createGitHubService, type GitHubService } from '../../../packages/daemon/src/lib/github/github-service.ts';
import { createPollingService } from '../../../packages/daemon/src/lib/github/polling-service.ts';
import { handleGitHubPoll } from '../../../packages/daemon/src/lib/job-handlers/github-poll.handler.ts';
import { createDaemonInternalEventBus } from '../../../packages/daemon/src/lib/internal-event-bus.ts';
import { CodingPollFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/poll-facts.ts';
import type { GitHubPollCollector } from '../../../packages/daemon/src/lib/github/poll-source.ts';

const run=resolve(process.argv[2]),baseline=process.argv[3]==='baseline';
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));
for(const key of ['GH_TOKEN','GITHUB_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'])assert.equal(process.env[key],undefined);
for(const dir of ['bin','evidence'])mkdirSync(join(run,dir),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\necho refused >> "$HOME/../evidence/gh-refused.log"\nexit 1\n',{mode:0o700});writeFileSync(join(run,'bin/claude'),'#!/bin/sh\nprintf "[]\\n"\n',{mode:0o700});process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
let phase='cold',app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,collected=0;
const services:GitHubService[]=[],events:unknown[]=[],requests:{phase:string;url:string;conditional:boolean}[]=[];
const proof:Record<string,any>={verified:false,baseline,publicJobHandler:true,providerTurns:0};
const fixture=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 await Bun.sleep(20);const url=new URL(request.url);requests.push({phase,url:url.pathname+url.search,conditional:request.headers.has('if-none-match')});
 if(phase==='failed')return new Response('Synthetic unavailable',{status:503});
 const user={login:'synthetic-worker',type:'User'},data=phase==='events'?(url.pathname.endsWith('/comments')?{id:9,body:'Synthetic comment',user,issue_url:'https://api.github.com/repos/synthetic/legacy/issues/7'}:{id:7,number:7,title:'Synthetic issue',body:'Synthetic body',labels:[],user}):null;
 return Response.json(data?[data]:[],{headers:{etag:'"synthetic-page"','x-ratelimit-remaining':'100',authorization:'SYNTHETIC_OMIT_HEADER'}});
}});assert.notEqual(fixture.port,8399);
const network=globalThis.fetch;globalThis.fetch=((input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.origin,'https://api.github.com');assert(url.pathname.startsWith('/repos/synthetic/legacy/issues'));return network(`http://127.0.0.1:${fixture.port}${url.pathname}${url.search}`,init);}) as typeof fetch;
const collectPollPage:GitHubPollCollector=(...args)=>{collected++;return new CodingPollFactsRepository(app!.db.getDatabase(),60000).collectExternalEventPage(...args);};
const token='synthetic-transport-only';
const rows=()=>app!.db.getDatabase().prepare('SELECT subject,value_json,observed_at,reason,http_json FROM pack_coding_poll_facts ORDER BY subject').all() as {subject:string;value_json:string;observed_at:number;reason:string|null;http_json:string|null}[];
const makeService=()=>{const service=createGitHubService({db:app!.db,internalEventBus:createDaemonInternalEventBus(),config:getConfig({port:0}),apiKey:'',githubToken:token,jobQueue:app!.db.getJobQueueRepo(),jobProcessor:app!.jobProcessor,getPollingIntervalSeconds:()=>60,...(baseline?{}:{collectPollPage})});services.push(service);service.start();service.getPollingService()!.addRepository('synthetic','legacy');return service;};
const poll=async(service:GitHubService)=>{const result=await handleGitHubPoll({pollingService:service.getPollingService(),jobQueue:app!.db.getJobQueueRepo(),intervalMs:60000});assert(result.polled);};
const ghCalls=()=>existsSync(join(run,'evidence/gh-refused.log'))?readFileSync(join(run,'evidence/gh-refused.log'),'utf8'):'';
async function start(){app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);app.db.updateGlobalSettings({neo:{packs:[]}});}
try{
 await start();proof.runtime={commit:BUILD_METADATA.commit,pid:process.pid,port:app!.server.port};const ghBefore=ghCalls();const first=makeService();await poll(first);assert.equal(requests.length,2);assert.equal(collected,baseline?0:2);assert.equal(rows().length,baseline?0:2);
 phase='repeat';await poll(first);assert.equal(requests.filter(r=>r.phase===phase).length,2);
 phase='concurrent';const before=collected;await Promise.all([poll(makeService()),poll(makeService())]);assert.equal(requests.filter(r=>r.phase===phase).length,baseline?4:2);assert.equal(collected-before,baseline?0:4);
 if(!baseline){
  const prior=rows().find(r=>JSON.parse(r.subject)[1]==='https://api.github.com/repos/synthetic/legacy/issues')!;const failing=makeService();phase='failed';await poll(failing);const failed=rows().find(r=>r.subject===prior.subject)!;assert.equal(failed.reason,'failed');assert.equal(failed.value_json,prior.value_json);assert.equal(failed.observed_at,prior.observed_at);
  phase='recovered';await poll(failing);assert(requests.filter(r=>r.phase===phase).every(r=>!r.url.includes('?')));
  phase='events';const raw=createPollingService({token,collectPollPage},event=>{events.push(event);});raw.start();raw.addRepository('synthetic','legacy');try{await raw.triggerPoll();}finally{raw.stop();}assert.deepEqual(events.map((e:any)=>[e.source,e.eventType]),[['polling','issues'],['polling','issue_comment']]);
  const stored=JSON.stringify(rows());assert(!stored.includes(token));assert(!stored.includes('SYNTHETIC_OMIT'));const saved=rows();for(const s of services)s.stop();await app!.cleanup();app=undefined;phase='restart';await start();assert.deepEqual(rows(),saved);await poll(makeService());assert.equal(requests.filter(r=>r.phase===phase).length,2);
 }
 assert.equal(ghCalls(),ghBefore);proof.counts=Object.fromEntries([...new Set(requests.map(r=>r.phase))].map(p=>[p,requests.filter(r=>r.phase===p).length]));proof.events=events;proof.collected=collected;proof.uniqueColdAndRepeatReads=[2,2];proof.verified=true;console.log(JSON.stringify({verified:true,baseline,counts:proof.counts}));
}finally{for(const s of services)s.stop();await app?.cleanup();await fixture.stop(true);globalThis.fetch=network;proof.resourcesStopped=true;writeFileSync(join(run,'evidence/legacy-polling.json'),JSON.stringify(proof,null,2));writeFileSync(join(run,'evidence/requests.json'),JSON.stringify(requests,null,2));}
