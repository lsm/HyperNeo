import { CodingAssignmentsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/assignments.ts';
import { CodingStageFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/stage-facts.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTrackerMirrorRepository } from '../../../packages/daemon/src/storage/repositories/neo-tracker-mirror.ts';
import { seedPrOwner } from './seed-pr-owner.ts';
process.env.HYPERNEO_SPACE ??= 'on';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { publishCodingHumanMerge } from '../../../packages/daemon/src/lib/neo/packs/coding/human-merge-notice.ts';
import { neoPublicationWrites } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { configureLogger, LogLevel, subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const assignedReview = process.argv.includes('assigned-review');
const linkedCrossRepo = process.argv.includes('linked-issue-cross-repo');
const linkedNoRow = process.argv.includes('linked-issue-no-row');
const linkedIssue = process.argv.includes('linked-issue') || linkedNoRow || linkedCrossRepo;
const humanWaiting=process.argv.includes('human-waiting-ci'),humanSibling=process.argv.includes('human-sibling-ci');
const humanOwner=process.argv.includes('human-owner');
const humanNewHead=process.argv.includes('human-new-head');
const humanUnconfigured=process.argv.includes('human-unconfigured');
const humanDefault=process.argv.includes('human-default')||humanOwner||humanUnconfigured||humanWaiting||humanSibling||humanNewHead;
const ownerCi=process.argv.includes('owner-ci');
const ciStartup=process.argv.includes('ci-startup-queued')||process.argv.includes('ci-startup-running');
const ciRace=process.argv.includes('ci-merge-race');
const stoppedReady=process.argv.includes('ci-stopped-ready');
const ciRetry=process.argv.includes('ci-retry-budget')||stoppedReady;
const pendingLedger=process.argv.includes('approved-no-checks')||ciStartup||stoppedReady;
const largeFiles=process.argv.includes('large-files');
const allPaths=Array.from({length:171},(_,i)=>`src/file-${i}.ts`);
const noChecks=process.argv.includes('no-checks');
const zeroRequired=process.argv.includes('zero-required')||noChecks||pendingLedger;
const limitGone=process.argv.includes('limit-gone'),external=process.argv.includes('external-owned');
const uncertain=process.argv.includes('uncertain-error');
const legacy=process.argv.includes('legacy-open');
const retry=process.argv.includes('retry-once');
const isolated=process.argv.includes('per-pr');
const run=resolve(process.argv.at(-1)!),host=process.argv.includes('enterprise')?'ghe.company.test':'github.com',revoke=process.argv.includes('policy-revoke'),failed=process.argv.includes('merge-fails'),late=process.argv.includes('late-label'),url=`https://${host}/synthetic/merge/pull/7`,head='a'.repeat(40);
if(host!=='github.com')process.env.GH_HOST=host;
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const dir of ['evidence','bin'])mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
writeFileSync(join(run,'evidence/gh.jsonl'),'');
const pr={url,closingIssuesReferences:[] as {url:string}[],body:'',state:'OPEN',headRefOid:head,baseRefOid:'d'.repeat(40),isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',author:{login:'author'},changedFiles:1,files:[{path:'src/app.ts'}],labels:[],mergeCommit:null};
if(largeFiles){pr.changedFiles=allPaths.length;pr.files=allPaths.slice(0,100).map(path=>({path}));}
const review={state:'APPROVED',commit_id:head,user:{login:'fixture-bot',type:'Bot'},html_url:url+'#review'};
const publish=(extra={})=>writeFileSync(join(run,'fixture.json'),JSON.stringify({pr,reviews:[[review]],labels:[[{name:'bug'}],[{name:'human-merge'}]],...extra}));publish();
writeFileSync(join(run,'bin/gh'),`#!/usr/bin/env bun
import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';import{createLocalSocket}from${JSON.stringify(new URL('../../../packages/daemon/src/lib/pairing/local-credential.ts',import.meta.url).href)};const args=process.argv.slice(2),f=JSON.parse(readFileSync(${JSON.stringify(join(run,'fixture.json'))},'utf8'));appendFileSync(${JSON.stringify(join(run,'evidence/gh.jsonl'))},JSON.stringify(args)+'\\n');if(f.sibling&&args.some(a=>a.includes('/pull/8')||a.includes('/pulls/8/')||a.includes('/issues/8/')||a==='number=8')){const pr={...f.pr,url:f.pr.url.replace('/7','/8'),state:f.siblingState||'OPEN',mergeCommit:f.siblingState==='MERGED'?{oid:'c'.repeat(40)}:null};let data;if(args[1]==='merge'){if(args.at(-1)!==pr.headRefOid||args.at(-2)!=='--match-head-commit'||!args.includes('--squash'))process.exit(2);f.siblingState='MERGED';writeFileSync(${JSON.stringify(join(run,'fixture.json'))},JSON.stringify(f));process.exit(0);}else if(args[1]==='view')data=pr;else if(args[1]==='checks')data=[{bucket:'pass',name:'Required',link:pr.url+'/checks'}];else if(args.some(a=>a.includes('CodingMergeFiles')))data=[{data:{repository:{pullRequest:{headRefOid:pr.headRefOid,baseRefOid:pr.baseRefOid,files:{nodes:pr.files,pageInfo:{hasNextPage:false,endCursor:null}}}}}}];else if(args.includes('graphql'))data={data:{repository:{pullRequest:{url:pr.url,headRefOid:pr.headRefOid,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}};else if(args.some(a=>a.endsWith('/reviews')))data=f.reviews;else if(args.some(a=>a.endsWith('/labels')))data=[[]];else process.exit(1);console.log(JSON.stringify(data));process.exit(0);} if(f.checksError&&args[0]==='pr'&&args[1]==='checks'){console.error(f.checksError);process.exit(1);} if(f.zeroRequired&&args[0]==='pr'&&args[1]==='checks'){console.error(f.requiredDiagnostic??(f.noChecks?"no checks reported on the 'fixture' branch":"no required checks reported on the 'fixture' branch"));process.exit(1);} if(f.fail&&args.some(a=>a.includes(f.fail)))process.exit(1);if(f.revoke&&args[0]==='pr'&&args[1]==='checks')await new Promise((done,fail)=>{const ws=createLocalSocket('ws://127.0.0.1:'+f.revoke.port+'/ws',${JSON.stringify(join(run,'data/local-rpc.credential'))}),id='revoke-policy';ws.onopen=()=>ws.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'operation.invoke',data:{name:'pack.preferences.set',input:{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key:'mergeBy',value:'owner'}},timestamp:new Date().toISOString(),version:'1.0.0'}));ws.onmessage=e=>{const r=JSON.parse(String(e.data));if(r.id!==id&&r.requestId!==id)return;ws.close();if(r.error||!r.data?.ok)fail(new Error('Synthetic policy RPC failed'));else done();};ws.onerror=()=>fail(new Error('Synthetic policy RPC socket failed'));});const host=args.indexOf('--hostname');if(host>=0&&args[host+1]!==args[host+1].toLowerCase())process.exit(1);if(args[0]==='pr'&&args[1]==='merge'){if(args.at(-1)!==f.pr.headRefOid||args.at(-2)!=='--match-head-commit'||!args.includes('--squash'))process.exit(2);if(f.pendingAfterMerge){f.pr.mergeStateStatus='BLOCKED';f.zeroRequired=true;f.mergeFailed=true;delete f.pendingAfterMerge;writeFileSync(${JSON.stringify(join(run,'fixture.json'))},JSON.stringify(f));}if(f.mergeFailed){if(f.failOnce){f.mergeFailed=false;writeFileSync(${JSON.stringify(join(run,'fixture.json'))},JSON.stringify(f));}console.error(f.mergeError||'Required check still settling');process.exit(1);}f.pr.state='MERGED';f.pr.mergeCommit={oid:'c'.repeat(40)};if(f.uncertain){f.fail='view';writeFileSync(${JSON.stringify(join(run,'fixture.json'))},JSON.stringify(f));console.error('Connection lost after merge');process.exit(1);}writeFileSync(${JSON.stringify(join(run,'fixture.json'))},JSON.stringify(f));process.exit(0);}else if(args[0]==='pr'&&args[1]==='edit'){f.labels=[args.includes('--add-label')?[{name:'human-merge'}]:[]];writeFileSync(${JSON.stringify(join(run,'fixture.json'))},JSON.stringify(f));process.exit(0);}else if(args[0]==='pr'&&args[1]==='view'){if(f.lateLabel&&args.at(-1).startsWith('headRefOid,state')){f.labels=[[{name:'human-merge'}]];delete f.lateLabel;writeFileSync(${JSON.stringify(join(run,'fixture.json'))},JSON.stringify(f));}if(f.race&&!args.at(-1).startsWith('headRefOid,state')){await new Promise(done=>setTimeout(done,80));writeFileSync(${JSON.stringify(join(run,'pr-observed'))},'1');}console.log(JSON.stringify(args.at(-1).startsWith('headRefOid,state')?{headRefOid:f.finalHead||f.pr.headRefOid,state:f.pr.state,baseRefOid:f.finalBase||f.pr.baseRefOid}:f.pr));}else if(args[0]==='pr'&&args[1]==='checks'&&f.emptyChecks)console.log('[]');else if(args[0]==='pr'&&args[1]==='checks')console.log(JSON.stringify([{bucket:f.race&&existsSync(${JSON.stringify(join(run,'pr-observed'))})?'pending':'pass',name:'Required',link:f.pr.url+'/checks'}]));else if(args.some(a=>a.includes('CodingMergeFiles'))){const pages=f.files??[f.pr.files.map(file=>({filename:file.path}))];console.log(JSON.stringify(pages.map((page,i)=>page===null?null:{data:{repository:{pullRequest:{headRefOid:f.pr.headRefOid,baseRefOid:f.pageBase||f.pr.baseRefOid,files:{nodes:page.map(file=>({path:file.filename})),pageInfo:{hasNextPage:i<pages.length-1,endCursor:String(i)}}}}}})));}else if(args.some(a=>a.endsWith('/reviews')))console.log(JSON.stringify(f.reviews));else if(args.some(a=>a.endsWith('/labels')))console.log(JSON.stringify(f.labels));else if(args.includes('graphql'))console.log(JSON.stringify({data:{repository:{pullRequest:{url:f.pr.url,headRefOid:f.pr.headRefOid,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}}));else process.exit(1);
`,{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP forbidden');}) as typeof fetch;
const config=getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')});
let neo:ReturnType<typeof createNeoService>|undefined;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,transport:WebSocketClientTransport|undefined,terminal=false;
const holds:string[]=[];let unsubscribe=()=>{};
const evidence:Record<string,unknown>={verified:false,executorActivated:false};
try{
 app=await createDaemonApp({config,verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({createSocket:createLocalSocket,url:`ws://127.0.0.1:${app.server.port}/ws`});hub.registerTransport(transport);await transport.connect();
 const rpc=(name:string,input:unknown)=>hub.request<{ok:boolean}>('operation.invoke',{name,input});
 for(const[key,value]of Object.entries({mergeBy:'daemon',mergePolicy:'review_bot',reviewBot:'fixture-bot',humanSignoff:largeFiles?['label:human-merge','docs/design/**']:['label:human-merge']}))assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key,value})).ok);
 assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'global',key:''},key:'watchedRepos',value:['synthetic/merge']})).ok);
 const db=app.db.getDatabase(),ledger=new CodingPrLedgerRepository(db);
 const conversation='20000000-0000-4000-8000-000000009601',root=`neo:${conversation}`;
 if(humanDefault||ciRetry){
 db.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,type,config,metadata) VALUES (?,'Synthetic Neo',?,'2026-11-03','2026-11-03','active','worker','{}','{}')").run(root,run);
 new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
 }
 if(ciRetry){await app.db.updateGlobalSettings({neo:{packs:[]}});neo=createNeoService(app.db,app.sessionManager,app.messageHub,app.internalEventBus);}
 let humanDelivery=false;
 if(humanDefault){
 const prepare=db.prepare.bind(db),runSql=db.run.bind(db);
 db.run=((sql:string,...args:unknown[])=>{if(/UPDATE pack_coding_pr_ledger SET state='waiting_human'/.test(sql))throw new Error('Handoff writes must not run on daemon main');return runSql(sql,...args);}) as typeof db.run;
 db.prepare=((sql:string)=>{if(/UPDATE pack_coding_pr_ledger SET state='waiting_human'|INSERT INTO neo_publications/.test(sql))throw new Error('Handoff writes must not run on daemon main');return prepare(sql);}) as typeof db.prepare;
 }


 configureLogger({level:LogLevel.WARN});unsubscribe=subscribeToStructuredLogs(event=>{if(event.module?.endsWith(':codingdaemonmerge'))holds.push(event.message);});
 const humanNotices:string[]=[],ownerMessages:string[]=[];
 const notices:string[]=[];let deliver=true,rejectSignoff=true;
 const snapshot=()=>JSON.parse(readFileSync(join(run,'fixture.json'),'utf8'));
 const makePack=()=>createCodingPack({database:()=>db,readPrs:async()=>linkedIssue||assignedReview?[{url,state:'OPEN',checks:'passing',review:'approved',head}]:[],todoPrs:new CodingTodoPrRepository(db),prLedger:ledger,prEvents:new CodingPrEventRepository(db),prSweep:new CodingPrSweepRepository(db),projectRepos:()=>['synthetic/merge'],prSweepDeps:{human:async(key:string,text:string)=>humanDelivery&&publishCodingHumanMerge({conversation:()=>new NeoRepository(db).conversationId(),append:input=>app!.db.gateway.call(neoPublicationWrites,'append',input),notify:()=>{humanNotices.push(text);}},key,text),tell:async(_owner,_key,text)=>{if(stoppedReady){ownerMessages.push(text);return true;}if(external&&deliver){notices.push(text);return true;}return false;},wake:async(key,text)=>{if(rejectSignoff&&text.includes('requires human sign-off')){rejectSignoff=false;throw new Error('Synthetic mailbox unavailable');}if(deliver)notices.push(text);return ciRetry&&deliver?neo!.wakeNeo(key,text):deliver;}},readLedgerRepo:async()=>{
 const node={number:7,title:'Synthetic daemon merge',headRefName:'fixture',headRefOid:snapshot().pr.headRefOid,state:terminal?(external?'MERGED':'CLOSED'):'OPEN',closedAt:terminal?new Date().toISOString():null,isDraft:false,mergeable:'MERGEABLE',reviewDecision:'APPROVED',files:{nodes:largeFiles?allPaths.slice(0,100).map(path=>({path})):[{path:'src/app.ts'}],pageInfo:{hasNextPage:largeFiles}},labels:{nodes:[],pageInfo:{hasNextPage:false}},reviews:{nodes:[{state:'APPROVED',commit:{oid:head},author:{login:'fixture-bot'}}]},commits:{nodes:[{commit:((pendingLedger&&!snapshot().ciReady)||humanWaiting)?{statusCheckRollup:ciStartup?{state:'PENDING'}:null,checkSuites:{totalCount:1}}:humanSibling?{statusCheckRollup:null,checkSuites:{totalCount:0}}:{statusCheckRollup:{state:'SUCCESS'}}}]}};
 return {data:{rateLimit:{remaining:5000},repository:{nameWithOwner:'synthetic/merge',open:{pageInfo:{hasNextPage:false},nodes:terminal?[]:humanSibling?[node,{...node,number:8,isDraft:true,commits:{nodes:[{commit:{statusCheckRollup:{state:'SUCCESS'}}}]}}]:isolated?[node,{...node,number:8}]:[node]},done:{nodes:terminal?[node]:[]}}}};
 }});
 const pack=makePack();let preferences=await rpc('pack.preferences.list',{});let tick=Date.now();
 const runSweep=()=>pack.sweep!(tick+=61_000);
 const mergeCalls=()=>readFileSync(join(run,'evidence/gh.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(args=>args[0]==='pr'&&args[1]==='merge');
 const seedStoppedBudget=async()=>{for(let i=0;i<3;i++){const[receipt]=await ledger.write('daemonMerge',{kind:'begin',url,head,actor:'daemon:coding-sweep',at:tick+i});assert(receipt);await ledger.write('daemonMerge',{...receipt,kind:'failed',error:'The base branch policy prohibits the merge.',at:receipt.startedAt});await ledger.write('daemonMerge',{...receipt,kind:'void',at:receipt.startedAt});}};
 if (assignedReview) {
   assert(![8399, 8499].includes(app.server.port));
   const prepare = db.prepare.bind(db);
   db.prepare = ((sql: string) => {
     assert(!sql.includes('SELECT f.value_json AS assignment'), 'Review holds must be read off the daemon main thread');
     return prepare(sql);
   }) as typeof db.prepare;
   rejectSignoff = false;
   const store = new NeoAskTodoRepository(db);
   store.openAsk({ id: 'review-ask', sessionId: 'synthetic', projectId: null,
     originMessageId: null, title: 'Synthetic review', request: 'Review', createdAt: 1 });
   const todo = store.addTodo('review-todo', 'review-ask', { title: 'Synthetic change',
     instruction: 'Build', named: null, doneWhen: 'Merged',
     check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } } }, 2);
   store.updateTodo(todo, { state: 'doing' }, 3);
   const stages = new CodingStageFactsRepository(db);
   stages.observeHead(url, head, tick);
   const actor = { kind: 'agent' as const, id: 'synthetic-reviewer', harness: 'hyperneo', model: 'review-model' };
   const ref = { adapter: 'hyperneo', id: actor.id };
   assert(new CodingAssignmentsRepository(db).record(todo.id, 'review', {
     url, head, acceptanceContract: 'contract', newDispatch: true,
     write: { adapter: 'hyperneo', id: 'synthetic-writer' }, actor, ref,
   }));
   const held = () => notices.filter((text) => text.includes('requires human sign-off'));
   await runSweep();
   await runSweep();
   assert.equal(held().length, 0);
   assert.equal(mergeCalls().length, 0);
   evidence.coveredHoldWakes = held().length;
   evidence.reviewReadOffMainThread = true;
   assert(stages.record({ url, head, stage: 'review', actor, ref, verdict: 'pass',
     acceptanceContract: 'contract', evidence: ['Synthetic review completed'] }));
   await runSweep();
   assert.equal(held().length, 1);
   evidence.finishedReviewWakes = 1;
   db.prepare("DELETE FROM pack_coding_stage_facts WHERE url=?").run(url);
   store.askQuestion('review-decision', 'review-ask', { todoId: todo.id,
     text: 'Choose next step', kind: 'reply', options: null, multiple: false,
     noLabel: null, yesLabel: null, startTodos: null }, tick);
   await runSweep();
   assert.equal(held().length, 2);
   evidence.humanDecisionWakes = 1;
   assert.equal(mergeCalls().length, 0);
   assert.equal(store.getTodo(todo.id)?.state, 'doing');
   assert.equal(store.listQuestions('review-ask')[0].state, 'open');
   assert.deepEqual(await rpc('pack.preferences.list', {}), preferences);
   evidence.mergeCommands = mergeCalls();
   evidence.savedPreferencesUnchanged = true;
   evidence.verified = true;
 } else if (linkedIssue) {
   const mirrorHome = linkedCrossRepo ? 'synthetic/mirror-a' : 'synthetic/merge';
   const store = new NeoAskTodoRepository(db);
   store.openAsk({ id: 'mirror-ask', projectId: null, sessionId: 'synthetic', originMessageId: null,
     title: 'Mirrored plan', request: 'Work', createdAt: 1 });
   store.addTodo('mirror-todo', 'mirror-ask', { title: 'Step', instruction: 'Work', named: null,
     doneWhen: 'Merged', check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } } }, 2, mirrorHome);
   db.prepare("UPDATE neo_todos SET state='doing' WHERE id='mirror-todo'").run();
   assert((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/merge' },
     key: 'mirror_issues', value: !linkedCrossRepo })).ok);
   if (linkedCrossRepo) assert((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: mirrorHome }, key: 'mirror_issues', value: true })).ok);
   const mirrors = new NeoTrackerMirrorRepository(db);
   const child = { ownerKind: 'todo' as const, ownerId: 'mirror-todo', tracker: 'github-issues',
     home: mirrorHome, ref: `${mirrorHome}#21`, parentRef: null, state: 'bound' as const, failures: 0, updatedAt: 3 };
   if (linkedNoRow) {
     db.prepare("UPDATE pack_coding_todos SET repo=NULL WHERE todo_id='mirror-todo'").run();
     assert.equal(pack.tracker!.enabled({ kind: 'todo', ask: store.getAsk('mirror-ask')!, todo: store.getTodo('mirror-todo')! }), false);
     publish({ labels: [[]] });
     await runSweep();
     assert.equal(mergeCalls().length, 1);
     evidence.noMirrorFailOpenMergeCount = 1;
     evidence.mergeCommands = mergeCalls();
     evidence.executorActivated = true;
     evidence.verified = true;
   } else {
     mirrors.put(child);
     mirrors.put({ ...child, ownerKind: 'ask', ownerId: 'mirror-ask', ref: `${mirrorHome}#20` });
     publish({ labels: [[{ name: 'human-merge' }]] });
     await runSweep();
     await runSweep();
     assert.equal(mergeCalls().length, 0);
     assert(notices.some((text) => text.includes('requires human sign-off')));
     evidence.humanSignoffWakePreserved = true;
     publish({ labels: [[]] });
     await runSweep();
     assert.equal(mergeCalls().length, 0);
     assert.deepEqual(await ledger.write('daemonMerge', { kind: 'list' }), []);
     pr.closingIssuesReferences = [{ url: 'https://github.com/other/repo/issues/21' }];
     publish({ labels: [[]] });
     await runSweep();
     assert.equal(mergeCalls().length, 0);
     mirrors.put({ ...child, state: 'closed' });
     const check = await pack.todos!.check(store.getTodo('mirror-todo')!);
     assert.equal(check?.done, false);
     assert.equal(store.getTodo('mirror-todo')?.state, 'doing');
     pr.closingIssuesReferences = [{ url: `https://github.com/${mirrorHome}/issues/20` }];
     publish({ labels: [[]] });
     await runSweep();
     assert.equal(mergeCalls().length, 1);
     assert(mergeCalls()[0].includes(head));
     await runSweep();
     assert.equal(mergeCalls().length, 1);
     evidence.noClosingReferenceMergeCount = 0;
     evidence.foreignIssueMergeCount = 0;
     evidence.earlyClosedIssueTodoState = 'doing';
     evidence.parentClosingReferenceMergeCount = 1;
     evidence.crossRepositoryMirrorHome = linkedCrossRepo;
     evidence.executorActivated = true;
     evidence.mergeCommands = mergeCalls();
     evidence.verified = true;
   }
 } else if(stoppedReady){
 seedPrOwner(db,'synthetic/merge',{adapter:'codex-desktop',id:'fixture-owner'});
 const messages=()=>db.prepare("SELECT payload FROM job_queue WHERE queue='mailbox' ORDER BY id").all().map((row:{payload:string})=>JSON.parse(row.payload));const readyMessages=()=>messages().filter(job=>String(job.message.message.content).includes('Fresh merge gates now pass'));
 await seedStoppedBudget();publish({labels:[[]],pr:{...pr,mergeStateStatus:'BLOCKED'},zeroRequired:true});await runSweep();assert.equal(messages().filter(job=>String(job.message.message.content).includes('3 failed attempts')).length,1);assert.equal(readyMessages().length,0);
 publish({labels:[[]],ciReady:true,fail:'/reviews'});await runSweep();assert.equal(readyMessages().length,0);
 publish({labels:[[]],ciReady:true});await runSweep();await makePack().sweep!(tick+=61_000);assert.equal(ledger.list()[0].state,'approved_green');assert.equal(mergeCalls().length,0);assert.equal(ownerMessages.length,0,'Daemon mode must not tell a worker to merge manually');assert.equal(readyMessages().length,1,'A stopped head that becomes green must wake Neo once');assert(String(readyMessages()[0].message.message.content).includes('neo.coding.merge.retry'));assert.equal((await ledger.write('daemonMerge',{kind:'failures',url,head}))[0].failures,3);
 const op=pack.operations!.find(op=>op.name==='neo.coding.merge.retry')!;assert.equal((await op.execute({url,head},{role:'neo'} as never)).accepted,true);await runSweep();await runSweep();assert.equal(mergeCalls().length,1);assert.equal(readyMessages().length,1);
 evidence.stoppedGreenCue=readyMessages();evidence.noManualOwnerInstruction=true;evidence.readyCiMergedOnce=true;evidence.verified=true;
 }else if(ciRetry){
 const stoppedReports=()=>db.prepare("SELECT payload FROM job_queue WHERE queue='mailbox' ORDER BY id").all().map((row:{payload:string})=>JSON.parse(row.payload)).filter(job=>String(job.message.message.content).includes('3 failed attempts'));
 await seedStoppedBudget();
 await runSweep();assert.equal(stoppedReports().length,1);
 const historical=db.prepare('SELECT * FROM pack_coding_daemon_merge_failures ORDER BY started_at').all();assert.equal(historical.length,3);
 const retry=pack.operations!.find(op=>op.name==='neo.coding.merge.retry');assert(retry,'Neo must have a gated path to accept a stopped report');
 const input={url,head};const callsBefore=readFileSync(join(run,'evidence/gh.jsonl'),'utf8');assert.equal((await retry.execute(input,{role:'worker'} as never)).accepted,false);assert.equal(readFileSync(join(run,'evidence/gh.jsonl'),'utf8'),callsBefore);
 assert.equal((await retry.execute({url,head:'b'.repeat(40)},{role:'neo'} as never)).accepted,false);
 publish({labels:[[]],pr:{...pr,headRefOid:'b'.repeat(40)},reviews:[[{...review,commit_id:'b'.repeat(40)}]]});const moved=await retry.execute(input,{role:'neo'} as never);assert.equal(moved.accepted,false);assert(moved.reason?.includes('head_changed'));
 for(const extra of [{pr:{...pr,mergeStateStatus:'BLOCKED'},zeroRequired:true},{labels:[[{name:'human-merge'}]]},{fail:'/reviews'}]){publish({labels:[[]],...extra});assert.equal((await retry.execute(input,{role:'neo'} as never)).accepted,false);assert.equal((await ledger.write('daemonMerge',{kind:'failures',url,head}))[0].failures,3);}
 publish({labels:[[]]});assert.equal((await retry.execute(input,{role:'neo'} as never)).accepted,true);assert.deepEqual(await ledger.write('daemonMerge',{kind:'failures',url,head}),[]);assert.deepEqual(db.prepare('SELECT * FROM pack_coding_daemon_merge_failures ORDER BY started_at').all(),historical);
 const afterRetry=readFileSync(join(run,'evidence/gh.jsonl'),'utf8');assert.equal((await retry.execute(input,{role:'neo'} as never)).accepted,false);assert.equal(readFileSync(join(run,'evidence/gh.jsonl'),'utf8'),afterRetry);
 rejectSignoff=false;publish({labels:[[]],mergeFailed:true});await runSweep();await runSweep();await runSweep();await runSweep();assert.equal(mergeCalls().length,3);assert.equal(stoppedReports().length,2,'Neo must receive both stopped-budget reports');
 publish({labels:[[]]});assert.equal((await retry.execute(input,{role:'neo'} as never)).accepted,true);await runSweep();await runSweep();assert.equal(mergeCalls().length,4);assert.equal(notices.filter(text=>text.includes('Merge confirmed:')).length,1);const allFailures=db.prepare('SELECT * FROM pack_coding_daemon_merge_failures ORDER BY started_at').all();assert.equal(allFailures.length,6);assert.deepEqual(allFailures.slice(0,3),historical);
 evidence.newStoppedEpisodeNotified=true;evidence.neoStoppedReports=stoppedReports();
 evidence.stoppedReportRetryFreshGated=true;evidence.historicalFailuresPreserved=true;evidence.readyCiMergedOnce=true;evidence.mergeCommands=mergeCalls();evidence.verified=true;
 }else if(ciStartup||ciRace){
 rejectSignoff=false;
 const requiredDiagnostic=process.argv.includes('ci-startup-queued')?"no required checks reported on the 'refactor/space-optional-rpc' branch":"no required checks reported on the 'codex/neo-peer-message' branch";
 const mergeError='X Pull request is not mergeable: the base branch policy prohibits the merge.';
 if(ciRace){publish({labels:[[]],pendingAfterMerge:true,mergeError});await runSweep();assert.equal(mergeCalls().length,1);assert.deepEqual(await ledger.write('daemonMerge',{kind:'failures',url,head}),[],'A newly pending CI race must not consume a failure');}
 else publish({labels:[[]],pr:{...pr,mergeStateStatus:'BLOCKED'},zeroRequired:true,requiredDiagnostic,mergeFailed:true,mergeError});
 for(let i=0;i<4;i++)await makePack().sweep!(tick+=61_000);
 assert.equal(mergeCalls().length,ciRace?1:0,'Queued/in-progress CI must not issue a merge');assert.deepEqual(await ledger.write('daemonMerge',{kind:'failures',url,head}),[]);assert.deepEqual(await ledger.write('daemonMerge',{kind:'list'}),[]);assert(!notices.some(text=>text.includes('3 failed attempts')));
 publish({labels:[[]],ciReady:true});await runSweep();await runSweep();
 assert.equal(mergeCalls().length,ciRace?2:1);assert.equal(notices.filter(text=>text.includes('Merge confirmed:')).length,1);assert.deepEqual(await ledger.write('daemonMerge',{kind:'failures',url,head}),[]);
 evidence.pendingCiDidNotChargeBudget=true;evidence.readyCiMergedOnce=true;evidence.requiredDiagnostic=requiredDiagnostic;evidence.race=ciRace;evidence.mergeCommands=mergeCalls();evidence.verified=true;
 }else if(largeFiles){
 const pages=[allPaths.slice(0,100),allPaths.slice(100)].map(page=>page.map(filename=>({filename})));
 rejectSignoff=false;
 for(const extra of [{files:pages,pageBase:'e'.repeat(40)},{files:pages,pr:{...pr,mergeStateStatus:'UNSTABLE'}},{files:pages,finalBase:'e'.repeat(40)},{files:[pages[0],pages[0].slice(0,71)]},{files:[pages[0]]},{files:[null]},{files:pages,fail:'CodingMergeFiles'},{files:[pages[0],pages[1].map((file,i)=>i===70?{filename:'docs/design/requires-signoff.md'}:file)]}]){
 publish({labels:[[]],...extra});await runSweep();assert.equal(mergeCalls().length,0);
 }
 assert.equal(ledger.list()[0].state,'waiting_human');
 publish({labels:[[]],files:pages});await runSweep();await runSweep();
 assert.deepEqual(mergeCalls(),[['pr','merge',url,'--squash','--match-head-commit',head]]);
 assert.equal(notices.filter(text=>text.includes('Merge confirmed:')).length,1);
 assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);
 evidence.completeFileScope=171;evidence.movedBaseAndDuplicatePagesHeld=true;evidence.unsettledCommitStatusHeld=true;evidence.incompleteMalformedAndFailedReadsHeld=true;evidence.protectedLastPageHeld=true;evidence.savedPreferencesUnchanged=true;evidence.mergeCommands=mergeCalls();evidence.executorActivated=true;evidence.verified=true;
 }else if(ownerCi){
 publish({labels:[[]]});rejectSignoff=false;
 for(const[key,value]of Object.entries({mergeBy:'owner',mergePolicy:'ci_only'}))assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key,value})).ok);
 await runSweep();await runSweep();
 assert.deepEqual(mergeCalls(),[]);assert(!holds.some(text=>text.includes('merge_by_owner')));
 const reads=readFileSync(join(run,'evidence/gh.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.equal(reads.length,2);assert(reads.every(args=>args[0]==='pr'&&args[1]==='checks'));evidence.ownerChecksOnly=true;
 assert.deepEqual(await ledger.write('daemonMerge',{kind:'list'}),[]);
 evidence.ownerExecutionNoDaemonAttempt=true;evidence.verified=true;
 }else if(humanDefault){
 publish({labels:[[]],emptyChecks:true});rejectSignoff=false;
 assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key:'mergePolicy',value:'ci_only'})).ok);
 if(humanOwner){
 assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key:'mergeBy',value:'owner'})).ok);
 seedPrOwner(db,'synthetic/merge',{adapter:'hyperneo',id:'fixture-owner'});
 }
 if(humanUnconfigured)db.prepare("DELETE FROM neo_pack_preferences WHERE pack='coding' AND scope_kind='repo' AND scope_key='synthetic/merge' AND key IN ('mergeBy','mergePolicy','reviewBot')").run();
 preferences=await rpc('pack.preferences.list',{});
 const page=()=>hub.request<{ok:boolean;items:{fullText:string}[]}>('operation.invoke',{name:'neo.publication.read',input:{conversationId:conversation}});
 await runSweep();
 assert.equal(mergeCalls().length,0,'No checks and no bot must not daemon-merge');
 assert.equal((await page()).items.length,0,'Failed delivery must remain retryable');
 humanDelivery=true;await makePack().sweep!(tick+=61_000);
 const visible=await page();assert(visible.ok);assert.equal(visible.items.length,1);
 assert(visible.items[0].fullText.includes(url)&&visible.items[0].fullText.includes('manual merge'));
 assert.equal(ledger.list()[0].state,'waiting_human');
 const settledReadCount=readFileSync(join(run,'evidence/gh.jsonl'),'utf8').trim().split('\n').filter(Boolean).length,settledStateSince=ledger.list()[0].stateSince;
 await runSweep();assert.equal((await page()).items.length,1);assert.equal(humanNotices.length,1);
 if(humanWaiting||humanSibling)assert.equal(ledger.list()[0].stateSince,settledStateSince,'A settled handoff must not flap through reconcile');else assert.equal(readFileSync(join(run,'evidence/gh.jsonl'),'utf8').trim().split('\n').filter(Boolean).length,settledReadCount,'Settled handoffs must make no more GitHub calls');
 const conflicting=await publishCodingHumanMerge({conversation:()=>conversation,append:input=>app!.db.gateway.call(neoPublicationWrites,'append',input),notify:()=>{throw new Error('A conflicting notice must not notify again');}},`coding-no-checks:${url}:${head}`,'Changed wording for the same already-delivered handoff');
 assert.equal(conflicting,false);assert.deepEqual((await page()).items,visible.items);
 await makePack().sweep!(tick+=61_000);assert.deepEqual((await page()).items,visible.items);assert.equal(humanNotices.length,1);evidence.wordingConflictPreservesDeliveredNotice=true;
 assert.equal(readFileSync(join(run,'evidence/gh.jsonl'),'utf8').trim().split('\n').filter(Boolean).length,settledReadCount);evidence.settledHandoffNoGithubReads=true;evidence.stableHumanStateSince=true;
 if(humanNewHead){
 pr.headRefOid='b'.repeat(40);publish({labels:[[]],emptyChecks:true});await runSweep();assert.equal((await page()).items.length,2);assert((await page()).items[1].fullText.includes(pr.headRefOid));const nextReads=readFileSync(join(run,'evidence/gh.jsonl'),'utf8');assert(nextReads.trim().split('\n').length>settledReadCount);await makePack().sweep!(tick+=61_000);assert.equal(readFileSync(join(run,'evidence/gh.jsonl'),'utf8'),nextReads);pr.headRefOid=head;publish({labels:[[]],emptyChecks:true});evidence.newHeadGetsOwnHandoff=true;
 }
 assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);
 assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'global',key:''},key:'allowNoChecksMerge',value:true})).ok);
 await runSweep();assert.equal(mergeCalls().length,0,'A global opt-in must not authorize this repo');
 assert.equal(ledger.policy('synthetic/merge').allowNoChecksMerge,false);
 for(const[key,value]of Object.entries({mergeBy:'daemon',mergePolicy:'ci_only',allowNoChecksMerge:true}))assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key,value})).ok);
 await runSweep();await runSweep();
 assert.equal(mergeCalls().length,1,'An explicit repo opt-in restores one daemon merge');
 assert.equal((await page()).items.length,humanNewHead?2:1);
 evidence.publicHumanNotice=visible.items[0];evidence.failedDeliveryRecovered=true;evidence.noOwner=!humanOwner;evidence.ownerExecution=humanOwner;evidence.unconfigured=humanUnconfigured;evidence.noDuplicateNotice=true;evidence.globalOptInIgnored=true;evidence.repoOptInMerged=true;evidence.mergeCommands=mergeCalls();evidence.verified=true;
 }else if(zeroRequired){
 rejectSignoff=false;
 if(noChecks){
  for(const code of [502,504]){
   publish({labels:[[]],checksError:'gh: HTTP '+code});
   await runSweep();assert.equal(mergeCalls().length,0);
   assert.deepEqual(await ledger.write('daemonMerge',{kind:'list'}),[]);
   assert(holds.some(text=>text.includes('required_checks: gh: HTTP '+code)));
  }
  evidence.httpFailuresHeld=true;
 }
 publish({labels:[[]],zeroRequired:true,noChecks});
 await runSweep();await runSweep();
 assert.deepEqual(mergeCalls(),[['pr','merge',url,'--squash','--match-head-commit',head]]);
 assert.equal(notices.filter(text=>text.includes('Merge confirmed:')).length,1);
 const receipt=db.prepare('SELECT head,actor,merge_commit FROM pack_coding_daemon_merges').all();
 assert.deepEqual(receipt.map(row=>({...row})),[{head,actor:'daemon:coding-sweep',merge_commit:'c'.repeat(40)}]);
 assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);
 evidence.ledgerApprovalPending=pendingLedger;evidence.noChecksDiagnostic=noChecks;evidence.zeroRequiredChecksRead=true;evidence.receipt=receipt;evidence.mergeCommands=mergeCalls();evidence.executorActivated=true;evidence.verified=true;
 }else if(limitGone){publish({labels:[[]],mergeFailed:true});rejectSignoff=false;deliver=false;await runSweep();await runSweep();await runSweep();assert.equal(mergeCalls().length,3);assert.deepEqual(notices,[]);terminal=true;pr.state='CLOSED';publish({labels:[[]],mergeFailed:true});assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key:'mergeBy',value:'owner'})).ok);deliver=true;await makePack().sweep!(tick+=61_000);await runSweep();assert.equal(mergeCalls().length,3);assert.equal(notices.filter(text=>text.includes('3 failed attempts')&&text.includes('Required check still settling')).length,1);evidence.executorActivated=true;evidence.limitNoticeSurvivesCandidateRemoval=true;evidence.noticeAcknowledged=true;evidence.mergeCommands=mergeCalls();evidence.verified=true;}else if(external){publish({labels:[[]],mergeFailed:true});rejectSignoff=false;seedPrOwner(db,'synthetic/merge',{adapter:'hyperneo',id:'fixture-owner'});await runSweep();assert.equal(mergeCalls().length,1);assert((await new CodingPrEventRepository(db).routeLater({repo:'synthetic/merge',number:7})).owner);terminal=true;pr.state='MERGED';pr.mergeCommit={oid:'c'.repeat(40)};publish({labels:[[]]});await runSweep();await runSweep();assert.equal(mergeCalls().length,1);assert.equal(notices.filter(text=>text.includes('was merged on head')).length,1);evidence.executorActivated=true;evidence.externalMergeOwnerNotified=true;evidence.noRepeatMerge=true;evidence.mergeCommands=mergeCalls();evidence.verified=true;}else if(uncertain){publish({labels:[[]],uncertain:true});rejectSignoff=false;await runSweep();assert.equal(mergeCalls().length,1);assert.equal((await ledger.write('daemonMerge',{kind:'list'})).length,1);assert.deepEqual(await ledger.write('daemonMerge',{kind:'failures',url,head}),[]);const recovered=snapshot();delete recovered.fail;delete recovered.uncertain;writeFileSync(join(run,'fixture.json'),JSON.stringify(recovered));await makePack().sweep!(tick+=61_000);await runSweep();assert.equal(mergeCalls().length,1);assert.equal(notices.filter(text=>text.includes('Merge confirmed:')).length,1);assert.deepEqual(await ledger.write('daemonMerge',{kind:'list'}),[]);evidence.failedReplyUnreadableReceiptRetained=true;evidence.confirmedOnceAfterReadRecovery=true;evidence.noRepeatMerge=true;evidence.mergeCommands=mergeCalls();evidence.executorActivated=true;evidence.verified=true;}else if(legacy){publish({labels:[[]]});rejectSignoff=false;await ledger.write('daemonMerge',{kind:'begin',url,head,actor:'daemon:previous-build',at:tick-61_000});await runSweep();assert.equal(mergeCalls().length,1);assert.equal((await ledger.write('daemonMerge',{kind:'failures',url,head}))[0].failures,1);assert(notices.some(text=>text.includes('Merge confirmed:')));await runSweep();assert.equal(mergeCalls().length,1);assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);evidence.legacyOpenReceiptRecovered=true;evidence.noManualUnstickRequired=true;evidence.mergeCommands=mergeCalls();evidence.executorActivated=true;evidence.verified=true;}else if(retry){publish({labels:[[]],mergeFailed:true,failOnce:true});rejectSignoff=false;await runSweep();assert.equal(mergeCalls().length,1);await makePack().sweep!(tick+=61_000);assert.equal(mergeCalls().length,2);await makePack().sweep!(tick+=61_000);assert.equal(mergeCalls().length,2);assert.equal(notices.filter(text=>text.includes('Merge confirmed:')).length,1);assert(holds.some(text=>text.includes(url)&&text.includes('Required check still settling')));assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);evidence.firstFailureRetried=true;evidence.packRecreationPreservedRetry=true;evidence.confirmedOnce=true;evidence.perPrHolds=holds;evidence.mergeCommands=mergeCalls();evidence.executorActivated=true;evidence.verified=true;}else if(isolated){publish({labels:[[]],fail:'/labels',sibling:true});rejectSignoff=false;await runSweep();assert.equal(mergeCalls().length,1);assert.equal(mergeCalls()[0][2],url.replace('/7','/8'));assert(notices.some(text=>text.includes('Merge confirmed: '+url.replace('/7','/8'))));assert(!notices.some(text=>text.includes('Merge confirmed: '+url+' ')));await runSweep();assert.equal(mergeCalls().length,1);assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);assert(holds.some(text=>text.includes(url)&&text.includes('labels:')));evidence.executorActivated=true;evidence.perPrHolds=holds;evidence.unreadableFirstPrHeld=true;evidence.readableSiblingMerged=true;evidence.repeatedSweepDidNotMergeTwice=true;evidence.savedPreferencesUnchanged=true;evidence.mergeCommands=mergeCalls();evidence.verified=true;}else if(failed){publish({labels:[[]],mergeFailed:true});deliver=false;await runSweep();await makePack().sweep!(tick+=61_000);await runSweep();assert.equal(mergeCalls().length,3);assert.deepEqual(notices,[]);assert.deepEqual(await ledger.write('daemonMerge',{kind:'list'}),[]);deliver=true;await makePack().sweep!(tick+=61_000);assert.equal(mergeCalls().length,3);assert(notices.some(text=>text.includes('3 failed attempts')&&text.includes(url)&&text.includes(head)&&text.includes('Required check still settling')));assert.equal((await ledger.write('daemonMerge',{kind:'failures',url,head}))[0].failures,3);assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);evidence.retryLimitSurvivesPackRecreation=true;evidence.retryLimitSurfacesErrorToNeo=true;evidence.failedAttemptReceiptReleased=true;evidence.executorActivated=true;evidence.mergeSucceeded=false;evidence.savedPreferencesUnchanged=true;evidence.mergeCommands=mergeCalls();evidence.verified=true;}else if(revoke){publish({labels:[[]],revoke:{port:app.server.port}});await runSweep();assert.equal(ledger.policy('synthetic/merge').mergeBy,'owner');assert.equal(mergeCalls().length,0);evidence.policyRevokedByRpcDuringGithubRead=true;evidence.mergeCommands=mergeCalls();evidence.verified=true;}else if(late){publish({labels:[[]],lateLabel:true});rejectSignoff=false;await runSweep();assert.equal(mergeCalls().length,0);assert.equal((await ledger.write('daemonMerge',{kind:'list'})).length,0);assert(notices.some(text=>text.includes('sign-off')));const label=pack.operations!.find(op=>op.name==='neo.coding.merge.human')!;assert.deepEqual(await label.execute({url,enabled:false},{role:'neo'} as never),{accepted:true});await runSweep();assert.equal(mergeCalls().length,1);assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);evidence.lateHumanLabelHeld=true;evidence.labelRemovalResumedSameHead=true;evidence.savedPreferencesUnchanged=true;evidence.mergeCommands=mergeCalls();evidence.executorActivated=true;evidence.verified=true;}else{
 await runSweep();assert.equal(mergeCalls().length,0);assert.equal(rejectSignoff,false);assert(!notices.some(text=>text.includes('sign-off')));await runSweep();assert(notices.some(text=>text.includes('sign-off')));evidence.laterPageHumanLabelHeld=true;evidence.signoffDeliveryFailureRetried=true;
 publish({labels:[[]]});assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key:'mergePolicy',value:'human'})).ok);const humanPreferences=await rpc('pack.preferences.list',{}),beforeHuman=notices.length;await runSweep();assert.equal(ledger.list()[0].state,'waiting_human');assert(notices.length>beforeHuman);assert.equal(mergeCalls().length,0);assert.deepEqual(await rpc('pack.preferences.list',{}),humanPreferences);evidence.humanPolicySurfaced=true;assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key:'mergePolicy',value:'review_bot'})).ok);preferences=await rpc('pack.preferences.list',{});
 for(const fail of ['/labels','/reviews','checks','graphql','view']){publish({fail,labels:[[]]});await runSweep();assert.equal(mergeCalls().length,0);assert.deepEqual(await ledger.write('daemonMerge',{kind:'list'}),[]);}evidence.readFailuresHeld=true;
 publish({labels:[[]],finalHead:'b'.repeat(40)});await runSweep();assert.equal(mergeCalls().length,0);evidence.movedHeadHeld=true;
 publish({labels:[[]]});deliver=false;await runSweep();assert.equal(mergeCalls().length,1);const receipt=(await ledger.write('daemonMerge',{kind:'list'}))[0];assert.equal(receipt.head,head);assert.equal(receipt.actor,'daemon:coding-sweep');assert.equal(receipt.mergeCommit,'c'.repeat(40));evidence.receipt=receipt;
 deliver=true;await runSweep();await runSweep();assert.equal(mergeCalls().length,1);assert.deepEqual(await ledger.write('daemonMerge',{kind:'list'}),[]);assert(notices.some(text=>text.includes(head)&&text.includes('Merge confirmed:')));evidence.notificationRetriedWithoutDuplicateMerge=true;
 const label=pack.operations!.find(op=>op.name==='neo.coding.merge.human')!;
 assert.deepEqual(await label.execute({url,enabled:true},{role:'neo'} as never),{accepted:true});assert.deepEqual(snapshot().labels,[[{name:'human-merge'}]]);const beforeLabel=readFileSync(join(run,'evidence/gh.jsonl'),'utf8');const deniedLabel=await hub.request<{accepted:boolean}>('operation.invoke',{name:label.name,input:{url,enabled:false}});assert.equal(deniedLabel.accepted,false);assert.equal(readFileSync(join(run,'evidence/gh.jsonl'),'utf8'),beforeLabel);assert.deepEqual(snapshot().labels,[[{name:'human-merge'}]]);evidence.unauthorizedHumanLabelRefused=true;
 assert.deepEqual(await label.execute({url,enabled:false},{role:'neo'} as never),{accepted:true});assert.deepEqual(snapshot().labels,[[]]);evidence.explicitHumanIntentLabelTool=true;
 assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);assert.equal(pack.preferences!.mergeBy.default,'owner');evidence.savedPreferencesUnchanged=true;assert(mergeCalls().every(args=>args[2]===url));evidence.host=host;evidence.mergeCommands=mergeCalls();evidence.executorActivated=true;evidence.verified=true;
 }
}finally{unsubscribe();await transport?.close();await neo?.dispose();await app?.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;writeFileSync(join(run,'evidence/coding-daemon-merge-sweep.json'),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify(evidence));
