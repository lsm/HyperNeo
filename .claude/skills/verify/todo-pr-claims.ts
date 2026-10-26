import { Database } from 'bun:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
const [port, run, phase = 'after'] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: todo-pr-claims.ts <test-port> <run-dir> [before|after]');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const output = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited || output.reply.error) throw new Error(JSON.stringify(output));
  return output.reply.value ?? output.reply;
}
await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Local verify mock', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
const opened = await rpc('neo.open', {});
if (!opened.sessionId) throw new Error(JSON.stringify(opened));
const askId = 'claim-ask';
const url = 'https://github.com/verify-test/demo/pull/14';
const check = { pack: 'coding', kind: 'pr_merged', params: {} };
const now = Date.now();
const db = new Database(`${run}/data/daemon.db`);
db.query(`INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at) VALUES (?,?,'One PR owner','Verify existing PR ownership','open',?,?)`).run(askId, opened.sessionId, now, now);
db.query(`INSERT INTO neo_todos (id,ask_id,position,title,done_when,check_json,instruction,state,created_at,updated_at,started_at) VALUES ('claim-original',?,0,'Original fix','PR merged',?,'Land the fix','doing',?,?,?)`).run(askId, JSON.stringify(check), now, now, now);
db.query(`INSERT INTO pack_coding_pr_claims (todo_id,url,claim,claimed_at) VALUES ('claim-original',?,'branch',?)`).run(url, now);
const pr = { url, number: 14, state: 'OPEN', createdAt: new Date(now).toISOString(), mergedAt: null, headRefOid: 'verify-head', reviews: [], statusCheckRollup: [], title: 'Synthetic fix' };
await writeFile(`${run}/pr.json`, JSON.stringify(pr));
const duplicate = await rpc('neo.todo.add', { askId, title: 'Pin PR link', doneWhen: 'Merged', check: { ...check, params: { urls: [url] } } });
const edited = await rpc('neo.todo.edit', { todoId: 'claim-original', addUrls: [url] });
const other = await rpc('neo.todo.add', { askId, title: 'Other work', doneWhen: 'Merged', check: { ...check, params: { urls: ['https://github.com/verify-test/demo/pull/15'] } } });
const collision = await rpc('neo.todo.edit', { todoId: other.todo?.id, addUrls: [url] });
const evidence = { askId, duplicate, edited, collision, final: null as unknown, snapshot: null as unknown };
await writeFile(`${run}/evidence/todo-pr-claims.json`, JSON.stringify(evidence, null, 2));
if (phase === 'before') { db.close(); throw new Error('Before reproduction recorded; duplicate/edit contract is not yet enforced'); }
if (!duplicate.ok || !duplicate.records?.some((record: string) => record.includes('claim-original') && record.includes('Original fix')) || !edited.ok || !edited.todo.check.params.urls?.includes(url) || !collision.ok || !collision.records?.length) throw new Error('PR ownership records missing');
await rpc('neo.todo.remove', { todoId: other.todo.id, reason: 'Synthetic collision check finished' });
await writeFile(`${run}/pr.json`, JSON.stringify({ ...pr, state: 'MERGED', mergedAt: new Date().toISOString() }));
const deadline = Date.now() + 210000;
while (Date.now() < deadline) {
  const row = db.query('SELECT state,evidence,check_json FROM neo_todos WHERE id = ?').get('claim-original') as { state: string; evidence: string; check_json: string };
  if (row.state === 'done') { evidence.final = row; break; }
  await Bun.sleep(1000);
}
evidence.snapshot = await rpc('neo.snapshot', {});
await writeFile(`${run}/evidence/todo-pr-claims.json`, JSON.stringify(evidence, null, 2));
db.close();
if (!evidence.final || !JSON.stringify(evidence.final).includes('#14 merged')) throw new Error('Coding pack did not automatically close the edited todo on merge');
console.log('PASS: duplicate recorded with owner id/title, edit pins the URL, competing edit recorded, and coding pack automatically closes the original on merge.');
