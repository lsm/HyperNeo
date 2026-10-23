import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run=resolve(process.argv[2]);
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
writeFileSync(join(run,'bin/gh'),stub,{mode:0o700});
const now=Date.now(),url='https://github.com/synthetic/ledger/pull/7';
const control=(phase:string)=>writeFileSync(join(run,'fixture.json'),JSON.stringify({phase,scenario:'head',now}));
control('initial');
const evidence:Record<string,any>={};
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined,ws:WebSocket|undefined;
const waiting=new Map<string,{done:(value:any)=>void,fail:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('No real HTTP in synthetic proof');}) as typeof fetch;
async function open(){
  app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
  await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);
  ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('connect'));});
  ws.onmessage=event=>{const msg=JSON.parse(String(event.data)),id=waiting.has(msg.requestId)?msg.requestId:msg.id,held=waiting.get(id);if(!held)return;waiting.delete(id);clearTimeout(held.timer);if(msg.error)held.fail(new Error(JSON.stringify(msg.error)));else held.done(msg.data);};
}
const read=(input:unknown={url:url.replace('/pull/','/issues/')},name='neo.github.read')=>new Promise<any>((done,fail)=>{
  const id=crypto.randomUUID(),timer=setTimeout(()=>{waiting.delete(id);fail(new Error('RPC timeout'));},15000);
  waiting.set(id,{done,fail,timer});
  ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'operation.invoke',data:{name,input},timestamp:new Date().toISOString(),version:'1.0.0'}));
});
const requests=()=>readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const stored=()=>app!.db.getDatabase().prepare("SELECT * FROM pack_coding_ref_facts WHERE json_extract(subject,'$.number')=7").get();
try{
  await open();evidence.fanout=await Promise.all(Array.from({length:5},()=>read()));
  for(const result of evidence.fanout)assert.deepEqual(result,{ok:true,kind:'pr',url,state:'OPEN',checks:'passing',review:'approved',blockers:['1 unresolved review thread'],title:'Synthetic shared fact'});
  evidence.initialRequests=requests();evidence.refLookups=evidence.initialRequests.filter((r:any)=>r.family==='ask-reference').length;
  assert.equal(evidence.refLookups,1,'Concurrent public reference reads must share one ledger acquisition');
  evidence.firstStored=stored();
  const repo=new NeoRepository(app!.db.getDatabase());repo.saveProject({id:'synthetic-project',title:'Synthetic project',summary:'Synthetic',context:'Retained'},0);app!.db.getDatabase().prepare('INSERT INTO neo_project_workspaces(alias,project_id) VALUES(?,?)').run('repo:synthetic/ledger'+String.fromCharCode(0)+'history','synthetic-project');
  const issue='https://github.com/synthetic/ledger/issues/3';
  control('issue');[evidence.issue,evidence.section]=await Promise.all([read({url:issue}),read({parentId:'synthetic-project',epicUrl:issue},'neo.project.section')]);
  assert.deepEqual(evidence.issue,{ok:true,kind:'issue',url:issue,state:'CLOSED',closedAs:'completed',closedBy:url,parent:'https://github.com/synthetic/ledger/issues/1'});
  assert.equal(evidence.section.ok,true,JSON.stringify(evidence.section));assert.equal(repo.getProject(evidence.section.projectId)?.title,'Synthetic epic');
  evidence.issueLookups=requests().filter((r:any)=>r.phase==='issue'&&r.family==='issue-reference').length;assert.equal(evidence.issueLookups,1,'Project and detail must share their reference acquisition');
  control('changed');evidence.changed=await read();assert.equal(evidence.changed.review,'none');evidence.changedStored=stored();assert.equal(JSON.parse(evidence.changedStored.value_json).defaultBase,'main');
  control('failed');evidence.failed=await read();assert.equal(evidence.failed.ok,false);assert.match(evidence.failed.reason,/unreadable/);
  evidence.failedStored=stored();assert.equal(evidence.failedStored.value_json,evidence.changedStored.value_json);assert.equal(evidence.failedStored.observed_at,evidence.changedStored.observed_at);assert.equal(evidence.failedStored.reason,'failed');
  ws!.close();await app!.cleanup();app=undefined;control('reopen');await open();evidence.retained=stored();assert.equal(evidence.retained.value_json,evidence.failedStored.value_json);
  evidence.reopened=await read();assert.equal(evidence.reopened.ok,true);evidence.reopenedStored=stored();assert.equal(evidence.reopenedStored.reason,null);
  evidence.requests=requests();evidence.counts=Object.fromEntries(['initial','changed','failed','reopen'].map(phase=>[phase,evidence.requests.filter((r:any)=>r.phase===phase&&r.family==='ask-reference').length]));
  assert.deepEqual(evidence.counts,{initial:1,changed:1,failed:1,reopen:1});evidence.verified=true;
  console.log(JSON.stringify({verified:true,counts:evidence.counts,issueLookups:evidence.issueLookups,path:join(run,'evidence/ref-ledger.json')}));
}finally{
  if(existsSync(join(run,'evidence/requests.jsonl')))evidence.requests=requests();
  writeFileSync(join(run,'evidence/ref-ledger.json'),JSON.stringify(evidence,null,2));
  for(const held of waiting.values())clearTimeout(held.timer);waiting.clear();ws?.close();await app?.cleanup();globalThis.fetch=network;
}
