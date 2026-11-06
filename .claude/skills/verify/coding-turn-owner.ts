import { chmod, readFile, writeFile } from 'node:fs/promises';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { recordWorkTurns } from '../../../packages/daemon/src/storage/repositories/work-turn-repository.ts';

const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: coding-turn-owner.ts <test-port> <run-dir>');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');

async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const output = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited || output.reply.error) throw new Error(JSON.stringify(output));
  return output.reply.value ?? output.reply;
}

const pull = (number: number) => `https://github.com/verify-test/demo/pull/${number}`;
const base = Date.now() - 3_600_000;
const at = (slot: number) => base + slot * 60_000;
const prs = [
  { number: 90, state: 'MERGED', slot: -30 },
  { number: 101, state: 'MERGED', slot: 1 },
  { number: 102, state: 'OPEN', slot: 2 },
  { number: 103, state: 'MERGED', slot: 5 },
  { number: 104, state: 'MERGED', slot: 6 },
  { number: 105, state: 'MERGED', slot: 8 },
  { number: 106, state: 'MERGED', slot: 9 },
  { number: 107, state: 'MERGED', slot: 10 },
  { number: 108, state: 'MERGED', slot: 10 },
  { number: 109, state: 'MERGED', slot: 11 },
  { number: 110, state: 'MERGED', slot: 11 },
];
await Bun.$`mkdir -p ${run}/prs`;
for (const { number, state, slot } of prs) {
  const created = new Date(at(slot) + 1_000).toISOString();
  await writeFile(`${run}/prs/${number}.json`, JSON.stringify({ url: pull(number), number, state, createdAt: created, mergedAt: state === 'MERGED' ? new Date(at(20)).toISOString() : null, headRefOid: `head-${number}`, reviews: [], statusCheckRollup: [], title: `Synthetic ${number}` }));
}
await writeFile(`${run}/bin/gh`, `#!/bin/bash
run=${JSON.stringify(run)}
echo "gh $*" >> "$run/evidence/gh.log"
[ "$1" = pr ] && [ "$2" = view ] && [ -f "$run/prs/\${3##*/}.json" ] && exec cat "$run/prs/\${3##*/}.json"
echo "verify gh stub: unsupported gh $*" >&2
exit 1
`);
await chmod(`${run}/bin/gh`, 0o755);

await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Local verify mock', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
const opened = await rpc('neo.open', {});
if (!opened.sessionId) throw new Error(JSON.stringify(opened));

const db = new Database(`${run}/data/daemon.db`);
const now = Date.now();
const expected: Record<string, { state: 'done' | 'doing'; report?: number; why: string }> = {
  'reuse-a': { state: 'done', why: 'reused worker: PR 101 was made in this todo\'s turn' },
  'reuse-b': { state: 'doing', report: 101, why: 'reused worker: PR 101 merged, but it belongs to the earlier todo' },
  'old-mention': { state: 'doing', report: 90, why: 'PR 90 is older than every turn that shows it' },
  aborted: { state: 'done', why: 'the no-input turn continues the aborted turn' },
  human: { state: 'doing', report: 104, why: 'PR 104 was made in a human turn' },
  'shared-1': { state: 'doing', report: 105, why: 'two todos shared the turn that made PR 105' },
  'shared-2': { state: 'doing', report: 105, why: 'two todos shared the turn that made PR 105' },
  unreadable: { state: 'doing', report: 106, why: 'the turn that made PR 106 is not fully read' },
  displayed: { state: 'done', why: 'PR 108 was only displayed here and another session reported it' },
  reporter: { state: 'done', why: 'this turn reported PR 108' },
  'unclaimed-display': { state: 'doing', why: 'PR 110 is in tool output beside reported PR 109, so it stays unknown' },
};
db.prepare(`INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at) VALUES ('turn-ask',?,'Turn owners','Place PRs by turn','open',?,?)`).run(opened.sessionId, now, now);
Object.entries(expected).forEach(([id, { report }], position) => {
  db.prepare(`INSERT INTO neo_todos (id,ask_id,position,title,done_when,check_json,instruction,report,state,created_at,updated_at,started_at) VALUES (?,'turn-ask',?,?,'PR merged',?,'Land it',?,'doing',?,?,?)`)
    .run(id, position, id, JSON.stringify({ pack: 'coding', kind: 'pr_merged', params: {} }), report ? `Merged ${pull(report)}` : null, now, now, now);
});

