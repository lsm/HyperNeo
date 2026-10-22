import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { NeoCardEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/neo-card-event-subscription-repository.ts';

const [mode, runText] = process.argv.slice(2), run = resolve(runText);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined); assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'bin')); mkdirSync(join(run, 'evidence'));
writeFileSync(join(run, 'phase'), 'comments');
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}
const fs = require('node:fs'); const root = ${JSON.stringify(run)};
const args = process.argv.slice(2), phase = fs.readFileSync(root+'/phase','utf8');
const url = 'https://github.com/synthetic/a-heavy/pull/7'; const now = new Date().toISOString();
let body, kind;
if(args[0]==='pr' && args[1]==='view') {
 kind='completion-read'; const target=args[2]; const merged=phase==='closed' && target===url;
 body={url:target,state:merged?'MERGED':'OPEN',headRefOid:'a'.repeat(40),reviews:[],statusCheckRollup:[],createdAt:now,mergedAt:merged?now:null};
 await Bun.sleep(100);
} else if(args[0]==='api') {
 kind='poll-request'; const path=args.find(a=>a.startsWith('/repos/')||a==='/user'); if(!path) process.exit(2);
 body=[];
 if(path==='/user') body={login:'synthetic-account'};
 else if(path.includes('/a-heavy/pulls/comments')) body=Array.from({length:8},(_,i)=>({id:100+i,body:'Synthetic review '+i,commit_id:'a'.repeat(40),pull_request_url:url,html_url:url+'#discussion_r'+i,user:{login:'synthetic-reviewer'},created_at:now,updated_at:now}));
 else if(/\\/pulls\\/7(?:\\?|$)/.test(path)) body={number:7,state:phase==='closed'?'closed':'open',mergeable:true,merged:phase==='closed',merged_at:phase==='closed'?now:null,head:{sha:'a'.repeat(40)}};
 else if(path.includes('/a-heavy/pulls?') && phase==='closed') body=[{number:7,state:'closed',merged_at:now,head:{sha:'a'.repeat(40)},html_url:url,updated_at:now,user:{login:'synthetic-human'}}];
 else if(path.includes('/check-runs')) body={check_runs:[]};
 if(args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\nX-RateLimit-Remaining: 4900\\r\\nX-RateLimit-Limit: 5000\\r\\nX-RateLimit-Resource: core\\r\\n\\r\\n');
} else process.exit(2);
fs.appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase,kind})+'\\n'); process.stdout.write(JSON.stringify(body));
`, { mode: 0o700 });
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No real HTTP in proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const evidence: Record<string, unknown> = { mode };
try {
  app = await createDaemonApp({ config: getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}), verbose:false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port,8399);
  const db=app.db.getDatabase(); createCodingPackTables(db);
  for(const id of ['root','worker']) app.db.createSession({id,title:'Synthetic '+id,workspacePath:join(run,'home'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
  new NeoRepository(db).reserveBinding({sessionId:'root',kind:'neo',projectId:null});
  const todos=new NeoAskTodoRepository(db), sessions=new NeoTodoSessionRepository(db), prs=new CodingTodoPrRepository(db), cards=new NeoCardEventSubscriptionRepository(db);
  todos.openAsk({id:'ask',projectId:null,sessionId:'root',originMessageId:null,title:'Synthetic delivery',request:'Synthetic',createdAt:Date.now()});
  for(const [id,repo] of [['target','a-heavy'],['unrelated','b-small']]) {
    const url='https://github.com/synthetic/'+repo+'/pull/7', ref={adapter:'hyperneo',id:'worker'};
    const todo=todos.addTodo(id,'ask',{title:'Synthetic '+id,instruction:'Synthetic',doneWhen:'PR merged',check:{pack:'coding',kind:'pr_merged',params:{urls:[url]}},named:null},Date.now());
    sessions.create(id,{verb:'send',ref});sessions.recordRef(id,ref,Date.now());
    todos.updateTodo(todo,{state:'doing',report:'Opened '+url},Date.now());
    prs.claim(id,[{url,claim:'named'}],Date.now());prs.record(id,[{url,state:'OPEN',checks:'none',review:'none'}],Date.now());
  }
  cards.subscribe('target','github/synthetic/a-heavy/pull_request/7.*',Date.now());
  const github=app.extensionManager.getExtension('github') as GitHubEventExtension;
  for(const repo of ['a-heavy','b-small']) github.repo.upsertWatchedRepo({spaceId:'sessions',owner:'synthetic',repo,pollingEnabled:true});
  await new ExternalEventExtensionConfigStore(db).setGlobalConfig('github',{source:'github',globallyEnabled:true,capabilities:{polling:true,rpcConfig:true}});
  ws=new WebSocket('ws://127.0.0.1:'+app.server.port+'/ws');
  await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('RPC unavailable'));});
  const poll=()=>new Promise<unknown>((done,fail)=>{
    const id=crypto.randomUUID(), timer=setTimeout(()=>fail(new Error('RPC deadline')),30000);
    ws!.onmessage=event=>{const m=JSON.parse(String(event.data));if(m.id!==id&&m.requestId!==id)return;clearTimeout(timer);m.error?fail(new Error(JSON.stringify(m.error))):done(m.data);};
    ws!.send(JSON.stringify({id,type:'REQ',method:'space.github.pollOnce',data:{},sessionId:'global',timestamp:new Date().toISOString(),version:'1.0.0'}));
  });
  const started=Date.now(); evidence.commentsReply=await poll();
  const requests=()=>readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const comments=requests().filter(r=>r.phase==='comments'&&r.kind==='completion-read');
  evidence.commentCompletionReads=comments.length;
  evidence.rows=github.repo.listPollingRepos().map(r=>({repo:r.repo,lastPollAt:r.lastPollAt}));
  evidence.workerMail=db.prepare("SELECT COUNT(*) count FROM job_queue WHERE queue='mailbox' AND json_extract(payload,'$.to.sessionId')='worker'").get();
  assert((evidence.workerMail as {count:number}).count>=8);
  assert(github.repo.listPollingRepos().every(r=>r.lastPollAt!==null && r.lastPollAt>=started));
  if(mode==='before') assert(comments.length>0); else assert.equal(comments.length,1);
  if(mode==='verify') {
    writeFileSync(join(run,'phase'),'closed'); evidence.closedReply=await poll();
    assert.equal(todos.getTodo('target')?.state,'done');assert.equal(todos.getTodo('unrelated')?.state,'doing');
    evidence.target=todos.getTodo('target');evidence.unrelated=todos.getTodo('unrelated');
    evidence.closedCompletionReads=requests().filter(r=>r.phase==='closed'&&r.kind==='completion-read').length;assert(Number(evidence.closedCompletionReads)>0);
  }
  evidence.verified=true; console.log(JSON.stringify({mode,commentCompletionReads:evidence.commentCompletionReads,workerMail:evidence.workerMail,closedCompletionReads:evidence.closedCompletionReads}));
} finally {
  writeFileSync(join(run,'evidence/poll-event-checks.json'),JSON.stringify(evidence,null,2));ws?.close();await app?.cleanup();globalThis.fetch=realFetch;
}
