import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readLagEvents, renderLagReport, summarizeLag } from '../../../scripts/daemon-lag-tally.ts';

const [expectedCommit, directory, baseline] = process.argv.slice(2);
assert(expectedCommit && directory && baseline);
const build = JSON.parse(execFileSync('hyperneo', ['build'], { encoding: 'utf8' }));
try {
  execFileSync('git', ['merge-base', '--is-ancestor', expectedCommit, build.commit], { stdio: 'pipe' });
} catch {
  console.log(JSON.stringify({ pending: 'awaiting deployment', build }));
  process.exit(0);
}
const until = Date.now();
const since = until - 7200000;
if (build.startedAt > since) {
  console.log(JSON.stringify({ pending: 'awaiting two hours on current deployed process', build, readyAt: new Date(build.startedAt + 7200000).toISOString() }));
  process.exit(0);
}
const logDirectory = join(process.env.HOME!, '.hyperneo/logs');
const records: { timestamp: number; process?: { pid?: number }; message?: string; id?: string }[] = [];
for (const name of readdirSync(logDirectory).filter((name) => /^daemon(?:\.\d+)?\.jsonl$/.test(name))) {
  for (const line of readFileSync(join(logDirectory, name), 'utf8').split('\n')) {
    try { const r = JSON.parse(line); if (r && Number.isFinite(r.timestamp)) records.push({ timestamp: r.timestamp, process: r.process, message: r.message, id: r.id }); } catch {}
  }
}
const earliest = records.reduce((at, r) => Math.min(at, r.timestamp), Infinity);
assert(earliest <= since, 'Retained logs do not cover the full window');
const seen = new Set<string>();
const selected = records.filter((r) => {
  if (r.timestamp < since || r.timestamp >= until || r.process?.pid !== build.pid || !r.message?.startsWith('[Daemon] Event loop')) return false;
  if (r.id && seen.has(r.id)) return false;
  if (r.id) seen.add(r.id);
  return true;
}).sort((a,b) => a.timestamp - b.timestamp);
const text = selected.map((r) => JSON.stringify(r)).join('\n');
const after = summarizeLag(readLagEvents(text), { since, until });
const before = summarizeLag(readLagEvents(readFileSync(baseline, 'utf8')));
const totals = (report: typeof after) => ({ blocks: report.days.reduce((n,d) => n+d.blocks,0), worstBlockMs: Math.max(0,...report.days.map((d) => d.worstBlockMs)) });
const evidence = { build, since: new Date(since).toISOString(), until: new Date(until).toISOString(), durationHours: 2, before: totals(before), after: totals(after), limitation: 'Before window includes prior builds and different workload. This is observational, not a controlled causal comparison.' };
const run = resolve(directory);
mkdirSync(run, { recursive: true });
writeFileSync(join(run, 'after-two-hours.jsonl'), text);
writeFileSync(join(run, 'after-two-hours-tally.txt'), renderLagReport(after));
writeFileSync(join(run, 'comparison.json'), JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
