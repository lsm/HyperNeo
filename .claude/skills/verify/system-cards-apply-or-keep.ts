import { strict as assert } from 'node:assert';
import { Database } from 'bun:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'pass isolated port and run directory');
const log = await readFile(`${run}/daemon.log`, 'utf8');
assert(log.includes(`Database: ${run}/data/daemon.db`), 'not an isolated daemon');
const evidence: Record<string, unknown>[] = [];
async function rpc(name: string, input: unknown = {}) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  const value = result.reply.value ?? result.reply;
  evidence.push({ name, input, value });
  return value;
}
const sql = (query: string, ...args: (string | number)[]) => {
  const db = new Database(`${run}/data/daemon.db`);
  db.query(query).run(...args);
  db.close();
};
const sessionId = (await rpc('neo.open')).sessionId;
const askId = crypto.randomUUID();
sql("INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at) VALUES (?,?,'Synthetic settings','Change synthetic rules and settings','open',?,?)", askId, sessionId, Date.now(), Date.now());
const card = async (questionId: string) => (await rpc('neo.snapshot')).todoAsks.flatMap((ask: { questions: { id: string }[] }) => ask.questions).find((q: { id: string }) => q.id === questionId);
const chat = (questionId: string, content: string) => rpc('neo.message.send', { sessionId, requestId: crypto.randomUUID(), content, replyTo: { kind: 'question', id: questionId } });
const button = (questionId: string, answer: string) => rpc('neo.question.answer', { questionId, answer });
const legacy = (questionId: string, keep: string, apply: string) => sql("UPDATE neo_questions SET kind='yesno', options=NULL, no_label=?, yes_label=? WHERE id=?", keep, apply, questionId);
const rules = async () => (await rpc('neo.snapshot')).standingRules ?? [];
const rule = async (requestId: string, add: string) => (await rpc('neo.rule.ask', { askId, requestId, add: [add] })).questionId as string;

const first = await rule('keep', 'Synthetic rule kept out.');
const shape = await card(first);
assert.equal(shape.kind, 'choice');
assert.deepEqual(shape.options, ['Apply these rule changes', 'Keep current rules']);
await button(first, 'Keep current rules');
const wordsOnly = await rule('words', 'Synthetic rule from words.');
await chat(wordsOnly, 'yes');
assert.equal((await rpc('neo.question.get', { questionId: wordsOnly })).question.state, 'answered');
assert.deepEqual(await rules(), [], 'keep and a bare yes must not change rules');
await chat(await rule('letter', 'Synthetic rule by letter.'), 'A');
await button(await rule('button', 'Synthetic rule by button.'), 'Apply these rule changes');
const old = await rule('legacy', 'Synthetic rule from an old card.');
legacy(old, 'Keep current rules', 'Apply these rule changes');
await chat(old, 'yes');
assert.deepEqual(await rules(), ['Synthetic rule by letter.', 'Synthetic rule by button.', 'Synthetic rule from an old card.']);

const setting = { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/one' }, key: 'mergePolicy' };
const propose = async (requestId: string, value: string) => (await rpc('pack.preferences.ask', { askId, requestId, values: [{ ...setting, value }] })).questionId as string;
const saved = async () => (await rpc('pack.preferences.get', setting)).preference?.value ?? null;
const kept = await propose('settings-keep', 'ci_only');
const options = (await card(kept)).options as string[];
assert.equal(options.length, 2);
await button(kept, options[1]);
assert.equal(await saved(), null, 'keep must save nothing');
await chat(await propose('settings-letter', 'ci_only'), 'A');
assert.equal(await saved(), 'ci_only');
const oldSettings = await propose('settings-legacy', 'human');
legacy(oldSettings, options[1], options[0]);
await button(oldSettings, 'yes');
assert.equal(await saved(), 'human');

await mkdir(`${run}/evidence`, { recursive: true });
await writeFile(`${run}/evidence/system-cards-apply-or-keep.json`, JSON.stringify(evidence, null, 2));
console.log(`PASS: rule and settings cards are apply-or-keep choices; keep and a bare yes change nothing, letter A and the apply button apply, and a pre-upgrade yes/no card still applies on yes. ${run}/evidence/system-cards-apply-or-keep.json`);
