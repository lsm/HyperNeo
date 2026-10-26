import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { CodingQueryFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/query-facts.ts';
import { codingQueryReads, codingQueryWrites } from '../../../packages/daemon/src/lib/neo/packs/coding/query-facts-db.ts';
import type { NeoGithubCollection } from '../../../packages/daemon/src/lib/neo/packs/coding/github-query.ts';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const [mode,directory]=process.argv.slice(2);assert(['before','verify'].includes(mode));
const run=resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
for (const dir of ['home', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
writeFileSync(join(run, 'bin/gh'), `#!/usr/bin/env bun
import {readFileSync,appendFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
const root=dirname(dirname(process.argv[1])),args=process.argv.slice(2);
const phase=readFileSync(join(root,'phase'),'utf8');
appendFileSync(join(root,'evidence/requests.jsonl'),JSON.stringify({phase,args})+'\\n');
if(!['pr','issue'].includes(args[0])||args[1]!=='list'){process.stderr.write('unsupported synthetic request');process.exit(2);}
if(phase==='late'){appendFileSync(join(root,'late-start'),'ready');while(readFileSync(join(root,'late-release'),'utf8')!=='release')await Bun.sleep(10);}
await Bun.sleep(300);
if(phase==='failed'){process.stderr.write('synthetic unavailable');process.exit(1);}
const item=n=>({number:n,title:phase==='changed'?'Changed '+n:'Synthetic '+n,url:'https://github.com/synthetic/ledger/pull/'+n,state:'MERGED',createdAt:'2026-10-15T11:00:00Z',updatedAt:'2026-10-15T11:00:00Z',mergedAt:'2026-10-15T11:00:00Z',closedAt:'2026-10-15T11:00:00Z'});
process.stdout.write(JSON.stringify(phase==='empty'?[]:phase==='malformed'?{unexpected:true}:[item(3),item(2),item(1)]));
`, { mode: 0o700 });
const explicit = { repo: 'synthetic/ledger', state: 'merged', since: '2026-10-15T10:00:00Z', until: '2026-10-15T12:00:00Z', limit: 2 };
let input: Record<string,unknown> = explicit;
writeFileSync(join(run,'late-release'),'waiting');
const control = (phase: string) => writeFileSync(join(run, 'phase'), phase);
control('initial');
const evidence: Record<string, any> = {mode};
let measuring=false,maxLagMs=0,last=performance.now();
const mainSql:string[]=[],commands:string[]=[],rpcMetrics:{name:string;durationMs:number}[]=[],gatewayMetrics:Record<string,unknown>[]=[];
const rssBefore=process.memoryUsage().rss;
const timer=setInterval(()=>{const t=performance.now();if(measuring)maxLagMs=Math.max(maxLagMs,t-last-10);last=t;},10);
let outstanding:Promise<unknown>|undefined,lock:ReturnType<typeof spawn>|undefined;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const waiting = new Map<string, { done: (value: any) => void; fail: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No real HTTP in synthetic proof'); }) as typeof fetch;
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.spaceRuntimeService.ready();await app.jobProcessor.stop();
  const db=app.db.getDatabase(),prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{if(measuring&&(/pack_coding_query_facts/.test(sql)||(sql==='SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?'&&new Error().stack?.includes('/query-facts.ts'))))mainSql.push(sql);return prepare(sql);}) as typeof db.prepare;
  const send=app.db.gateway.run.bind(app.db.gateway);
  app.db.gateway.run=(async(op,args)=>{const start=performance.now(),value=await send(op,args);if(op.name.startsWith('coding.query.')){commands.push(op.name);gatewayMetrics.push({operation:op.name,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value))});}return value;}) as typeof app.db.gateway.run;
  assert.notEqual(app.server.port, 8399);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  ws.onmessage = event => {
    const msg = JSON.parse(String(event.data)), id = waiting.has(msg.requestId) ? msg.requestId : msg.id, held = waiting.get(id);
    if (!held) return;
    waiting.delete(id); clearTimeout(held.timer);
    if (msg.error) held.fail(new Error(JSON.stringify(msg.error))); else held.done(msg.data);
  };
}
const read = (raw=false) => new Promise<any>((done, fail) => {
  const start=performance.now();
  const id = crypto.randomUUID(), timer = setTimeout(() => { waiting.delete(id); fail(new Error('RPC timeout')); }, 15000);
  waiting.set(id, { done:value=>{if(measuring)rpcMetrics.push({name:raw?'system.health':'neo.github.read',durationMs:performance.now()-start});done(value);}, fail, timer });
  ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: raw?'system.health':'operation.invoke', data: raw?{}:{ name: 'neo.github.read', input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
const requests = () => readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const rows=()=>{const previous=measuring;measuring=false;try{return app!.db.getDatabase().prepare('SELECT * FROM pack_coding_query_facts').all() as Record<string,any>[];}finally{measuring=previous;}};
const stored=()=>rows().find(row=>JSON.parse(row.coverage_json).since===explicit.since)!;
async function prove() {
  await open();measuring=true;
  evidence.fanout = await Promise.all(Array.from({ length: 5 }, () => read()));
  for (const result of evidence.fanout) {
    assert.equal(result.ok, true); assert.equal(result.kind, 'list'); assert.equal(result.truncated, true);
    assert.deepEqual(result.window, { by: 'merged', since: explicit.since, until: explicit.until });
    assert.deepEqual(result.items.map((item: any) => item.number), [3, 2]);
    assert.deepEqual(result, evidence.fanout[0]);
  }
  evidence.initialRequests = requests();
  assert.equal(evidence.initialRequests.length, 1, 'Concurrent public queries must share one ledger acquisition');
  evidence.firstStored = stored();
  control('changed'); evidence.changed = await read(); assert.equal(evidence.changed.items[0].title, 'Changed 3');
  evidence.changedStored = stored();
  for (const phase of ['failed', 'malformed']) {
    control(phase); evidence[phase] = await read(); assert.equal(evidence[phase].ok, false); assert.match(evidence[phase].reason, /unreadable/);
    evidence[`${phase}Stored`] = stored(); assert.equal(evidence[`${phase}Stored`].value_json, evidence.changedStored.value_json);
    assert.equal(evidence[`${phase}Stored`].observed_at, evidence.changedStored.observed_at); assert.equal(evidence[`${phase}Stored`].reason, 'failed');
  }
  ws!.close(); await app!.cleanup(); app = undefined; control('empty'); await open();
  evidence.retained = stored(); assert.equal(evidence.retained.value_json, evidence.changedStored.value_json);
  evidence.empty = await read(); assert.equal(evidence.empty.ok, true); assert.deepEqual(evidence.empty.items, []); assert.equal(evidence.empty.truncated, false);
  evidence.emptyStored = stored(); assert.equal(evidence.emptyStored.value_json, '[]'); assert.equal(evidence.emptyStored.reason, null);
  evidence.counts = Object.fromEntries(['initial', 'changed', 'failed', 'malformed', 'empty'].map(phase => [phase, requests().filter(r => r.phase === phase).length]));
  assert.deepEqual(evidence.counts, { initial: 1, changed: 1, failed: 1, malformed: 1, empty: 1 });
  input={repo:explicit.repo,state:'merged',withinHours:3,limit:2};control('relative');
  const staggered:Promise<unknown>[]=[];
  for(let i=0;i<5;i++){staggered.push(read());await new Promise(done=>setTimeout(done,20));}
  evidence.relative=await Promise.all(staggered);
  for(const result of evidence.relative){assert.equal(result.ok,true);assert.deepEqual(result,evidence.relative[0]);}
  const actualSince=evidence.relative[0].window.since;
  assert.equal(evidence.relative[0].search,`merged:>=${actualSince}`);
  assert(requests().find(r=>r.phase==='relative').args.includes(`merged:>=${actualSince}`));
  assert.equal(requests().filter(r=>r.phase==='relative').length,1);
  control('growth');evidence.growth=[];
  for(let i=0;i<3;i++)evidence.growth.push(await read());
  for(const result of evidence.growth)assert.equal(result.ok,true);
  assert.notEqual(evidence.growth.at(-1).window.since,actualSince);
  assert.equal(requests().filter(r=>r.phase==='growth').length,3);
  evidence.rows=rows();assert.equal(evidence.rows.length,2,'one explicit row and one rolling window row');
  if(mode==='verify'){
    const facts=new CodingQueryFactsRepository(app!.db.getDatabase());
    const coverage:NeoGithubCollection={repo:explicit.repo,kind:'pr',state:'merged',by:'merged',limit:2,withinHours:3,since:'2026-10-15T10:00:00Z'};
    const snapshot=await app!.db.gateway.call(codingQueryReads,'snapshot',coverage);
    control('late');const pending=facts.refresh(coverage);outstanding=pending;
    const until=Date.now()+5000;while(!existsSync(join(run,'late-start'))){assert(Date.now()<until,'late query collector started');await new Promise(done=>setTimeout(done,10));}
    const winningCoverage={...snapshot.coverage,since:'2026-10-15T11:00:00Z'};
    const winner=await app!.db.gateway.call(codingQueryWrites,'observe',winningCoverage,snapshot.subject,snapshot.revision,[],Date.now());
    writeFileSync(join(run,'late-release'),'release');const late=await pending;outstanding=undefined;
    assert.deepEqual(late,winner);assert.equal(winner.observationRevision,snapshot.revision+1);assert.equal(winner.coverage.query.since,winningCoverage.since);
    evidence.fence={before:snapshot.revision,after:winner.observationRevision,winningCoverage:winner.coverage};
    control('held');
    lock=spawn('/usr/bin/python3',['-c',"import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()",join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
    const released=new Promise<void>((done,fail)=>{lock!.once('error',fail);lock!.once('exit',code=>code===0?done():fail(new Error('synthetic writer failed')));});
    await new Promise<void>(done=>lock!.stdout!.once('data',()=>done()));
    const start=performance.now(),held=facts.refresh(coverage);outstanding=held;
    await new Promise(done=>setTimeout(done,400));
    const healthStart=performance.now();evidence.health=await read(true);const healthMs=performance.now()-healthStart;
    assert.equal((await held).view.status,'known');outstanding=undefined;const writeMs=performance.now()-start;await released;lock=undefined;
    evidence.contention={healthMs,writeMs,affectedWriteUnder250ms:writeMs<250};assert(healthMs<250);assert(writeMs>1000);
    assert.equal(mainSql.length,0,'query snapshots, admission, persistence and returned coverage must leave main');assert(commands.includes('coding.query.observe'));assert(maxLagMs<1000);
  }else assert(mainSql.length>0,'baseline must reproduce query SQL on main');
  evidence.verified = true;
  console.log(JSON.stringify({ verified: true, counts: evidence.counts, path: join(run, 'evidence/coding-query-db.json') }));
}
try { await prove(); } finally {
  measuring=false;writeFileSync(join(run,'late-release'),'release');lock?.kill();await outstanding?.catch(()=>{});clearInterval(timer);
  evidence.mainSql=mainSql;evidence.commands=commands;evidence.gatewayMetrics=gatewayMetrics;evidence.rpcMetrics=rpcMetrics;evidence.maxLagMs=maxLagMs;evidence.rss={before:rssBefore,after:process.memoryUsage().rss};
  if (existsSync(join(run, 'evidence/requests.jsonl'))) evidence.requests = requests();
  writeFileSync(join(run, 'evidence/coding-query-db.json'), JSON.stringify(evidence, null, 2));
  for (const held of waiting.values()) clearTimeout(held.timer);
  waiting.clear(); ws?.close(); await app?.cleanup(); globalThis.fetch = network;
}
