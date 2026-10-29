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

const run=resolve(process.argv.at(-1)!),host=process.argv[2]==='enterprise'?'ghe.company.test':'github.com',url=`https://${host}/synthetic/merge/pull/7`,head='a'.repeat(40);
if(host!=='github.com')process.env.GH_HOST=host;
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
for(const dir of ['evidence','bin'])mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const pr={url,body:'',state:'OPEN',headRefOid:head,isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',author:{login:'author'},changedFiles:1,files:[{path:'src/app.ts'}],labels:[],mergeCommit:null};
const review={state:'APPROVED',commit_id:head,user:{login:'fixture-bot',type:'Bot'},html_url:url+'#review'};
const publish=(extra={})=>writeFileSync(join(run,'fixture.json'),JSON.stringify({pr,reviews:[[review]],labels:[[{name:'bug'}],[{name:'human-merge'}]],...extra}));publish();
writeFileSync(join(run,'bin/gh'),`#!/usr/bin/env bun
import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';const args=process.argv.slice(2),f=JSON.parse(readFileSync(${JSON.stringify(join(run,'fixture.json'))},'utf8'));appendFileSync(${JSON.stringify(join(run,'evidence/gh.jsonl'))},JSON.stringify(args)+'\\n');if(f.fail&&args.some(a=>a.includes(f.fail)))process.exit(1);const host=args.indexOf('--hostname');if(host>=0&&args[host+1]!==args[host+1].toLowerCase())process.exit(1);if(args[0]==='pr'&&args[1]==='merge'){if(args.at(-1)!==f.pr.headRefOid||args.at(-2)!=='--match-head-commit'||!args.includes('--squash'))process.exit(2);f.pr.state='MERGED';f.pr.mergeCommit={oid:'c'.repeat(40)};writeFileSync(${JSON.stringify(join(run,'fixture.json'))},JSON.stringify(f));process.exit(0);}else if(args[0]==='pr'&&args[1]==='edit'){f.labels=[args.includes('--add-label')?[{name:'human-merge'}]:[]];writeFileSync(${JSON.stringify(join(run,'fixture.json'))},JSON.stringify(f));process.exit(0);}else if(args[0]==='pr'&&args[1]==='view'){if(f.race&&args.at(-1)!=='headRefOid,state'){await new Promise(done=>setTimeout(done,80));writeFileSync(${JSON.stringify(join(run,'pr-observed'))},'1');}console.log(JSON.stringify(args.at(-1)==='headRefOid,state'?{headRefOid:f.finalHead||f.pr.headRefOid,state:f.pr.state}:f.pr));}else if(args[0]==='pr'&&args[1]==='checks')console.log(JSON.stringify([{bucket:f.race&&existsSync(${JSON.stringify(join(run,'pr-observed'))})?'pending':'pass',name:'Required',link:f.pr.url+'/checks'}]));else if(args.some(a=>a.endsWith('/reviews')))console.log(JSON.stringify(f.reviews));else if(args.some(a=>a.endsWith('/labels')))console.log(JSON.stringify(f.labels));else if(args.includes('graphql'))console.log(JSON.stringify({data:{repository:{pullRequest:{url:f.pr.url,headRefOid:f.pr.headRefOid,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}}));else process.exit(1);
`,{mode:0o700});
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('External HTTP forbidden');}) as typeof fetch;
const config=getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')});
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,transport:WebSocketClientTransport|undefined,held=false;
const evidence:Record<string,unknown>={verified:false,executorActivated:false};
try{
 app=await createDaemonApp({config,verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`});hub.registerTransport(transport);await transport.connect();
 const rpc=(name:string,input:unknown)=>hub.request<{ok:boolean}>('operation.invoke',{name,input});
 for(const[key,value]of Object.entries({mergeBy:'daemon',mergePolicy:'review_bot',reviewBot:'fixture-bot',humanSignoff:['label:human-merge']}))assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key,value})).ok);
 assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'global',key:''},key:'watchedRepos',value:['synthetic/merge']})).ok);
 const db=app.db.getDatabase(),ledger=new CodingPrLedgerRepository(db);

 const notices:string[]=[];let deliver=true,rejectSignoff=true;
 const snapshot=()=>JSON.parse(readFileSync(join(run,'fixture.json'),'utf8'));
 const makePack=()=>createCodingPack({database:()=>db,readPrs:async()=>[],readClaudeOwners:async()=>[],todoPrs:new CodingTodoPrRepository(db),prLedger:ledger,prEvents:new CodingPrEventRepository(db),prSweep:new CodingPrSweepRepository(db),projectRepos:()=>['synthetic/merge'],prSweepDeps:{tell:async()=>false,wake:async(_key,text)=>{if(rejectSignoff&&text.includes('requires human sign-off')){rejectSignoff=false;throw new Error('Synthetic mailbox unavailable');}if(deliver)notices.push(text);return deliver;}},readLedgerRepo:async()=>{
 const node={number:7,title:'Synthetic daemon merge',headRefName:'fixture',headRefOid:head,state:'OPEN',isDraft:false,mergeable:'MERGEABLE',reviewDecision:'APPROVED',closedAt:null,files:{nodes:[{path:'src/app.ts'}],pageInfo:{hasNextPage:false}},labels:{nodes:[],pageInfo:{hasNextPage:false}},reviews:{nodes:[{state:'APPROVED',commit:{oid:head},author:{login:'fixture-bot'}}]},commits:{nodes:[{commit:{statusCheckRollup:{state:'SUCCESS'}}}]}};
 return {data:{rateLimit:{remaining:5000},repository:{nameWithOwner:'synthetic/merge',open:{pageInfo:{hasNextPage:false},nodes:[node]},done:{nodes:[]}}}};
 }});
 const pack=makePack();let preferences=await rpc('pack.preferences.list',{});let tick=Date.now();
 const runSweep=()=>pack.sweep!(tick+=61_000);
 const mergeCalls=()=>readFileSync(join(run,'evidence/gh.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(args=>args[0]==='pr'&&args[1]==='merge');
 await runSweep();assert.equal(mergeCalls().length,0);assert.equal(rejectSignoff,false);assert(!notices.some(text=>text.includes('sign-off')));await runSweep();assert(notices.some(text=>text.includes('sign-off')));evidence.laterPageHumanLabelHeld=true;evidence.signoffDeliveryFailureRetried=true;
 publish({labels:[[]]});assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key:'mergePolicy',value:'human'})).ok);const humanPreferences=await rpc('pack.preferences.list',{}),beforeHuman=notices.length;await runSweep();assert.equal(ledger.list()[0].state,'waiting_human');assert(notices.length>beforeHuman);assert.equal(mergeCalls().length,0);assert.deepEqual(await rpc('pack.preferences.list',{}),humanPreferences);evidence.humanPolicySurfaced=true;assert((await rpc('pack.preferences.set',{pack:'coding',scope:{kind:'repo',key:'synthetic/merge'},key:'mergePolicy',value:'review_bot'})).ok);preferences=await rpc('pack.preferences.list',{});
 for(const fail of ['/labels','/reviews','checks','graphql','view']){publish({fail,labels:[[]]});await runSweep();assert.equal(mergeCalls().length,0);assert.deepEqual(await ledger.write('daemonMerge',{kind:'list'}),[]);}evidence.readFailuresHeld=true;
 publish({labels:[[]],finalHead:'b'.repeat(40)});await runSweep();assert.equal(mergeCalls().length,0);evidence.movedHeadHeld=true;
 publish({labels:[[]]});deliver=false;await runSweep();assert.equal(mergeCalls().length,1);const receipt=(await ledger.write('daemonMerge',{kind:'list'}))[0];assert.equal(receipt.head,head);assert.equal(receipt.actor,'daemon:coding-sweep');assert.equal(receipt.mergeCommit,'c'.repeat(40));evidence.receipt=receipt;
 deliver=true;await runSweep();await runSweep();assert.equal(mergeCalls().length,1);assert.deepEqual(await ledger.write('daemonMerge',{kind:'list'}),[]);assert(notices.some(text=>text.includes(head)&&text.includes('merged by')));evidence.notificationRetriedWithoutDuplicateMerge=true;
 const label=pack.operations!.find(op=>op.name==='neo.coding.merge.human')!;
 assert.deepEqual(await label.execute({url,enabled:true},{role:'neo'} as never),{accepted:true});assert.deepEqual(snapshot().labels,[[{name:'human-merge'}]]);
 assert.deepEqual(await label.execute({url,enabled:false},{role:'neo'} as never),{accepted:true});assert.deepEqual(snapshot().labels,[[]]);evidence.explicitHumanIntentLabelTool=true;
 assert.deepEqual(await rpc('pack.preferences.list',{}),preferences);assert.equal(pack.preferences!.mergeBy.default,'owner');evidence.savedPreferencesUnchanged=true;assert(mergeCalls().every(args=>args[2]===url));evidence.host=host;evidence.mergeCommands=mergeCalls();evidence.executorActivated=true;evidence.verified=true;
}finally{await transport?.close();await app?.cleanup();globalThis.fetch=network;evidence.resourcesStopped=true;writeFileSync(join(run,'evidence/coding-daemon-merge-sweep.json'),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify(evidence));
