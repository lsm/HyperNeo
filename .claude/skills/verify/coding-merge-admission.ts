import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { CodingAssignmentsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/assignments.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
for (const name of ['evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
const url = 'https://github.com/synthetic/admission/pull/7', head = 'a'.repeat(40);
const author = { adapter: 'fixture', id: 'author' }, ref = { adapter: 'fixture', id: 'verifier' };
const actor = { kind: 'agent' as const, id: ref.id, model: 'gpt-6', harness: ref.adapter };
const pr = { url, body: 'Agent: GPT-6 via fixture', headRefOid: head, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', author: { login: 'author' }, changedFiles: 1, files: [{ path: 'src/change.ts' }], labels: [] };
const reviews = [{ state: 'APPROVED', commit_id: head, user: { login: 'fixture-bot', type: 'Bot' }, html_url: `${url}#review-1` }];
const checks = [{ bucket: 'pass', name: 'Required CI', link: `${url}/checks` }];
const threads = { headOid: head, unresolvedThreadUrls: [] as string[] };
const publish = (extra = {}) => writeFileSync(join(run, 'fixture.json'), JSON.stringify({ pr, reviews: [reviews], checks, threads, ...extra }));
publish();
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}\nimport{readFileSync,writeFileSync,appendFileSync}from'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(join(run, 'evidence/gh.jsonl'))},JSON.stringify(args)+'\\n');const file=${JSON.stringify(join(run, 'fixture.json'))},f=JSON.parse(readFileSync(file,'utf8'));if(args[0]==='pr'&&args[1]==='view'){if(args.at(-1)==='headRefOid,state'&&f.changedHead)f.pr.headRefOid=f.changedHead;console.log(JSON.stringify(f.pr));}else if(args[0]==='pr'&&args[1]==='checks')console.log(JSON.stringify(f.checks));else if(args[0]==='api'&&args.includes('graphql')){console.log(JSON.stringify({data:{repository:{pullRequest:{url:f.pr.url,headRefOid:f.threads.headOid,reviewThreads:{nodes:f.threads.unresolvedThreadUrls.map(url=>({id:url,isResolved:false,comments:{nodes:[{url}]}})),pageInfo:{hasNextPage:false,endCursor:null}}}}}}));}else if(args[0]==='api'&&args.some(a=>a.endsWith('/reviews')))console.log(JSON.stringify(f.reviews));else process.exit(1);`, { mode: 0o700 });
const evidence: unknown[] = [];
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
try {
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
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
  const prepare = () => rpc('neo.coding.merge.prepare', { todoId: 'todo', url });
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
  publish({ reviews: [[...reviews, { ...reviews[0], user: { login: 'human', type: 'User' }, html_url: `${url}#human` }]] });
  const admitted = await prepare();
  assert.equal(admitted.accepted, true); assert.equal(admitted.head, head);
  assert.deepEqual(admitted.command, ['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head]);
  assert(todos.deliveryFacts.read('todo', url, head)?.gate.evidence.includes(`${url}#human`));
  assert.equal(db.prepare("SELECT state FROM neo_todos WHERE id='todo'").get().state, 'doing');
  evidence.push({ verified: true, receipt: todos.deliveryFacts.read('todo', url, head), limitation: 'Synthetic GitHub and persisted Verify assignment; no real harness/model or merge/deploy. Actor dispatch has its separate journey.' });
  console.log('PASS: actual merge admission RPC refuses missing Verify, stale/negative bot review, CI failure/pending, unresolved findings, missing human sign-off and changed head; returns only a recorded SHA-pinned manual command.');
} catch (error) { evidence.push({ error: String(error) }); throw error; }
finally { ws?.close(); await app.cleanup(); globalThis.fetch = network; writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
