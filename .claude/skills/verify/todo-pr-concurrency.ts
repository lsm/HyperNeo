import { Database } from 'bun:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
const [port, run, mode = 'edit-urls'] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: todo-pr-concurrency.ts <test-port> <run-dir>');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
const watchdog = setTimeout(() => { ws.close(); throw new Error('Concurrent RPC timeout'); }, 240000);
const pending = new Map<string, (value: Record<string, unknown>) => void>();
ws.onmessage = (event) => { const reply = JSON.parse(String(event.data)); const id = reply.requestId ?? reply.id; if (pending.has(id)) { pending.get(id)!(reply); pending.delete(id); } };
function rpc(name: string, input: unknown) {
  const id = crypto.randomUUID();
  return new Promise<Record<string, unknown>>((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}
const opened = await rpc('neo.open', {});
const data = opened.data as { value?: { sessionId?: string }; sessionId?: string };
const sessionId = data.value?.sessionId ?? data.sessionId;
if (!sessionId) throw new Error(JSON.stringify(opened));
const db = new Database(`${run}/data/daemon.db`);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const target = quote(run);
await writeFile(`${run}/bin/gh`, `#!/bin/bash
run=${target}
echo "gh $*" >> "$run/evidence/gh.log"
if [ "$1" != pr ] || [ "$2" != view ]; then exit 1; fi
touch "$run/evidence/pr-started"
for _ in $(seq 1 12000); do
  [ -f "$run/pr-release" ] && break
  sleep 0.02
done
cat "$run/pr.json"
touch "$run/evidence/pr-finished"
`, { mode: 0o755 });
const now = Date.now();
const original = 'https://github.com/verify-test/demo/pull/14';
await writeFile(`${run}/pr.json`, JSON.stringify({ url: original, number: 14, state: 'MERGED', createdAt: new Date(now).toISOString(), mergedAt: new Date(now).toISOString(), headRefOid: 'test', reviews: [], statusCheckRollup: [] }));
db.query(`INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at) VALUES ('concurrent-ask',?,'Concurrent URLs','Keep every required PR','open',?,?)`).run(sessionId, now, now);
db.query(`INSERT INTO neo_todos (id,ask_id,position,title,done_when,check_json,instruction,state,created_at,updated_at) VALUES ('concurrent-todo','concurrent-ask',0,'Land every PR','Merged',?,'Land every PR','todo',?,?)`).run(JSON.stringify({ pack: 'coding', kind: 'pr_merged', params: { urls: [original] } }), now, now);
const urls = Array.from({ length: 20 }, (_, i) => `https://github.com/verify-test/demo/pull/${1000+i}`);
const completing = mode === 'sweep' ? Promise.resolve(null) : rpc(mode === 'close' ? 'neo.todo.close' : 'neo.todo.edit', mode === 'close'
  ? { todoId: 'concurrent-todo', reason: 'Original merged' }
  : { todoId: 'concurrent-todo', ...(mode === 'edit-urls' ? { addUrls: [original] } : {}), done: 'met', evidence: 'Original merged' });
const deadline = Date.now() + 210000;
while (await readFile(`${run}/evidence/pr-started`, 'utf8').then(() => false, () => true)) {
  if (Date.now() > deadline) throw new Error('No real GitHub check started');
  await Bun.sleep(50);
}
const replies = await Promise.all(urls.map((url) => rpc('neo.todo.edit', { todoId: 'concurrent-todo', addUrls: [url] })));
await writeFile(`${run}/pr-release`, 'release');
const completion = await completing;
if (mode === 'sweep') await Bun.sleep(2000);
clearTimeout(watchdog);
const row = db.query('SELECT check_json,done_when,state FROM neo_todos WHERE id = ?').get('concurrent-todo') as { check_json: string; done_when: string; state: string };
const stored = JSON.parse(row.check_json).params.urls ?? [];
const evidence = { mode, completion, urls, stored, missing: urls.filter((url) => !stored.includes(url)), row, replies };
await writeFile(`${run}/evidence/todo-pr-concurrency.json`, JSON.stringify(evidence, null, 2));
ws.close(); db.close();
if (replies.some((reply) => !JSON.stringify(reply).includes('"ok":true')) || evidence.missing.length || row.state === 'done') throw new Error(`${mode}: lost ${evidence.missing.length} PR URLs; final state ${row.state}`);
console.log(`PASS: ${mode} completion cannot finish on a stale check; all 20 concurrent RPC URL additions remain required.`);
