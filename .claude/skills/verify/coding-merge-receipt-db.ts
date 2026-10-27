import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { CodingAssignmentsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/assignments.ts';
import { prepareCodingMerge } from '../../../packages/daemon/src/lib/neo/packs/coding/merge-gates.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const [mode,directory]=process.argv.slice(2),run=resolve(directory);
assert(['before','verify'].includes(mode));
process.env.PATH=`${join(run,'bin')}:${process.env.PATH}`;
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
for (const name of ['evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
const url = 'https://github.com/synthetic/admission/pull/7', head = 'a'.repeat(40);
const author = { adapter: 'fixture', id: 'author' }, ref = { adapter: 'fixture', id: 'verifier' };
const actor = { kind: 'agent' as const, id: ref.id, model: 'gpt-6', harness: ref.adapter };
const pr = { url, body: 'Agent: gpt-6-sol (effort: high) via fixture', headRefOid: head, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', author: { login: 'author' }, changedFiles: 1, files: [{ path: 'src/change.ts' }], labels: [] };
const reviews = [{ state: 'APPROVED', commit_id: head, user: { login: 'fixture-bot', type: 'Bot' }, html_url: `${url}#review-1` }];
const checks = [{ bucket: 'pass', name: 'Required CI', link: `${url}/checks` }];
const threads = { headOid: head, unresolvedThreadUrls: [] as string[] };
const publish = (extra = {}) => writeFileSync(join(run, 'fixture.json'), JSON.stringify({ pr, reviews: [reviews], checks, threads, ...extra }));
publish();
writeFileSync(join(run, 'bin/gh'), `#!/usr/bin/env bun\nimport{readFileSync,writeFileSync,appendFileSync}from'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(join(run, 'evidence/gh.jsonl'))},JSON.stringify(args)+'\\n');const file=${JSON.stringify(join(run, 'fixture.json'))},f=JSON.parse(readFileSync(file,'utf8'));if(args[0]==='pr'&&args[1]==='view'){if(args.at(-1)==='headRefOid,state'&&f.changedHead)f.pr.headRefOid=f.changedHead;console.log(JSON.stringify(f.pr));}else if(args[0]==='pr'&&args[1]==='checks')console.log(JSON.stringify(f.checks));else if(args[0]==='api'&&args.includes('graphql')){console.log(JSON.stringify({data:{repository:{pullRequest:{url:f.pr.url,headRefOid:f.threads.headOid,reviewThreads:{nodes:f.threads.unresolvedThreadUrls.map(url=>({id:url,isResolved:false,comments:{nodes:[{url}]}})),pageInfo:{hasNextPage:false,endCursor:null}}}}}}));}else if(args[0]==='api'&&args.some(a=>a.endsWith('/reviews')))console.log(JSON.stringify(f.reviews));else process.exit(1);`, { mode: 0o700 });
const evidence: unknown[] = [];
const mainSql:string[]=[],commands:unknown[]=[];let measuring=false;
function instrument(){const raw=app.db.getDatabase(),prepare=raw.prepare.bind(raw),send=app.db.gateway.run.bind(app.db.gateway);raw.prepare=((sql:string)=>{if(measuring&&/pack_coding_delivery_facts/.test(sql))mainSql.push(sql);return prepare(sql);}) as typeof raw.prepare;app.db.gateway.run=(async(op,args)=>{const start=performance.now(),value=await send(op,args);if(op.name==='coding.mergeReceipt.commit')commands.push({name:op.name,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value)??'null')});return value;}) as typeof app.db.gateway.run;}
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
let app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready();await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);instrument();
  const db = app.db.getDatabase(), todos = new CodingTodoPrRepository(db), assignments = new CodingAssignmentsRepository(db);
  db.exec("INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES('ask','fixture-neo','Admission','Admission',1,1); INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES('todo','ask',1,'Admission','Gated delivery','doing',1,1)");
  new NeoTodoSessionRepository(db).bind('todo', author, 1);
  await todos.write('record', 'todo', [{ url, head, state: 'OPEN', checks: 'passing', review: 'approved' }], Date.now());
  await todos.write('claim', 'todo', [{ url, claim: 'named' }], 1);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = (name: string, input: unknown) => new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error(`RPC timeout: ${name}`)), 15000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); evidence.push({ name, input, reply }); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  assert.equal((await rpc('operations.describe', { name: 'neo.coding.merge.prepare' })).found, true, 'No supported merge admission door');
  const setting = (key: string, value: unknown) => rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/admission' }, key, value });
  await setting('reviewBot', 'fixture-bot'); await setting('mergePolicy', 'review_bot');
  const prepare = async () => {measuring=true;try{return await rpc('neo.coding.merge.prepare',{todoId:'todo',url});}finally{measuring=false;}};
  assert.equal((await prepare()).accepted, false);
  const assigned = await rpc('neo.coding.assign', { todoId: 'todo', url, head, acceptanceContract: 'artifact:acceptance', stage: 'review', candidates: [] });
  assert.equal(assigned.ok, true);
  assert(await assignments.recordLater('todo', 'qa', { url, head, newDispatch: true, acceptanceContract: 'artifact:acceptance', write: author, ref, actor }));
  assert.equal((await prepare()).accepted, false, 'Missing Verify must refuse despite bot and CI');
  assert.deepEqual(await rpc('neo.coding.result', { todoId: 'todo', ref, fact: { url, head, stage: 'verify', actor, verdict: 'pass', acceptanceContract: 'artifact:acceptance', evidence: ['artifact:verify'] } }), { ok: true });
  for (const bad of [
    { checks: [{ ...checks[0], bucket: 'pending' }] },
    { checks: [{ ...checks[0], bucket: 'fail' }] },
    { reviews: [[{ ...reviews[0], commit_id: 'b'.repeat(40) }]] },
    { reviews: [[...reviews, { ...reviews[0], state: 'CHANGES_REQUESTED' }]] },
    { threads: { ...threads, unresolvedThreadUrls: [`${url}#finding`] } },
    { changedHead: 'b'.repeat(40) },
  ]) { publish(bad); assert.equal((await prepare()).accepted, false, JSON.stringify(bad)); }
  publish(); await setting('humanSignoff', ['src/**']);
  assert.equal((await prepare()).accepted, false, 'Applicable human sign-off required');
  publish({ reviews: [[{ ...reviews[0], user: null }], reviews, [{ ...reviews[0], user: { login: 'human', type: 'User' }, html_url: `${url}#human` }]] });
  const admitted = await prepare();
  assert.equal(admitted.accepted, true); assert.equal(admitted.head, head);
  assert.deepEqual(admitted.command, ['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head]);
  assert(todos.deliveryFacts.read('todo', url, head)?.gate.evidence.includes(`${url}#human`));
  assert.equal(db.prepare("SELECT state FROM neo_todos WHERE id='todo'").get().state, 'doing');
  const receipt=todos.deliveryFacts.read('todo',url,head);assert(receipt);
  assert.equal((await prepare()).accepted,true,'Compatible retry must reuse its receipt');
  ws.close();await app.cleanup();
  app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.spaceRuntimeService.ready();await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);instrument();
  ws=new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('Reopen connect failed'));});
  assert.equal((await prepare()).accepted,true,'Reopened daemon must retain its admissible receipt');
  const stored=new CodingTodoPrRepository(app.db.getDatabase()).deliveryFacts;assert.deepEqual(stored.read('todo',url,head),receipt);
  const altered={...receipt.gate,qa:{adapter:'fixture',id:'conflicting-qa'}};
  app.db.getDatabase().prepare('UPDATE pack_coding_delivery_facts SET gate_json=? WHERE todo_id=?').run(JSON.stringify(altered),'todo');
  assert.equal((await prepare()).accepted,false,'Conflicting immutable receipt must refuse');assert.deepEqual(stored.read('todo',url,head)?.gate,altered);
  app.db.getDatabase().exec("INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES('race','ask',2,'Race','One winner','doing',1,1)");
  const largeEvidence='artifact:'+('甲乙🙂'.repeat(5000));
  const candidate={url,head,open:true,requiredCiGreen:true,findingsResolved:true,humanSignoffSatisfied:true,ciEvidence:[`${url}/checks`],reviewEvidence:[`${url}#review-1`]};
  app.jobProcessor.register('verify.merge.receipt',async()=>{
    const repo=new CodingTodoPrRepository(app.db.getDatabase()).deliveryFacts;
    const outcomes=await Promise.all(['qa-first','qa-second'].map(id=>{const qa={adapter:'fixture',id};return prepareCodingMerge(repo,'race',candidate,{reference:'artifact:race',write:author,qa,bot:'fixture-bot'},{kind:'bot',head,login:'fixture-bot',approved:true},[{url,head,stage:'qa',ref:qa,actor:{kind:'agent',id,harness:'fixture',model:'synthetic-model'},verdict:'pass',acceptanceContract:'artifact:race',evidence:[largeEvidence]}],async()=>head);}));
    return {outcomes};
  });
  const job=app.jobQueue.enqueue({queue:'verify.merge.receipt',payload:{},maxRetries:0,priority:100});measuring=true;await app.jobProcessor.start();
  let result:unknown;
  try{for(let i=0;i<300;i++){const current=app.jobQueue.getJob(job.id)!;if(current.status==='completed'){result=current.result;break;}if(current.error)throw new Error(current.error);await new Promise(done=>setTimeout(done,25));}}finally{await app.jobProcessor.stop();measuring=false;}
  assert(result,'Race job did not complete');const race=(result as {outcomes:{accepted:boolean;reason?:string}[]}).outcomes;assert.equal(race.filter(value=>value.accepted).length,1);assert(race.some(value=>value.reason==='merge_receipt_changed'));
  const winning=stored.read('race',url,head);assert(winning?.gate.evidence.includes(largeEvidence));
  if(mode==='verify'){assert.deepEqual(mainSql,[],'Merge receipt recording and validation must leave main');assert(commands.length>=6);}else assert(mainSql.length>0,'Baseline must reproduce merge receipt reads on main');
  evidence.push({verified:true,receipt,conflict:altered,race,largeEvidenceBytes:Buffer.byteLength(largeEvidence),limitation:'Real merge-prepare RPC and persisted race job; synthetic GitHub, assignments and QA. No real merge, model, harness or deployment. Target instrumentation covers receipt SQL only.'});
} catch (error) { evidence.push({ error: String(error) }); throw error; }
finally { ws?.close(); await app.cleanup(); globalThis.fetch = network; writeFileSync(join(run, 'evidence/coding-merge-receipt-db.json'), JSON.stringify({mode,verified:evidence.some((item:any)=>item.verified===true),events:evidence,mainSql,commands}, null, 2)); }
