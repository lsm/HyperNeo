import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { readGithubDeploys } from '../../../packages/daemon/src/lib/neo/packs/coding/deploy-checks.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { createNeoCodingReaders } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
assert(!existsSync(join(run, 'data/daemon.db')));
assert.match(BUILD_METADATA.commit, /^[0-9a-f]{40}$/);
for (const name of ['home','bin','evidence']) mkdirSync(join(run, name), { recursive: true });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
writeFileSync(join(run, 'bin/gh'), String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root=dirname(dirname(process.argv[1])),args=process.argv.slice(2);
const {phase}=JSON.parse(readFileSync(join(root,'fixture.json'),'utf8'));
appendFileSync(join(root,'evidence/requests.jsonl'),JSON.stringify({phase,args})+'\n');
if(args[0]!=='api'||!args.some(arg=>arg.includes('/compare/'))){process.stderr.write('Unsupported synthetic command');process.exit(2);}
await Bun.sleep(100);
if(['known','failed'].includes(phase)){process.stderr.write('HTTP 404: synthetic unavailable');process.exit(1);}
if(args.includes('--include'))process.stdout.write('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify({status:phase==='partial'?'invalid':phase==='behind'?'behind':'ahead'}));
`, { mode: 0o700 });
const repo='synthetic/ledger', head=BUILD_METADATA.commit, merge='c'.repeat(40), cold='a'.repeat(40), failedBase='e'.repeat(40);
const url=(number:number,name=repo)=>`https://github.com/${name}/pull/${number}`;
const control=(phase:string)=>writeFileSync(join(run,'fixture.json'),JSON.stringify({phase}));
type Request={phase:string;args:string[]};
const requests=():Request[]=>existsSync(join(run,'evidence/requests.jsonl'))?readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const evidence:Record<string,unknown>={publicRpcChanged:false,head};
const network=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('No real HTTP in this proof');}) as typeof fetch;
let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;
async function open(){app=await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});await app.jobProcessor.stop();assert.notEqual(app.server.port,8399);}
const read=(urls:string[])=>createNeoCodingReaders(()=>app!.db.getDatabase()).readDeploys(urls);
const row=(base:string)=>app!.db.getDatabase().prepare('SELECT * FROM pack_coding_ancestry_facts WHERE repo=? AND base_oid=? AND head_oid=?').get(repo,base,head) as {status:string|null;reason:string|null;observed_at:number|null};
try{
  await open();const db=app!.db.getDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS pack_coding_ancestry_facts (
    repo TEXT NOT NULL, base_oid TEXT NOT NULL, head_oid TEXT NOT NULL,
    status TEXT CHECK(status IS NULL OR status IN ('ahead','identical','behind','diverged')),
    fact_revision INTEGER NOT NULL, observation_revision INTEGER NOT NULL,
    observed_at INTEGER, attempted_at INTEGER NOT NULL,
    reason TEXT CHECK(reason IS NULL OR reason IN ('failed','partial')),
    PRIMARY KEY(repo,base_oid,head_oid))`);
  db.prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)').run('old/repo',repo);
  const facts=new CodingPrLedgerRepository(db).mergeFacts;
  for(const [number,commit] of [[7,merge],[8,cold],[9,'b'.repeat(40)],[10,'d'.repeat(40)],[11,failedBase]] as const)
    assert(facts.record(repo,number,{value:{state:'MERGED',mergeCommit:commit},source:'synthetic'},Date.now(),0));
  db.prepare('INSERT INTO pack_coding_ancestry_facts VALUES(?,?,?,?,?,?,?,?,?)').run(repo,merge,head,'ahead',1,1,Date.now(),Date.now(),null);
  control('known');const known=await read([url(7)]);evidence.known=known;
  assert.deepEqual(known.daemons[0].contains,[merge],'Default deploy reader must use the known ledger ancestry when GitHub refuses');
  assert.equal(requests().length,0);
  const demand=Array.from({length:5},(_,i)=>url(8,i%2?'old/repo':'SYNTHETIC/LEDGER'));
  control('baseline');await Promise.all(demand.map(pr=>readGithubDeploys([pr],async()=>[{daemon:'synthetic',commit:head}],undefined,async()=>cold)));
  evidence.legacyColdLookups=requests().filter(r=>r.phase==='baseline').length;assert.equal(evidence.legacyColdLookups,5);
  control('cold');const concurrent=await Promise.all(demand.map(pr=>read([pr])));evidence.concurrent=concurrent;
  for(const result of concurrent)assert.deepEqual(result.daemons[0].contains,[cold]);
  assert.equal(requests().filter(r=>r.phase==='cold').length,1);assert.equal(row(cold).status,'ahead');
  control('repeat');assert.deepEqual((await read([url(8)])).daemons[0].contains,[cold]);assert.equal(requests().filter(r=>r.phase==='repeat').length,0);
  await app!.cleanup();app=undefined;await open();control('reopen');
  assert.deepEqual((await read([url(8)])).daemons[0].contains,[cold]);assert.equal(requests().filter(r=>r.phase==='reopen').length,0);
  app!.db.getDatabase().prepare('INSERT INTO pack_coding_ancestry_facts VALUES(?,?,?,?,?,?,?,?,?)').run(repo,'b'.repeat(40),head,'behind',1,1,Date.now(),Date.now(),null);
  control('known-negative');assert.deepEqual((await read([url(9)])).daemons[0].contains,[]);assert.equal(requests().filter(r=>r.phase==='known-negative').length,0);
  control('behind');assert.deepEqual((await read([url(10)])).daemons[0].contains,[]);assert.equal(row('d'.repeat(40)).status,'behind');
  control('failed');assert.deepEqual((await read([url(11)])).daemons[0].contains,[]);assert.equal(row(failedBase).reason,'failed');assert.equal(row(failedBase).status,null);
  control('partial');assert.deepEqual((await read([url(11)])).daemons[0].contains,[]);assert.equal(row(failedBase).reason,'partial');
  control('recovered');assert.deepEqual((await read([url(11)])).daemons[0].contains,[failedBase]);assert.equal(row(failedBase).reason,null);
  const before=row(cold);app!.db.getDatabase().prepare("UPDATE pack_coding_ancestry_facts SET reason='failed' WHERE repo=? AND base_oid=? AND head_oid=?").run(repo,cold,head);
  control('failed');assert.deepEqual((await read([url(8)])).daemons[0].contains,[]);assert.equal(row(cold).status,before.status);assert.equal(row(cold).observed_at,before.observed_at);
  control('recovered');assert.deepEqual((await read([url(8)])).daemons[0].contains,[cold]);
  evidence.counts=Object.fromEntries(['known','baseline','cold','repeat','reopen','known-negative','behind','failed','partial','recovered'].map(phase=>[phase,requests().filter(r=>r.phase===phase).length]));
  evidence.verified=true;console.log(JSON.stringify({verified:true,counts:evidence.counts}));
}finally{evidence.requests=requests();writeFileSync(join(run,'evidence/deploy-ancestry.json'),JSON.stringify(evidence,null,2));await app?.cleanup();globalThis.fetch=network;}