const turn = (id: string, slot: number, inputs: string[], urls: string[], change = {}) => ({ id, startedAt: at(slot), endedAt: at(slot) + 30_000, ended: 'success', inputs, urls, finalUrls: urls, complete: true, cursor: String(slot), ...change });
const workers = [
  { worker: 'reused', sends: { 'reuse-a': 'in-a', 'reuse-b': 'in-b', 'old-mention': 'in-c' }, turns: [
    turn('t1', 1, ['in-a'], [pull(101)]),
    turn('t2', 2, ['in-b'], [pull(102), pull(101)], { finalUrls: [pull(102)] }),
    turn('t3', 3, ['in-c'], [pull(90)]),
  ] },
  { worker: 'stopped', sends: { aborted: 'in-d' }, turns: [
    turn('t4', 4, ['in-d'], [], { ended: 'interrupted' }),
    turn('t5', 5, [], [pull(103)]),
  ] },
  { worker: 'typed', sends: { human: 'in-e' }, turns: [
    turn('t6', 6, ['typed-by-a-person'], [pull(104)]),
    turn('t7', 7, ['in-e'], [pull(104)], { finalUrls: [] }),
  ] },
  { worker: 'shared', sends: { 'shared-1': 'in-f', 'shared-2': 'in-g' }, turns: [
    turn('t8', 8, ['in-f', 'in-g'], [pull(105)]),
  ] },
  { worker: 'lister', sends: { displayed: 'in-i' }, turns: [
    turn('t10', 10, ['in-i'], [pull(107), pull(108)], { finalUrls: [pull(107)] }),
  ] },
  { worker: 'maker', sends: { reporter: 'in-j' }, turns: [
    turn('t11', 10, ['in-j'], [pull(108)]),
  ] },
  { worker: 'ambiguous', sends: { 'unclaimed-display': 'in-k' }, turns: [
    turn('t12', 11, ['in-k'], [pull(109), pull(110)], { finalUrls: [pull(109)] }),
  ] },
  { worker: 'partial', sends: { unreadable: 'in-h' }, turns: [
    turn('t9', 9, ['in-h'], [pull(106)], { complete: false, ended: 'unknown' }),
  ] },
];
for (const { worker, sends, turns } of workers) {
  const ref = { adapter: 'hyperneo', id: `verify-${worker}` };
  for (const [todoId, inputId] of Object.entries(sends))
    db.prepare(`INSERT INTO work_delivery_inputs (id,todo_id,origin_session_id,target,message,accepted_at,deadline_at,outcome) VALUES (?,?,'neo','{}','work',1,2,?)`)
      .run(`send-${todoId}`, todoId, JSON.stringify({ ref, receipt: { executionId: ref.id, inputId } }));
  recordWorkTurns.run(db, { ref, turns }, undefined as never);
}

const states = () => db.prepare(`SELECT id,state,evidence FROM neo_todos WHERE ask_id = 'turn-ask' ORDER BY position`).all() as { id: string; state: string; evidence: string | null }[];
const ghLog = () => readFile(`${run}/evidence/gh.log`, 'utf8').catch(() => '');
const swept = async () => {
  const text = await ghLog();
  return prs.every(({ number }) => text.includes(`/pull/${number} `));
};
const deadline = Date.now() + 240_000;
while (Date.now() < deadline && !(await swept() && states().filter((row) => row.state === 'done').length >= 4)) await Bun.sleep(1_000);
await Bun.sleep(20_000);

const final = states();
const results = final.map((row) => ({ ...row, expected: expected[row.id].state, why: expected[row.id].why, pass: row.state === expected[row.id].state }));
const allRead = await swept();
await writeFile(`${run}/evidence/coding-turn-owner.json`, JSON.stringify({ allRead, results, gh: (await ghLog()).split('\n').slice(0, 40) }, null, 2));
console.log(JSON.stringify({ allRead, results }, null, 2));
db.close();
if (!allRead || results.some((row) => !row.pass)) throw new Error('turn ownership proof failed');
console.log('PASS');
