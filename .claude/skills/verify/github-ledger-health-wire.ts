import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { CodingPrLedgerRepository, readCodingLedgerRepo, reconcileCodingPrLedger } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[k], undefined);
for (const dir of ['bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/gh'), String.raw`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(run)},args=process.argv.slice(2);
if(args[0]!=='api'||args[1]!=='graphql'||!args.includes('--include'))process.exit(2);
const owner=args.find(x=>x.startsWith('o='))?.slice(2),name=args.find(x=>x.startsWith('n='))?.slice(2);
if(owner!=='synthetic'||!['first','tail'].includes(name))process.exit(2);
const phase=readFileSync(root+'/phase','utf8'),repo=owner+'/'+name;
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase,repo})+'\n');
if(phase==='rate'){process.stdout.write('HTTP/2.0 429\r\nretry-after: 3600\r\n\r\n{}');process.stderr.write('HTTP 429: Too Many Requests');process.exit(1);}
const node={number:7,title:'Synthetic',headRefName:'fixture',headRefOid:'a'.repeat(40),state:'OPEN',isDraft:false,mergeable:'MERGEABLE',reviewDecision:null,closedAt:null};
console.log(JSON.stringify({data:{rateLimit:{remaining:4000},repository:{nameWithOwner:repo,open:{pageInfo:{hasNextPage:phase==='partial'},nodes:phase==='empty'?[]:[node]},done:{nodes:[]}}}}));
`, { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in health Wire proof'); }) as typeof fetch;
const repos = ['synthetic/first', 'synthetic/tail'], base = Date.now();
const phase = (name: string) => writeFileSync(join(run, 'phase'), name);
const requests = () => readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const proof: Record<string, unknown> = { verified: false, realGithub: false, neoConcernDeliveryWired: false };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
const sql = () => app!.db.getDatabase();
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399); app.db.updateGlobalSettings({ neo: { packs: [] } });
}
try {
  phase('seed'); await open(); proof.runtime = { commit: BUILD_METADATA.commit, pid: process.pid, port: app!.server.port };
  let ledger = new CodingPrLedgerRepository(sql());
  const cycle = (at: number) => reconcileCodingPrLedger(ledger, repos, readCodingLedgerRepo, at);
  const history = () => sql().prepare('SELECT * FROM pack_coding_poll_facts').all();
  sql().exec("INSERT INTO pack_coding_poll_facts (subject,fact_revision,observation_revision,value_json,attempted_at) VALUES ('[\"protected-history\"]',3,5,'[]',1)");
  const protectedRows = history(); await cycle(base);
  const facts = ledger.list(); assert.equal(facts.length, 2);
  phase('partial'); for (const offset of [100, 200, 300]) await cycle(base + offset);
  assert.deepEqual(ledger.list(), facts);
  const incident = ledger.health.read(repos[1])!; assert(incident, 'reconciliation must persist health');
  assert.equal(incident.misses, 3); assert.equal(incident.incident!.resolvedAt, null);
  phase('rate'); await cycle(base + 400);
  const before = repos.map(repo => ledger.health.read(repo)!);
  assert.equal(before[0].attemptedAt, base + 400); assert.equal(before[0].misses, 4);
  assert(before[0].nextRetryAt! > base + 400); assert.equal(before[1].reason, 'cooldown');
  assert.equal(before[1].misses, 3); assert.deepEqual(before[1].incident, incident.incident);
  await app!.cleanup(); app = undefined; await open(); ledger = new CodingPrLedgerRepository(sql());
  assert.deepEqual(repos.map(repo => ledger.health.read(repo)), before);
  const count = requests().length; phase('empty'); await cycle(base + 500);
  assert.equal(requests().length, count); assert.deepEqual(ledger.list(), facts);
  await cycle(before[0].nextRetryAt! + 1);
  assert.deepEqual(ledger.list(), []);
  const recovered = repos.map(repo => ledger.health.read(repo)!);
  assert(recovered.every(row => row.misses === 0 && row.incident!.resolvedAt !== null));
  assert.deepEqual(history(), protectedRows); proof.verified = true;
  proof.result = { beforeRestart: before, recovered, requests: requests(), cooldownReads: 0, protectedHistory: protectedRows };
  console.log(JSON.stringify({ verified: true, sourceReaderExercised: true, cooldownReads: 0, restartVerified: true }));
} finally {
  await app?.cleanup(); globalThis.fetch = network; proof.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/health-wire.json'), JSON.stringify(proof, null, 2));
}
