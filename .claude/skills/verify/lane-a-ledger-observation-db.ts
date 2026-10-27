import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { CodingPrLedgerRepository, readCodingLedgerRepo, reconcileCodingPrLedger } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingLedgerReader } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger-source.ts';

const [mode,directory]=process.argv.slice(2),run=resolve(directory);assert(['before','verify'].includes(mode));
let measuring=false;const mainSql:string[]=[],commands:unknown[]=[];
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[k], undefined);
for (const dir of ['bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/gh'), String.raw`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(run)},args=process.argv.slice(2);
if(args[0]!=='api'||!args.includes('--include'))process.exit(2);
if(args[1]==='user'){console.log(JSON.stringify({id:1,url:'https://api.github.com/users/synthetic'}));process.exit(0);}
const rest=args[1]!=='graphql', parts=args[1].split('/');
const owner=rest?parts[1]:args.find(x=>x.startsWith('o='))?.slice(2),name=rest?parts[2]:args.find(x=>x.startsWith('n='))?.slice(2);
if(owner!=='synthetic'||!['first','tail'].includes(name))process.exit(2);
const phase=readFileSync(root+'/phase','utf8'),repo=owner+'/'+name;
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase,repo})+'\n');
if(phase==='rate'){process.stdout.write('HTTP/2.0 429\r\nx-ratelimit-resource: core\r\nretry-after: 3600\r\n\r\n{}');process.stderr.write('HTTP 429: Too Many Requests');process.exit(1);}
const node={number:7,title:'Synthetic',headRefName:'fixture',headRefOid:'a'.repeat(40),state:'OPEN',isDraft:false,mergeable:'MERGEABLE',reviewDecision:null,closedAt:null};
if(rest){
 const pulls=phase==='partial'?{}:phase==='empty'||args[1].includes('state=closed')?[]:[{number:7,title:'Synthetic',head:{ref:'fixture',sha:node.headRefOid},updated_at:'initial',created_at:'2026-01-01T00:00:00Z',closed_at:null,draft:false,base:{repo:{full_name:repo}}}];
 console.log(JSON.stringify(pulls));process.exit(0);
}
console.log(JSON.stringify({data:{rateLimit:{cost:1,remaining:4000,resetAt:'2099-01-01T00:00:00Z'},repository:{nameWithOwner:repo,p7:node}}}));
`, { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in health Wire proof'); }) as typeof fetch;
const repos = ['synthetic/first', 'synthetic/tail'], base = Date.now();
const phase = (name: string) => writeFileSync(join(run, 'phase'), name);
const requests = () => readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const proof: Record<string, unknown> = { verified: false, realGithub: false, neoConcernDeliveryWired: false };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let source = readCodingLedgerRepo;
const sql = () => app!.db.getDatabase();
async function open() {
  source = createCodingLedgerReader();
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.spaceRuntimeService.ready();await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399); app.db.updateGlobalSettings({ neo: { packs: [] } });
  sql().prepare("UPDATE neo_pack_preferences SET value_json=? WHERE pack='coding' AND key='watchedRepos'").run(JSON.stringify(repos));
  const raw=sql(),prepare=raw.prepare.bind(raw),send=app.db.gateway.run.bind(app.db.gateway);
  raw.prepare=((statement:string)=>{if(measuring&&/pack_coding_|neo_pack_preferences/.test(statement))mainSql.push(statement);return prepare(statement);}) as typeof raw.prepare;
  app.db.gateway.run=(async(op,args)=>{const start=performance.now(),value=await send(op,args);if(measuring)commands.push({name:op.name,method:(args as {method:string}).method,mode:op.mode,durationMs:performance.now()-start,argsBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(value)??'null')});return value;}) as typeof app.db.gateway.run;
  app.jobProcessor.register('verify.lane-a-ledger-observation',async job=>{
    const clock=Date.now;Date.now=()=>Number(job.payload.at);measuring=true;
    try{return {transitions:await reconcileCodingPrLedger(new CodingPrLedgerRepository(sql()),repos,source,Number(job.payload.at))};}
    finally{measuring=false;Date.now=clock;}
  });
}
try {
  phase('seed'); await open(); proof.runtime = { commit: BUILD_METADATA.commit, pid: process.pid, port: app!.server.port };
  let ledger = new CodingPrLedgerRepository(sql());
  const cycle = async (at:number) => {
    const job=app!.jobQueue.enqueue({queue:'verify.lane-a-ledger-observation',payload:{at},maxRetries:0,priority:100});
    await app!.jobProcessor.start();
    try{for(let i=0;i<400;i++){const current=app!.jobQueue.getJob(job.id)!;if(current.status==='completed')return current.result;if(current.error)throw new Error(current.error);await new Promise(done=>setTimeout(done,25));}throw new Error('Observation job timed out');}
    finally{await app!.jobProcessor.stop();}
  };
  const history = () => sql().prepare('SELECT * FROM pack_coding_poll_facts').all();
  sql().exec("INSERT INTO pack_coding_poll_facts (subject,fact_revision,observation_revision,value_json,attempted_at) VALUES ('[\"protected-history\"]',3,5,'[]',1)");
  const protectedRows = history(); await cycle(base);
  const facts = ledger.list(); assert.equal(facts.length, 2);
  const beforeHealth=ledger.health.read(repos[0]);
  sql().exec("CREATE TRIGGER reject_ledger_observation BEFORE INSERT ON pack_coding_pr_ledger WHEN NEW.repo='synthetic/first' BEGIN SELECT RAISE(ABORT,'synthetic observation rejection'); END");
  await assert.rejects(cycle(base+50),/synthetic observation rejection/);
  assert.deepEqual(ledger.health.read(repos[0]),beforeHealth,'Failed PR persistence must not report completed coverage');
  assert.deepEqual(ledger.list(),facts);
  sql().exec('DROP TRIGGER reject_ledger_observation');proof.atomicRollback=true;

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
  assert.deepEqual(history(), protectedRows);if(mode==='verify')assert.deepEqual(mainSql,[],'Ledger reconciliation SQL must leave main');else assert(mainSql.length>0); proof.verified = true;
  proof.result = { beforeRestart: before, recovered, requests: requests(), cooldownReads: 0, protectedHistory: protectedRows };
  console.log(JSON.stringify({ verified: true, sourceReaderExercised: true, cooldownReads: 0, restartVerified: true }));
} finally {
  await app?.cleanup(); globalThis.fetch = network; proof.resourcesStopped = true;proof.mode=mode;proof.mainSql=mainSql;proof.commands=commands;
  writeFileSync(join(run, 'evidence/lane-a-ledger-observation-db.json'), JSON.stringify(proof, null, 2));
}
