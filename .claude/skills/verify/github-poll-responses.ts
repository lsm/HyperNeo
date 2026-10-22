import assert from 'node:assert/strict';
import { createPollingGitFixture } from './github-poll-git.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { SessionEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/session-event-subscription-repository.ts';

const [mode, text] = process.argv.slice(2), run = resolve(text);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
mkdirSync(join(run, 'bin')); mkdirSync(join(run, 'evidence'));
const when = Date.now() - 10_000;
const defaultHead = createPollingGitFixture(run, ['synthetic/conditional', 'synthetic/large']);
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}
const fs=require('node:fs'),root=${JSON.stringify(run)},args=process.argv.slice(2);
if(args[0]!=='api'||!args.includes('--include')) process.exit(2);
const path=args.find(a=>a.startsWith('/repos/')||a==='/user'); if(!path)process.exit(2);
const url=new URL(path,'https://api.github.com'),conditional=args.some(a=>a.startsWith('If-None-Match:'));
const status=conditional?304:200,repo=url.pathname.split('/')[3];let body=[];
if(path==='/user')body={login:'synthetic-human'};
else if(/^\\/repos\\/synthetic\\/(conditional|large)$/.test(url.pathname))body={default_branch:'main'};
else if(url.pathname.endsWith('/git/ref/heads/main'))body={object:{sha:${JSON.stringify(defaultHead)}}};
else if(url.pathname.endsWith('/check-runs'))body={check_runs:[]};
else if(/\\/pulls\\/7$/.test(url.pathname))body={number:7,state:'open',mergeable:true,head:{sha:'a'.repeat(40)}};
else if(repo==='large'&&url.pathname.endsWith('/pulls/comments')&&url.searchParams.get('page')!=='2') {
 body=Array.from({length:100},(_,i)=>({id:1000+i,body:'Synthetic '+i+' '+ 'x'.repeat(16_384),commit_id:'a'.repeat(40),pull_request_url:'https://github.com/synthetic/large/pull/7',html_url:'https://github.com/synthetic/large/pull/7#discussion_r'+i,user:{login:'synthetic-reviewer'},created_at:new Date(${when}).toISOString(),updated_at:new Date(${when}).toISOString()}));
}
const data=status===304?'':JSON.stringify(body);
fs.appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({repo,path,status,bytes:Buffer.byteLength(data),conditional})+'\\n');
await new Promise(done=>process.stdout.write('HTTP/2.0 '+status+' Synthetic\\r\\nETag: "fixture"\\r\\nX-RateLimit-Remaining: 4900\\r\\nX-RateLimit-Limit: 5000\\r\\nX-RateLimit-Resource: core\\r\\nContent-Type: application/json\\r\\n\\r\\n'+data,done));
process.exitCode=status===304?1:0;
`, {mode:0o700});
const network = globalThis.fetch;
globalThis.fetch = (()=>{throw new Error('Real HTTP refused');}) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const evidence: Record<string, unknown> = {mode,cycles:[]};
try {
 app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
 await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const db=app.db.getDatabase(),github=app.extensionManager.getExtension('github') as GitHubEventExtension;
 app.db.createSession({id:'owner',title:'Synthetic owner',workspacePath:join(run,'home'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
 const subscriptions=new SessionEventSubscriptionRepository(db);
 for(const repo of ['conditional','large']) {
  const row=github.repo.upsertWatchedRepo({spaceId:'sessions',owner:'synthetic',repo,pollingEnabled:true});
  subscriptions.upsert({sessionId:'owner',topic:'github/synthetic/'+repo+'/pull_request/7.*'});
  if(repo==='conditional')db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(JSON.stringify({lastSeenAt:when-3600_000,etags:{issue_comments:'"fixture"',review_comments:'"fixture"',pulls:'"fixture"'},recentPullRequestNumbers:[7],recentPullRequestHeadShas:{7:'a'.repeat(40)}}),row.id);
 }
 await new ExternalEventExtensionConfigStore(db).setGlobalConfig('github',{source:'github',globallyEnabled:true,capabilities:{polling:true,rpcConfig:true}});
 ws=new WebSocket('ws://127.0.0.1:'+app.server.port+'/ws');
 await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('RPC unavailable'));});
 const poll=()=>new Promise<unknown>((done,fail)=>{
  const id=crypto.randomUUID(),timer=setTimeout(()=>fail(new Error('RPC deadline')),30000);
  ws!.onmessage=event=>{const m=JSON.parse(String(event.data));if(m.id!==id&&m.requestId!==id)return;clearTimeout(timer);m.error?fail(new Error(JSON.stringify(m.error))):done(m.data);};
  ws!.send(JSON.stringify({id,type:'REQ',method:'space.github.pollOnce',data:{},sessionId:'global',timestamp:new Date().toISOString(),version:'1.0.0'}));
 });
 const started=Date.now();
 for(let cycle=1;cycle<=2;cycle++) {
  const reply=await poll(),rows=github.repo.listPollingRepos().map(r=>({repo:r.repo,lastPollAt:r.lastPollAt,error:r.pollCursor?.lastPollError,partial:r.pollCursor?.lastPartialPollError}));
  const stored=db.prepare("SELECT json_extract(payload_json,'$.body') body FROM session_external_events WHERE topic LIKE 'github/synthetic/large/pull_request/7.%'").all() as {body:string}[];
  (evidence.cycles as unknown[]).push({cycle,reply,rows,storedComments:stored.length});
  if(mode==='before') {
   assert.match(rows.find(r=>r.repo==='conditional')?.error??'',/failed before a complete response/);
   if(cycle===1)assert.match(rows.find(r=>r.repo==='large')?.partial??'',/size limit/);
   assert.equal(stored.length,0);
  } else {
   assert(rows.every(r=>r.lastPollAt!==null&&r.lastPollAt>=started&&!r.error));
   assert.equal(stored.length,100);
   assert.deepEqual(stored.map(r=>r.body).sort(),Array.from({length:100},(_,i)=>'Synthetic '+i+' '+'x'.repeat(16_384)).sort());
   if(cycle===2)assert(rows.every(r=>!r.partial));
  }
 }
 const requests=readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
 assert(requests.some(r=>r.status===304));assert(requests.some(r=>r.bytes>1_048_576));
 assert(requests.filter(r=>r.path.includes('per_page=')).every(r=>r.path.includes('per_page=100')));
 evidence.requests=requests;evidence.verified=true;console.log(JSON.stringify({mode,cycles:evidence.cycles,verified:true}));
} finally {
 writeFileSync(join(run,'evidence/responses.json'),JSON.stringify(evidence,null,2));ws?.close();await app?.cleanup();globalThis.fetch=network;
}
