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
  (conversation_id,message_id,from_session,to_session,text,created_at) VALUES (?,?,?,?,?,?)`);
const count = Number(process.env.VERIFY_HISTORY_ROWS ?? 200000);
const body = 'Synthetic inbound history. '.repeat(160);
for (let offset = 0; offset < count; offset += 1000) {
  db.transaction(() => {
    for (let i = offset; i < Math.min(offset + 1000, count); i++) {
      insert.run(conversation, `perf-${i}`, i < 30 ? 'neo:synthetic' : 'worker:synthetic',
        'worker:synthetic', i < 30 ? `Visible outbound ${i}` : body, '2026-10-21T00:00:00.000Z');
    }
  })();
  await Bun.sleep(0);
}
db.close();
const samples = [];
for (let i = 0; i < 3; i++) {
  const started = performance.now();
  const snapshot = await rpc('neo.snapshot', {});
  const ms = performance.now() - started;
  const messages = snapshot.sessionMessages;
  if (messages.length !== 30 || messages.some((m: { text: string }, n: number) =>
    m.text !== `Visible outbound ${n}`)) throw new Error('Visible outbound history changed');
  samples.push({ ms, visible: messages.length });
}
const evidence = { rows: count, samples, maxMs: Math.max(...samples.map((s) => s.ms)) };
writeFileSync(`${run}/evidence/history-latency.json`, JSON.stringify(evidence, null, 2));
console.log(evidence);
if (evidence.maxMs >= 250) throw new Error('Neo snapshot exceeded 250ms');
