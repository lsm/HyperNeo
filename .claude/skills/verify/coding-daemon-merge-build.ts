import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { readCodingDaemonMergeFacts } from '../../../packages/daemon/src/lib/neo/packs/coding/daemon-merge-facts.ts';
import { decideCodingDaemonMerge } from '../../../packages/daemon/src/lib/neo/packs/coding/daemon-merge-gates.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run=resolve(process.argv[2]),url='https://github.com/synthetic/merge/pull/7',head='a'.repeat(40);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const dir of ['evidence','bin'])mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const pr={url,body:'',state:'OPEN',headRefOid:head,isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',author:{login:'author'},changedFiles:1,files:[{path:'src/app.ts'}],labels:[],mergeCommit:null};
const review={state:'APPROVED',commit_id:head,user:{login:'fixture-bot',type:'Bot'},html_url:url+'#review'};
const publish=(extra={})=>writeFileSync(join(run,'fixture.json'),JSON.stringify({pr,reviews:[[review]],labels:[[{name:'bug'}],[{name:'human-merge'}]],...extra}));publish();
writeFileSync(join(run,'bin/gh'),`#!/usr/bin/env bun
import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';const args=process.argv.slice(2),f=JSON.parse(readFileSync(${JSON.stringify(join(run,'fixture.json'))},'utf8'));appendFileSync(${JSON.stringify(join(run,'evidence/gh.jsonl'))},JSON.stringify(args)+'\\n');if(f.fail&&args.some(a=>a.includes(f.fail)))process.exit(1);const host=args.indexOf('--hostname');if(host>=0&&args[host+1]!==args[host+1].toLowerCase())process.exit(1);if(args[0]==='pr'&&args[1]==='view'){if(f.race&&args.at(-1)!=='headRefOid,state'){await new Promise(done=>setTimeout(done,80));writeFileSync(${JSON.stringify(join(run,'pr-observed'))},'1');}console.log(JSON.stringify(args.at(-1)==='headRefOid,state'?{headRefOid:f.finalHead||f.pr.headRefOid,state:f.pr.state}:f.pr));}else if(args[0]==='pr'&&args[1]==='checks')console.log(JSON.stringify([{bucket:f.race&&existsSync(${JSON.stringify(join(run,'pr-observed'))})?'pending':'pass',name:'Required',link:f.pr.url+'/checks'}]));else if(args.some(a=>a.endsWith('/reviews')))console.log(JSON.stringify(f.reviews));else if(args.some(a=>a.endsWith('/labels')))console.log(JSON.stringify(f.labels));else if(args.includes('graphql'))console.log(JSON.stringify({data:{repository:{pullRequest:{url:f.pr.url,headRefOid:f.pr.headRefOid,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}}));else process.exit(1);
`,{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP forbidden');}) as typeof fetch;
const config=getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')});
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,transport:WebSocketClientTransport|undefined,held=false;
const evidence:Record<string,unknown>={verified:false,executorActivated:false,mainSql:0};
try{
 app=await createDaemonApp({config,verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`});hub.registerTransport(transport);await transport.connect();
 const rpc=(name:string,input:unknown)=>hub.request<{ok:boolean}>('operation.invoke',{name,input});
 for(const[key,value]of Object.entries({mergeBy:'daemon',mergePolicy:'review_bot',reviewBot:'fixture-bot',humanSignoff:['label:human-merge']}))assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key,value})).ok);
 const db=app.db.getDatabase(),ledger=new CodingPrLedgerRepository(db),policy=ledger.policy('synthetic/merge');
 const configuredHost=process.env.GH_HOST;delete process.env.GH_HOST;
 try{const mixed=await readCodingDaemonMergeFacts(db,url.replace('github.com','GitHub.com'));assert(mixed.ok,'A mixed-case GitHub hostname is valid without GH_HOST');assert.equal(mixed.head,head);evidence.mixedCaseHostAccepted=true;}finally{if(configuredHost===undefined)delete process.env.GH_HOST;else process.env.GH_HOST=configuredHost;}
 const labeled=await readCodingDaemonMergeFacts(db,url);assert(labeled.ok);assert.deepEqual(labeled.labels,['bug','human-merge']);assert.equal(decideCodingDaemonMerge(labeled,policy).kind,'needs_human_signoff');
 publish({labels:[[]]});const passing=await readCodingDaemonMergeFacts(db,url);assert(passing.ok);assert.equal(decideCodingDaemonMerge(passing,policy).kind,'merge');evidence.facts={labeled,passing};
 for(const fail of ['/labels','/reviews','checks','graphql']){publish({fail});const unreadable=await readCodingDaemonMergeFacts(db,url);assert.equal(unreadable.ok,false);if(!unreadable.ok)assert.match(unreadable.reason,/: .+/, 'Unreadable merge facts need a readable explanation');}
 publish({finalHead:'b'.repeat(40)});assert.equal((await readCodingDaemonMergeFacts(db,url)).ok,false);evidence.readFailuresAndMovedHeadRefused=true;
 publish({race:true,pr:{...pr,headRefOid:'b'.repeat(40)},reviews:[[{...review,commit_id:'b'.repeat(40)}]],labels:[[]]});
 const raced=await readCodingDaemonMergeFacts(db,url);assert(raced.ok);assert.equal(raced.requiredCi.green,false,'Passing old-head checks must not be attached to the new head');evidence.exactHeadCiReadOrdered=true;
 db.exec('ALTER TABLE pack_coding_repo_aliases RENAME TO synthetic_unavailable_aliases');
 try{const unreadable=await readCodingDaemonMergeFacts(db,url);assert.equal(unreadable.ok,false);if(!unreadable.ok)assert.match(unreadable.reason,/: .+/, 'Reader exceptions need a readable explanation');}finally{db.exec('ALTER TABLE synthetic_unavailable_aliases RENAME TO pack_coding_repo_aliases');}
 evidence.readFailureExplained=true;
 const prepare=db.prepare.bind(db);let watching=false,mainSql=0;
 db.prepare=((sql:string)=>{if(watching&&sql.includes('pack_coding_daemon_merges')){mainSql++;throw new Error('Receipt SQL on main');}return prepare(sql);}) as typeof db.prepare;
 try{
 db.exec('BEGIN IMMEDIATE');held=true;watching=true;
 let replied=false;const pending=ledger.write('daemonMerge',{kind:'begin',url,head,actor:'daemon:synthetic',at:1});void pending.then(()=>{replied=true;});
 await new Promise(done=>setTimeout(done,75));assert.equal(replied,false);await hub.request('system.health',{});db.exec('ROLLBACK');held=false;
 assert.equal((await pending).length,1);evidence.commitBeforeReply=true;
 assert.deepEqual(await ledger.write('daemonMerge',{kind:'begin',url,head,actor:'other',at:2}),[]);
 assert.deepEqual(await ledger.write('daemonMerge',{kind:'notified',url,head,at:3}),[]);
 const receipt=await ledger.write('daemonMerge',{kind:'finish',url,head,commit:'c'.repeat(40),at:4});assert.equal(receipt[0].actor,'daemon:synthetic');assert.equal(receipt[0].startedAt,1);assert.equal(receipt[0].mergedAt,4);evidence.receipt=receipt[0];
 assert.deepEqual(await ledger.write('daemonMerge',{kind:'finish',url,head,commit:'d'.repeat(40),at:5}),[]);assert.equal(mainSql,0);evidence.mainSql=mainSql;
 }finally{watching=false;if(held){db.exec('ROLLBACK');held=false;}db.prepare=prepare;}
 await transport.close();transport=undefined;await app.cleanup();app=undefined;
 app=await createDaemonApp({config,verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();
 const restarted=new CodingPrLedgerRepository(app.db.getDatabase());const recovered=await restarted.write('daemonMerge',{kind:'list'});assert.deepEqual(recovered,[evidence.receipt]);evidence.receiptSurvivesRestart=true;
 await restarted.write('daemonMerge',{kind:'notified',url,head,at:6});assert.deepEqual(await restarted.write('daemonMerge',{kind:'list'}),[]);evidence.completedNotificationAcknowledged=true;
 const calls=readFileSync(join(run,'evidence/gh.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));assert(calls.every((args:string[])=>!args.includes('merge')));evidence.mergeCommands=0;evidence.verified=true;
}finally{await transport?.close();await app?.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;writeFileSync(join(run,'evidence/coding-daemon-merge-build.json'),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify(evidence));
