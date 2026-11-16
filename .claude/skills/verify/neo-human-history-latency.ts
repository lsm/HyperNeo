import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
if (!port || port === '8399' || !directory) throw new Error('Use an isolated port and run directory');
const run = resolve(directory);
const pid = Number(readFileSync(`${run}/daemon.pid`, 'utf8'));
process.kill(pid, 0);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
if (!log.includes(`${run}/data/daemon.db`)) throw new Error('Daemon is not isolated in run directory');
mkdirSync(`${run}/evidence`, { recursive: true });
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const text = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`RPC failed: ${text}`);
  return JSON.parse(text).reply;
}
const opened = await rpc('neo.open', {});
const conversation = opened.sessionId.replace(/^neo:/, '');
const db = new Database(`${run}/data/daemon.db`);
db.exec('PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000');
const insert = db.prepare(`INSERT INTO neo_session_messages
  (conversation_id,message_id,from_session,to_session,text,created_at,kind) VALUES (?,?,?,?,?,?,?)`);
const count = Number(process.env.VERIFY_HISTORY_ROWS ?? 200000);
const body = 'Synthetic hidden history. '.repeat(160);
for (let offset = 0; process.env.VERIFY_HISTORY_EXISTING !== '1' && offset < count; offset += 1000) {
  db.transaction(() => {
    for (let i = offset; i < Math.min(offset + 1000, count); i++) {
      const batch = i < 30;
      insert.run(
        conversation,
        `perf-${i}`,
        batch ? 'system:worker-batch' : i % 2 ? opened.sessionId : 'worker:synthetic',
        batch ? opened.sessionId : i % 2 ? 'worker:synthetic' : opened.sessionId,
        batch ? `Worker batch ${i}` : body,
        new Date(Date.parse('2026-10-21T00:00:00.000Z') + i).toISOString(),
        batch ? 'worker-batch' : 'session'
      );
    }
  })();
  await Bun.sleep(0);
}
db.close();
const samples = [];
for (let i = 0; i < 3; i++) {
  const started = performance.now();
  const page = await rpc('neo.conversation.read', { conversationId: conversation, limit: 50 });
  const ms = performance.now() - started;
  const rows = page.items.filter((item: { role: string }) => item.role === 'session');
  if (
    rows.length !== 30 ||
    rows.some(
      (item: { message: { text: string; kind: string } }, n: number) =>
        item.message.text !== `Worker batch ${n}` || item.message.kind !== 'worker-batch'
    )
  )
    throw new Error('Human history changed');
  samples.push({ ms, rows: rows.length });
}
const evidence = { rows: count, samples, maxMs: Math.max(...samples.map((s) => s.ms)) };
writeFileSync(`${run}/evidence/human-history-latency.json`, JSON.stringify(evidence, null, 2));
console.log(evidence);
if (evidence.maxMs >= 250) throw new Error('Human history read exceeded 250ms');
