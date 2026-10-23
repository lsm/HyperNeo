import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { readGithubDeploys } from '../../../packages/daemon/src/lib/neo/packs/coding/deploy-checks.ts';
import { createNeoCodingReaders } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert(!existsSync(join(run, 'data/daemon.db')));
for (const name of ['home', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
writeFileSync(join(run, 'bin/gh'), String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root=dirname(dirname(process.argv[1])),args=process.argv.slice(2);
const {phase}=JSON.parse(readFileSync(join(root,'fixture.json'),'utf8'));
const family=args[0]==='pr'&&args[1]==='view'&&args.includes('state,mergeCommit')?'merge':args.some(arg=>arg.includes('/compare/'))?'ancestry':null;
appendFileSync(join(root,'evidence/requests.jsonl'),JSON.stringify({phase,family,args})+'\n');
if(!family){process.stderr.write('Unsupported synthetic command');process.exit(2);}
if(family==='merge'){
  await Bun.sleep(100);
  if(['known','failed'].includes(phase)){process.stderr.write('HTTP 404: synthetic unavailable');process.exit(1);}
  const body=phase==='partial'?{state:'MERGED'}:{state:phase==='closed'?'CLOSED':'MERGED',mergeCommit:phase==='closed'?null:{oid:'c'.repeat(40)}};
  process.stdout.write(JSON.stringify(body));
}else{
  if(args.includes('--include'))process.stdout.write('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n');
  process.stdout.write(JSON.stringify({status:'ahead'}));
}
`, { mode: 0o700 });
const repo = 'synthetic/ledger', merge = 'c'.repeat(40);
const url = (number: number, name = repo) => `https://github.com/${name}/pull/${number}`;
const control = (phase: string) => writeFileSync(join(run, 'fixture.json'), JSON.stringify({ phase }));
type Request = { phase: string; family: string; args: string[] };
const requests = (): Request[] => existsSync(join(run, 'evidence/requests.jsonl'))
  ? readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const evidence: Record<string, unknown> = { publicRpcChanged: false, ancestryMigrated: false };
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No real HTTP in this proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
}
const facts = () => new CodingPrLedgerRepository(app!.db.getDatabase()).mergeFacts;
const read = (urls: string[]) => createNeoCodingReaders(() => app!.db.getDatabase()).readDeploys(urls);
const row = () => app!.db.getDatabase().prepare('SELECT * FROM pack_coding_merge_facts WHERE repo=? AND number=8').get(repo) as { value_json: string; reason: string | null; observed_at: number };
try {
  await open();
  const db = app!.db.getDatabase();
  db.prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)').run('old/repo', repo);
  assert(facts().record(repo, 7, { value: { state: 'MERGED', mergeCommit: merge }, source: 'synthetic-ledger' }, Date.now(), 0));
  control('known');
  const known = await read([url(7)]);
  evidence.known = known;
  assert.equal(known.prs[0].mergeCommit, merge, 'Default deploy reader must use covered ledger merge facts even when GitHub refuses');
  assert.equal(requests().filter(r => r.family === 'merge').length, 0);
  const demand = Array.from({ length: 5 }, (_, i) => url(8, i % 2 ? 'old/repo' : 'SYNTHETIC/LEDGER'));
  control('baseline');
  await Promise.all(demand.map(pr => readGithubDeploys([pr], async () => [])));
  evidence.legacyMissingLookups = requests().filter(r => r.phase === 'baseline' && r.family === 'merge').length;
  assert.equal(evidence.legacyMissingLookups, 5);
  assert.equal(facts().read(repo, 8, Date.now(), 120_000).merge.status, 'unknown');
  control('missing');
  const concurrent = await Promise.all(demand.map(pr => read([pr])));
  for (const result of concurrent) assert.equal(result.prs[0].mergeCommit, merge);
  assert.equal(requests().filter(r => r.phase === 'missing' && r.family === 'merge').length, 1);
  evidence.concurrent = concurrent;
  assert.equal(facts().read(repo, 8, Date.now(), 120_000).merge.status, 'known');
  control('repeat');
  assert.equal((await read([url(8)])).prs[0].mergeCommit, merge);
  assert.equal(requests().filter(r => r.phase === 'repeat' && r.family === 'merge').length, 0);
  await app!.cleanup(); app = undefined;
  await open(); control('reopen');
  assert.equal((await read([url(8)])).prs[0].mergeCommit, merge);
  assert.equal(requests().filter(r => r.phase === 'reopen' && r.family === 'merge').length, 0);
  app!.db.getDatabase().prepare('UPDATE pack_coding_merge_facts SET observed_at=? WHERE repo=? AND number=8').run(Date.now() - 180_000, repo);
  const before = row();
  control('failed');
  assert.equal((await read([url(8)])).prs[0].mergeCommit, null);
  const failed = row();
  assert.equal(failed.value_json, before.value_json);
  assert.equal(failed.observed_at, before.observed_at);
  assert.equal(failed.reason, 'failed'); evidence.failed = failed;
  control('partial');
  assert.equal((await read([url(8)])).prs[0].mergeCommit, null);
  assert.equal(row().value_json, before.value_json);
  assert.equal(row().reason, 'partial');
  control('recovered');
  assert.equal((await read([url(8)])).prs[0].mergeCommit, merge);
  assert.equal(row().reason, null);
  control('closed');
  assert.equal((await read([url(9)])).prs[0].mergeCommit, null);
  assert.equal(facts().read(repo, 9, Date.now(), 120_000).merge.status, 'known');
  assert.equal((await read([url(9)])).prs[0].mergeCommit, null);
  assert.equal(requests().filter(r => r.phase === 'closed' && r.family === 'merge').length, 1);
  evidence.mergeCounts = Object.fromEntries(['known','missing','repeat','reopen','failed','partial','recovered','closed'].map(phase => [phase, requests().filter(r => r.phase === phase && r.family === 'merge').length]));
  evidence.verified = true;
  console.log(JSON.stringify({ verified: true, mergeCounts: evidence.mergeCounts }));
} finally {
  evidence.requests = requests();
  writeFileSync(join(run, 'evidence/deploy-merge.json'), JSON.stringify(evidence, null, 2));
  await app?.cleanup(); globalThis.fetch = network;
}
