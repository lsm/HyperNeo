import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const [portText, runText, megabytesText = '24'] = process.argv.slice(2);
const port = Number(portText);
const megabytes = Number(megabytesText);
assert(port > 0 && port !== 8399 && runText && megabytes > 0);
const run = resolve(runText);
assert(process.env.NODE_ENV === 'test');
assert(process.env.HOME === join(run, 'home'));
assert(process.env.HYPERNEO_DATA_DIR === join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath), 'requires a fresh synthetic database');
mkdirSync(join(run, 'data'), { recursive: true });
const project = join(run, 'home/.claude/projects/-Users-synthetic-project');
mkdirSync(project, { recursive: true });

let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const words = Array.from({ length: 4000 }, (_, i) => `t${(i * 7907).toString(36)}`);
const prose = (count: number) =>
  Array.from({ length: count }, () => words[Math.floor(random() * words.length)]).join(' ');
const lines: string[] = [];
let bytes = 0;
const start = Date.parse('2026-10-20T10:00:00Z');
for (let i = 0; bytes < megabytes * 1024 * 1024; i++) {
  const at = new Date(start + i * 1000).toISOString();
  const base = { uuid: `u-${i}`, timestamp: at, cwd: '/Users/synthetic/project', sessionId: 'synthetic' };
  const line =
    i % 3 === 2
      ? JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${i}`, content: prose(900) }] } })
      : JSON.stringify({ ...base, type: i % 3 === 0 ? 'user' : 'assistant', message: { role: i % 3 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: prose(80) }] } });
  lines.push(line);
  bytes += line.length + 1;
}
writeFileSync(join(project, '0b9f3c1e-5a2d-4c7e-9f00-000000000001.jsonl'), `${lines.join('\n')}\n`);

const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
const db = app.db.getDatabase();
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
let maxLagMs = 0;
let last = performance.now();
const lag = setInterval(() => {
  const now = performance.now();
  maxLagMs = Math.max(maxLagMs, now - last - 10);
  last = now;
}, 10);
const indexed = () =>
  db.prepare(`SELECT count(*) AS n, coalesce(sum(length(body)), 0) AS chars FROM message_search_content WHERE kind = 'claude'`).get() as { n: number; chars: number };
const expected = lines.filter((_, i) => i % 3 !== 2).length;
const jobs: { status: string; ms: number }[] = [];
const deadline = Date.now() + 180_000;
try {
  while (indexed().n < expected && Date.now() < deadline) {
    const started = performance.now();
    const job = app.jobQueue.enqueue({ queue: 'work.feed.claude', payload: { scope: 'claude' }, runAt: Date.now() });
    while (!['completed', 'dead', 'failed'].includes(app.jobQueue.getJob(job.id)!.status)) await pause(20);
    jobs.push({ status: app.jobQueue.getJob(job.id)!.status, ms: Math.round(performance.now() - started) });
  }
} finally {
  clearInterval(lag);
}
const report = {
  surface: 'in-process daemon running its real work.feed.claude job over one synthetic Claude transcript, event loop sampled every 10 ms',
  transcriptMegabytes: Math.round(bytes / 1048576),
  lines: lines.length,
  expectedTurns: expected,
  indexed: indexed(),
  jobs,
  maxLagMs: Math.round(maxLagMs),
  runtime: Bun.version,
};
writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await app.cleanup();
process.exit(0);
