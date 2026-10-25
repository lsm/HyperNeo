import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationRegistry, defineOperation } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { StartWorkInputSchema, StartWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { prepareCodingExecution } from '../../../packages/daemon/src/lib/neo/packs/coding/prepare-execution.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { CodingAssignmentsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/assignments.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { QA_SYSTEM_CONTRACT, REVIEWER_SYSTEM_CONTRACT } from '../../../packages/prompts/src/mod.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'bin'), { recursive: true }); mkdirSync(join(run, 'evidence'), { recursive: true });
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const commands: unknown[] = [], evidence: unknown[] = [], starts: { role: string; ref: { adapter: string; id: string }; head: string; model: string; contractBytes: number; message: string }[] = [];
function command(args: readonly string[], cwd: string) {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', env });
  const observed = { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  commands.push({ args, cwd, ...observed }); return observed;
}
function git(cwd: string, ...args: string[]) {
  const result = command(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], cwd);
  assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
}
const origin = join(run, 'origin'), source = join(run, 'source');
git(run, 'init', '--initial-branch=dev', origin);
git(origin, 'config', 'user.name', 'Fixture'); git(origin, 'config', 'user.email', 'fixture@example.invalid');
mkdirSync(join(origin, '.claude/skills/verify'), { recursive: true });
writeFileSync(join(origin, '.claude/skills/verify/SKILL.md'), '# Verify\nUse synthetic isolated data.\n');
writeFileSync(join(origin, 'behavior.txt'), 'base'); git(origin, 'add', '.'); git(origin, 'commit', '-m', 'base');
git(run, 'clone', origin, source); const baseHead = git(source, 'rev-parse', 'HEAD');
writeFileSync(join(source, 'behavior.txt'), 'preserve dirty author source');
git(origin, 'checkout', '-b', 'candidate'); writeFileSync(join(origin, 'behavior.txt'), 'candidate'); git(origin, 'commit', '-am', 'candidate');
let head = git(origin, 'rev-parse', 'HEAD'); git(origin, 'checkout', 'dev');
const metadata: Record<string, { body: string; headRefOid: string; state: string }> = {};
const metadataFile = join(run, 'pr.json');
const publish = () => writeFileSync(metadataFile, JSON.stringify(metadata));
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}\nimport{readFileSync,appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(join(run, 'evidence/gh.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]!=='pr'||process.argv[3]!=='view')process.exit(1);const row=JSON.parse(readFileSync(${JSON.stringify(metadataFile)},'utf8'))[process.argv[4]];if(!row)process.exit(1);console.log(JSON.stringify(row));`, { mode: 0o700 });
assert.equal(Bun.which('gh'), join(run, 'bin/gh'));
const place = { machine: 'fixture', name: 'Fixture', folder: source };
const defaultTarget = { adapter: 'fixture-reviewer', place, model: 'claude-opus-5-5' };
const preferredTarget = { adapter: 'fixture-preferred', place, model: 'claude-sonnet-5-5', effort: 'high' };
const verifyTarget = { adapter: 'fixture-verifier', place, model: 'gpt-6', effort: 'medium' };
const authorModel = { adapter: 'fixture-author', place, model: 'gpt-6' };
const releases: (() => Promise<void>)[] = [];
let attempts = 0, rejectPreferred = false;
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No HTTP in actor assignment proof'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    let ws: WebSocket | undefined;
    try {
      await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
      const db = app.db.getDatabase(); createCodingPackTables(db);
      const ledger = new CodingPrLedgerRepository(db), todos = new CodingTodoPrRepository(db), assignments = new CodingAssignmentsRepository(db);
      const registry = app.sessionManager.getOperationRegistry();
      const harness = defineOperation({
        name: 'work.start', description: 'Synthetic harness boundary: real preparation, no native app or model.', inputSchema: StartWorkInputSchema, resultSchema: StartWorkResultSchema,
        execute: async input => {
          attempts++;
          if (rejectPreferred && input.model === preferredTarget.model) return { ok: false as const, reason: 'unsupported_model' as const, detail: 'Synthetic preferred model unavailable' };
          assert(input.adapter.startsWith('fixture-')); assert(input.preparation?.pack === 'coding');
          const prepared = await prepareCodingExecution({ directory: source, destination: join(run, 'workers', `worker-${attempts}`), parameters: input.preparation.parameters }, { run: async (args, cwd) => command(args, cwd) });
          assert(prepared.ok, prepared.ok ? '' : prepared.reason); releases.push(prepared.value.release);
          const role = String(input.preparation.parameters.role), expected = String(input.preparation.parameters.head);
          assert.equal(git(prepared.value.directory, 'rev-parse', 'HEAD'), expected);
          assert.equal(git(prepared.value.directory, 'status', '--porcelain'), '');
          const contract = readFileSync(join(prepared.value.directory, '.git/hyperneo-stage-contract.md'), 'utf8');
          assert(contract.startsWith(role === 'review' ? REVIEWER_SYSTEM_CONTRACT : QA_SYSTEM_CONTRACT));
          if (role === 'verify') { assert(contract.includes('## Coding-pack Verify override')); assert(input.message.includes('verify/SKILL.md')); }
          assert(input.message.includes('hyperneo-stage-contract.md')); assert(input.message.includes(expected)); assert(input.message.length < 20000);
          const ref = { adapter: input.adapter, id: `worker-${attempts}` };
          starts.push({ role, ref, head: expected, model: input.model!, contractBytes: Buffer.byteLength(contract), message: input.message });
          return { ok: true as const, value: { ref, title: input.title, place: input.place, status: 'running' as const, lastActivityAt: Date.now(), model: input.model, effort: input.effort } };
        },
      });
      const boundRegistry = createOperationRegistry(registry.entries.map(entry => entry.name === 'work.start' ? harness : entry));
      app.sessionManager.setOperationRegistryProvider(() => boundRegistry);
      ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
      await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
      const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
        const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error(`RPC timeout: ${name}`)), 15000);
        ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); evidence.push({ phase, name, input, reply }); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
        ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
      });
      const seed = async (name: string, number: number, repo: string) => {
        const url = `https://github.com/${repo}/pull/${number}`;
        git(origin, 'update-ref', `refs/pull/${number}/head`, head);
        metadata[url] = { body: 'Agent: gpt-6-sol (effort: high) via fixture-author', headRefOid: head, state: 'OPEN' }; publish();
        db.prepare('INSERT INTO neo_asks (id,session_id,title,request,created_at,updated_at) VALUES (?,?,?,?,1,1)').run(`ask-${name}`, 'fixture-neo', name, name);
        db.prepare("INSERT INTO neo_todos (id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES (?,?,1,?,'Merged','doing',1,1)").run(name, `ask-${name}`, name);
        const write = { adapter: 'fixture-author', id: `author-${name}` };
        new NeoTodoSessionRepository(db).bind(name, write, 1); await todos.write('claim', name, [{ url, claim: 'named' }], 1); ledger.stageFacts.observeHead(url, head, 1);
        return { todoId: name, url, head, acceptanceContract: `artifact:contract-${name}` };
      };
      const setting = async (repo: string, key: string, value: unknown) => assert.deepEqual(await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: repo }, key, value }), { ok: true });
      const assign = (input: unknown) => rpc('neo.coding.assign', input) as Promise<{ ok: boolean; reason?: string; assignment: { actor: { kind: string; id: string; model: string; harness: string }; ref: { adapter: string; id: string }; fallback: string[]; bot?: string; effort?: string } }>;
      assert.equal((await rpc('operations.describe', { name: 'neo.coding.result' }) as { found: boolean }).found, true);
      if (phase === 'initial') {
        const bot = await seed('bot', 7, 'synthetic/bot'); await setting('synthetic/bot', 'reviewBot', 'fixture-bot');
        const beforeBot = attempts;
        assert.equal((await assign({ ...bot, stage: 'review', candidates: [], human: 'unused-human' })).assignment.bot, 'fixture-bot');
        assert.equal(attempts, beforeBot, 'Configured bot must not open a reviewer session');
        const botVerify = await assign({ ...bot, stage: 'verify', candidates: [verifyTarget] }); assert(botVerify.ok);
        assert.deepEqual(await rpc('neo.coding.result', { todoId: bot.todoId, ref: botVerify.assignment.ref, fact: { url: bot.url, head, stage: 'verify', actor: botVerify.assignment.actor, verdict: 'inconclusive', acceptanceContract: bot.acceptanceContract, evidence: ['artifact:inconclusive-observation'] } }), { ok: true });
        assert.equal(ledger.stageFacts.read(bot.url)[0].stage, 'qa');
        const session = await seed('session', 8, 'synthetic/session');
        for (const [field, value] of Object.entries({ harness: preferredTarget.adapter, model: preferredTarget.model, effort: preferredTarget.effort })) await setting('synthetic/session', `review.${field}`, value);
        const review = await assign({ ...session, stage: 'review', candidates: [authorModel, defaultTarget, preferredTarget] }); assert(review.ok); assert.equal(review.assignment.actor.harness, preferredTarget.adapter); assert.equal(review.assignment.effort, preferredTarget.effort);
        const verify = await assign({ ...session, stage: 'verify', candidates: [verifyTarget] }); assert(verify.ok); assert.notEqual(verify.assignment.ref.id, review.assignment.ref.id);
        const beforeRetry = attempts;
        assert((await assign({ ...session, stage: 'review', candidates: [] })).ok); assert((await assign({ ...session, stage: 'verify', candidates: [] })).ok); assert.equal(attempts, beforeRetry);
        const human = await seed('human', 9, 'synthetic/human'); const beforeHuman = attempts;
        assert.equal((await assign({ ...human, stage: 'review', candidates: [], human: 'fixture-person' })).assignment.actor.kind, 'human'); assert.equal(attempts, beforeHuman);
        const missing = await seed('missing', 10, 'synthetic/missing'); metadata[missing.url].body = ''; publish();
        assert.equal((await assign({ ...missing, stage: 'review', candidates: [defaultTarget] })).ok, false);
        await setting('synthetic/missing', 'provenance', false);
        assert((await assign({ ...missing, stage: 'review', candidates: [authorModel] })).ok);
        const fallback = await seed('fallback', 11, 'synthetic/fallback'); await setting('synthetic/fallback', 'review.model', preferredTarget.model); rejectPreferred = true;
        const fallbackResult = await assign({ ...fallback, stage: 'review', candidates: [defaultTarget, preferredTarget] }); assert(fallbackResult.ok); assert.equal(fallbackResult.assignment.actor.model, defaultTarget.model); assert(fallbackResult.assignment.fallback.some(text => text.includes('qualifying default'))); rejectPreferred = false;
        assert.equal((await assign({ ...session, acceptanceContract: 'changed', stage: 'review', candidates: [] })).ok, false);
        git(origin, 'checkout', 'candidate'); writeFileSync(join(origin, 'behavior.txt'), 'new-head'); git(origin, 'commit', '-am', 'new head'); head = git(origin, 'rev-parse', 'HEAD'); git(origin, 'update-ref', 'refs/pull/8/head', head); git(origin, 'checkout', 'dev');
        metadata[session.url].headRefOid = head; publish();
        assert.equal((await assign({ ...session, stage: 'verify', candidates: [verifyTarget] })).ok, false);
        ledger.stageFacts.observeHead(session.url, head, 2);
        assert.equal((await assign({ ...session, head, stage: 'verify', candidates: [verifyTarget] })).ok, false);
        const fresh = await assign({ ...session, head, stage: 'review', candidates: [defaultTarget, preferredTarget] }); assert(fresh.ok); assert.notEqual(fresh.assignment.ref.id, review.assignment.ref.id);
        evidence.push({ phase, bot: assignments.read(bot.todoId, bot.url, bot.head), sessionOld: assignments.read(session.todoId, session.url, session.head), sessionNew: assignments.read(session.todoId, session.url, head) });
      } else {
        const before = attempts;
        const stored = assignments.read('session', 'https://github.com/synthetic/session/pull/8', head); assert(stored.review?.ref);
        const replay = await assign({ todoId: 'session', url: 'https://github.com/synthetic/session/pull/8', head, acceptanceContract: 'artifact:contract-session', stage: 'review', candidates: [] }); assert(replay.ok); assert.deepEqual(replay.assignment.ref, stored.review.ref); assert.equal(attempts, before);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM neo_todos').get().n, 5);
        assert(db.prepare('SELECT state FROM neo_todos').all().every((row: { state: string }) => row.state === 'doing'));
        assert.equal(git(source, 'rev-parse', 'HEAD'), baseHead); assert.equal(readFileSync(join(source, 'behavior.txt'), 'utf8'), 'preserve dirty author source');
        evidence.push({ phase, stored, todoStates: db.prepare('SELECT id,state FROM neo_todos').all() });
      }
    } finally { ws?.close(); await app.cleanup(); }
  }
  console.log(`PASS: real assignment/result RPC routes bot without reviewer, dispatches independent synthetic actors into pinned real checkouts, preserves preferences/contracts and reuses assignments across restart. Evidence: ${run}/evidence/actor-assignments.json`);
} finally {
  for (const release of releases) await release();
  writeFileSync(join(run, 'evidence/actor-assignments.json'), JSON.stringify({ evidence, starts, attempts, commands }, null, 2));
  globalThis.fetch = network;
}
