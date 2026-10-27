import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { deliverCodingHealth } from '../../../packages/daemon/src/lib/neo/packs/coding/health-delivery.ts';
const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data/daemon.db')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const part of ['home', 'bin', 'evidence']) mkdirSync(join(run, part), { recursive: true });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const network = globalThis.fetch; globalThis.fetch = (() => { throw new Error('Real HTTP refused'); }) as typeof fetch;
const repo = 'synthetic/health', alias = 'synthetic/alias';
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, measuring = false, accept = false;
const mainSql: string[] = [], commands: unknown[] = [], attempts: {key: string; text: string}[] = [];
const received = new Map<string, string>();
const evidence: Record<string, any> = { mode, verified: false, consumer: 'Persisted daemon jobs invoke production health delivery with a synthetic keyed receiver', limitation: 'No actual Neo mailbox, recipient consumption, full coding sweep, model, GitHub, GUI, whole-daemon SQL absence or latency claim.' };
function fixture<T>(fn: () => T): T { const prior = measuring; measuring = false; try { return fn(); } finally { measuring = prior; } }
const state = () => fixture(() => JSON.parse((app!.db.getDatabase().prepare('SELECT health_json FROM pack_coding_repo_health WHERE repo=?').get(repo) as {health_json: string}).health_json));
async function open() {
  app = await createDaemonApp({config: getConfig({port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db')}), verbose: false});
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  await app.db.updateGlobalSettings({neo: {packs: []}});
  const db = app.db.getDatabase(), prepare = db.prepare.bind(db), send = app.db.gateway.run.bind(app.db.gateway);
  db.prepare = ((sql: string) => { if(measuring && /pack_coding_repo_health|pack_coding_repo_aliases/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof db.prepare;
  app.db.gateway.run = (async(op, args) => {
    const start = performance.now(), reply = await send(op, args), method = (args as {method: string}).method;
    if(measuring && op.name.startsWith('coding.ledger') && ['readHealth', 'acceptHealthNotice'].includes(method)) commands.push({ name: op.name, mode: op.mode, method, durationMs: performance.now() - start, argsBytes: Buffer.byteLength(JSON.stringify(args)), replyBytes: Buffer.byteLength(JSON.stringify(reply) ?? 'null') });
    return reply;
  }) as typeof app.db.gateway.run;
  const ledger = new CodingPrLedgerRepository(db);
  app.jobProcessor.register('verify.lane-a-health-reader', async job => {
    measuring = true;
    let held=false,forcedRelease=false;
    const releaseWriter=()=>{if(held){fixture(()=>db.exec('ROLLBACK'));held=false;}};
    const locked=job.payload.blockWriter===true;
    if(locked){fixture(()=>db.exec('BEGIN IMMEDIATE'));held=true;}
    const deadline=locked?setTimeout(()=>{forcedRelease=true;releaseWriter();},1200):undefined;
    try {
      await Promise.all(Array.from({length: Number(job.payload.count)}, () => deliverCodingHealth(ledger, [alias], async(key, text) => {
        assert(state().notices.some((notice: any) => notice.key === key), 'External effect requires the durable health notice');
        if(locked)evidence.offeredWhileWriterHeld=held;
        attempts.push({key, text}); if(!accept) return false;
        assert.equal(received.get(key) ?? text, text); received.set(key, text); return true;
      }, Number(job.payload.at))));
      if(locked){evidence.writerLock={forcedRelease,offeredWhileHeld:evidence.offeredWhileWriterHeld};assert(!forcedRelease,'Pure health delivery read must not wait for the writer lock');assert(evidence.offeredWhileWriterHeld,'Committed notice must be offered before releasing the writer lock');}
      return {completed: true};
    } finally {if(deadline)clearTimeout(deadline);releaseWriter();measuring = false; }
  });
}
async function deliver(at: number, count = 1, blockWriter = false) {
  const job = app!.jobQueue.enqueue({queue: 'verify.lane-a-health-reader', payload: {at, count, blockWriter}, maxRetries: 0, priority: 100});
  await app!.jobProcessor.start();
  try {
    for(let i = 0; i < 300; i++) {
      const row = app!.jobQueue.getJob(job.id)!;
      if(row.status === 'completed') return {status: row.status, result: row.result};
      if(row.error) throw new Error(row.error);
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error('Synthetic health delivery job timed out');
  } finally { await app!.jobProcessor.stop(); }
}
try {
  await open();
  const ledger = new CodingPrLedgerRepository(app!.db.getDatabase());
  await ledger.write('recordAlias', alias, repo);
  for(const at of [1, 2, 3]) await ledger.write('recordHealth', repo, {at, outcome: 'failed'});
  evidence.rejected = await deliver(3,1,true); assert.equal(attempts.length, 1); assert.equal(received.size, 0); assert.equal(state().notices[0].acceptedAt, null);
  await ledger.write('recordHealth', repo, {at: 4, outcome: 'complete'});
  await deliver(4); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  const retained = state(); assert.equal(retained.notices.length, 2);
  await app!.cleanup(); app = undefined; await open(); assert.deepEqual(state(), retained);
  accept = true;
  app!.db.getDatabase().exec("CREATE TRIGGER reject_health_ack BEFORE UPDATE ON pack_coding_repo_health WHEN json_extract(NEW.health_json,'$.notices[0].acceptedAt') IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic health ack rejection'); END");
  await assert.rejects(deliver(5), /synthetic health ack rejection/);
  assert.equal(received.size, 1); assert.deepEqual(state(), retained);
  app!.db.getDatabase().exec('DROP TRIGGER reject_health_ack');
  evidence.accepted = await deliver(6, 2);
  assert.equal(received.size, 2); assert(state().notices.every((notice: any) => notice.acceptedAt === 6));
  const accepted = state(), attemptCount = attempts.length;
  await deliver(7); assert.equal(attempts.length, attemptCount); assert.deepEqual(state(), accepted);
  await app!.cleanup(); app = undefined; await open(); await deliver(8);
  assert.equal(attempts.length, attemptCount); assert.deepEqual(state(), accepted);
  { assert.deepEqual(mainSql, [], 'Health delivery lookup and acknowledgement SQL must leave main'); assert(commands.some((op: any) => op.method === 'readHealth')); }
  evidence.finalState = state(); evidence.attempts = attempts; evidence.received = [...received]; evidence.verified = true;
} finally {
  measuring = false; evidence.mainSql = mainSql; evidence.commands = commands;
  await app?.cleanup(); globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/lane-a-health-reader-db.json'), JSON.stringify(evidence, null, 2));
}
