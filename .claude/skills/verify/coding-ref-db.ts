import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { CodingRefFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/ref-facts.ts';
import { codingRefWrites } from '../../../packages/daemon/src/lib/neo/packs/coding/ref-facts-db.ts';
import type { NeoRefState } from '../../../packages/daemon/src/lib/neo/packs/coding/ask-prs.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const [mode,directory,scenario='public']=process.argv.slice(2);assert(['before','verify'].includes(mode));assert(['public','section'].includes(scenario));
const run=resolve(directory);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(!existsSync(join(run,'data/daemon.db')));
assert.equal(process.env.GH_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);
for(const dir of ['home','bin','evidence'])mkdirSync(join(run,dir),{recursive:true});
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
const original=readFileSync(fileURLToPath(new URL('./github-ledger-gh.ts',import.meta.url)),'utf8');
assert(original.includes("if (phase === 'failed')"));
const stub=original.replace("appendFileSync(join(root, 'evidence'", "if(['ask-reference','issue-reference'].includes(family))await Bun.sleep(300);\nappendFileSync(join(root, 'evidence'")
  .replace("process.stderr.write('unsupported synthetic request'); process.exit(2);", "appendFileSync(join(root,'evidence','requests.jsonl'),JSON.stringify({phase,family:'unsupported',args})+String.fromCharCode(10));process.stderr.write('unsupported synthetic request');process.exit(2);")
  .replace('JSON.stringify({ phase, family, graphqlCost:', 'JSON.stringify({ phase, family, args, graphqlCost:')
  .replace("defaultBranchRef: { name: 'dev' }", "defaultBranchRef: { name: phase==='changed'?'main':'dev' }")
  .replace("__typename: 'Issue', url:", "__typename: 'Issue', title: 'Synthetic epic', url:");
const gated=stub.replace("if(['ask-reference','issue-reference'].includes(family))", "if(phase==='late'&&family==='ask-reference'){appendFileSync(join(root,'late-start'),'ready');while(readFileSync(join(root,'late-release'),'utf8')!=='release')await Bun.sleep(10);};if(['ask-reference','issue-reference'].includes(family))");
writeFileSync(join(run,'late-release'),'waiting');
writeFileSync(join(run,'bin/gh'),gated,{mode:0o700});
const now=Date.now(),url='https://github.com/synthetic/ledger/pull/7';
const control=(phase:string)=>writeFileSync(join(run,'fixture.json'),JSON.stringify({phase,scenario:'head',now}));
control('initial');
const evidence:Record<string,any>={mode,scenario};
let measuring=false,maxLagMs=0,last=performance.now();
const mainSql:string[]=[],commands:string[]=[],rpcMetrics:{name:string;durationMs:number}[]=[];
const timer=setInterval(()=>{const t=performance.now();if(measuring)maxLagMs=Math.max(maxLagMs,t-last-10);last=t;},10);
let outstanding:Promise<unknown>|undefined,lock:ReturnType<typeof spawn>|undefined;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined;
const waiting=new Map<string,{done:(value:any)=>void,fail:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('No real HTTP in synthetic proof');}) as typeof fetch;
async function open(){
  app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
  await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
  const db=app.db.getDatabase(),prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{if(measuring&&(/pack_coding_ref_facts/.test(sql)||(sql==='SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?'&&new Error().stack?.includes('/ref-facts.ts'))))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
  const send=app.db.gateway.run.bind(app.db.gateway);
  app.db.gateway.run=(async(op,args)=>{const result=await send(op,args);if(op.name.startsWith('coding.ref.'))commands.push(op.name);return result;}) as typeof app.db.gateway.run;
  ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('connect'));});
  ws.onmessage=event=>{const msg=JSON.parse(String(event.data)),id=waiting.has(msg.requestId)?msg.requestId:msg.id,held=waiting.get(id);if(!held)return;waiting.delete(id);clearTimeout(held.timer);if(msg.error)held.fail(new Error(JSON.stringify(msg.error)));else held.done(msg.data);};
}
const read=(input:unknown={url:url.replace('/pull/','/issues/')},name='neo.github.read',raw=false)=>new Promise<any>((done,fail)=>{
  const started=performance.now(),id=crypto.randomUUID(),timer=setTimeout(()=>{waiting.delete(id);fail(new Error('RPC timeout'));},15000);
  waiting.set(id,{done:(value)=>{if(measuring)rpcMetrics.push({name,durationMs:performance.now()-started});done(value);},fail,timer});
  ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:raw?name:'operation.invoke',data:raw?input:{name,input},timestamp:new Date().toISOString(),version:'1.0.0'}));
});
const requests=()=>readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const stored=()=>{const was=measuring;measuring=false;try{return app!.db.getDatabase().prepare("SELECT * FROM pack_coding_ref_facts WHERE json_extract(subject,'$.number')=7").get();}finally{measuring=was;}};
try{
  await open();measuring=true;evidence.fanout=await Promise.all(Array.from({length:5},()=>read()));
  for(const result of evidence.fanout)assert.deepEqual(result,{ok:true,kind:'pr',url,state:'OPEN',checks:'passing',review:'approved',blockers:['1 unresolved review thread'],title:'Synthetic shared fact'});
  evidence.initialRequests=requests();evidence.refLookups=evidence.initialRequests.filter((r:any)=>r.family==='ask-reference').length;
  assert.equal(evidence.refLookups,1,'Concurrent public reference reads must share one ledger acquisition');
  evidence.firstStored=stored();
  const issue='https://github.com/synthetic/ledger/issues/3';
  if(scenario==='section'){
    measuring=false;
    const repo=new NeoRepository(app!.db.getDatabase());repo.saveProject({id:'synthetic-project',title:'Synthetic project',summary:'Synthetic',context:'Retained'},0);
    app!.db.getDatabase().prepare('INSERT INTO neo_project_workspaces(alias,project_id) VALUES(?,?)').run('repo:synthetic/ledger'+String.fromCharCode(0)+'history','synthetic-project');
    evidence.aliasRoundTrip=app!.db.getDatabase().prepare('SELECT alias,hex(alias) AS encoded FROM neo_project_workspaces WHERE project_id=?').all('synthetic-project');
    measuring=true;control('issue');[evidence.issue,evidence.section]=await Promise.all([read({url:issue}),read({parentId:'synthetic-project',epicUrl:issue},'neo.project.section')]);
    assert.equal(evidence.section.ok,true,JSON.stringify(evidence.section));assert.equal(repo.getProject(evidence.section.projectId)?.title,'Synthetic epic');
  }else{
    control('issue');[evidence.issue,evidence.issuePeer]=await Promise.all([read({url:issue}),read({url:issue})]);
    assert.deepEqual(evidence.issuePeer,evidence.issue);
  }
  assert.deepEqual(evidence.issue,{ok:true,kind:'issue',url:issue,state:'CLOSED',closedAs:'completed',closedBy:url,parent:'https://github.com/synthetic/ledger/issues/1'});
  evidence.issueLookups=requests().filter((r:any)=>r.phase==='issue'&&r.family==='issue-reference').length;assert.equal(evidence.issueLookups,1,'Issue consumers must share their reference acquisition');
  control('changed');evidence.changed=await read();assert.equal(evidence.changed.review,'none');evidence.changedStored=stored();assert.equal(JSON.parse(evidence.changedStored.value_json).defaultBase,'main');
  control('failed');evidence.failed=await read();assert.equal(evidence.failed.ok,false);assert.match(evidence.failed.reason,/unreadable/);
  evidence.failedStored=stored();assert.equal(evidence.failedStored.value_json,evidence.changedStored.value_json);assert.equal(evidence.failedStored.observed_at,evidence.changedStored.observed_at);assert.equal(evidence.failedStored.reason,'failed');
  ws!.close();await app!.cleanup();app=undefined;control('reopen');await open();evidence.retained=stored();assert.equal(evidence.retained.value_json,evidence.failedStored.value_json);
  evidence.reopened=await read();assert.equal(evidence.reopened.ok,true);evidence.reopenedStored=stored();assert.equal(evidence.reopenedStored.reason,null);
  evidence.requests=requests();evidence.counts=Object.fromEntries(['initial','changed','failed','reopen'].map(phase=>[phase,evidence.requests.filter((r:any)=>r.phase===phase&&r.family==='ask-reference').length]));
  assert.deepEqual(evidence.counts,{initial:1,changed:1,failed:1,reopen:1});
  if(mode==='verify'){
    control('late');measuring=true;
    const facts=new CodingRefFactsRepository(app!.db.getDatabase()),ref={owner:'synthetic',repo:'ledger',number:7};
    const snapshot=await facts.readCurrent(ref);
    const pending=facts.refresh(ref);outstanding=pending;
    const until=Date.now()+5000;while(!existsSync(join(run,'late-start'))){assert(Date.now()<until,'late collector started');await new Promise(done=>setTimeout(done,10));}
    const value:NeoRefState={url,kind:'pr',state:'OPEN',at:null,done:false,closedBy:null,defaultBase:'winning-base'};
    const winner=await app!.db.gateway.call(codingRefWrites,'observe',ref,snapshot.observationRevision,value,Date.now());
    writeFileSync(join(run,'late-release'),'release');const late=await pending;outstanding=undefined;
    assert.deepEqual(late,winner);assert.equal(winner.observationRevision,snapshot.observationRevision+1);
    evidence.fence={before:snapshot.observationRevision,after:winner.observationRevision,winningValue:winner.view.status==='known'?winner.view.value:null};
    control('held');
    lock=spawn('/usr/bin/python3',['-c',"import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()",join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
    const released=new Promise<void>((done,fail)=>{lock!.once('error',fail);lock!.once('exit',code=>code===0?done():fail(new Error('synthetic writer failed')));});
    await new Promise<void>(done=>lock!.stdout!.once('data',()=>done()));
    const start=performance.now(),held=facts.refresh(ref);outstanding=held;
    await new Promise(done=>setTimeout(done,400));
    const healthStart=performance.now();evidence.health=await read({},'system.health',true);const healthMs=performance.now()-healthStart;
    assert.equal((await held).view.status,'known');outstanding=undefined;const writeMs=performance.now()-start;await released;lock=undefined;
    evidence.contention={healthMs,writeMs,affectedWriteUnder250ms:writeMs<250};assert(healthMs<250);assert(writeMs>1000);
    assert.equal(mainSql.length,0,'reference cache, snapshot, admission and persistence SQL must leave main');
    assert(commands.includes('coding.ref.observe'));assert(maxLagMs<1000);
  }else assert(mainSql.length>0,'baseline must reproduce reference SQL on main');
  evidence.mainSql=mainSql;evidence.commands=commands;evidence.rpcMetrics=rpcMetrics;evidence.maxLagMs=maxLagMs;evidence.verified=true;
  console.log(JSON.stringify({verified:true,counts:evidence.counts,issueLookups:evidence.issueLookups,path:join(run,'evidence/coding-ref-db.json')}));
}finally{
  measuring=false;writeFileSync(join(run,'late-release'),'release');lock?.kill();await outstanding?.catch(()=>{});clearInterval(timer);
  evidence.mainSql=mainSql;evidence.commands=commands;evidence.rpcMetrics=rpcMetrics;evidence.maxLagMs=maxLagMs;
  if(existsSync(join(run,'evidence/requests.jsonl')))evidence.requests=requests();
  writeFileSync(join(run,'evidence/coding-ref-db.json'),JSON.stringify(evidence,null,2));
  for(const held of waiting.values())clearTimeout(held.timer);waiting.clear();ws?.close();await app?.cleanup();globalThis.fetch=network;
}
