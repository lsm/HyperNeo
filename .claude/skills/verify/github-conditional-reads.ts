import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { readCodingDaemonMergeFacts } from '../../../packages/daemon/src/lib/neo/packs/coding/daemon-merge-facts.ts';
import { spawnProcess, type SpawnFn } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const [url, evidence] = process.argv.slice(2);
assert.ok(url && evidence, 'usage: <public PR URL> <evidence dir>');
assert.equal(process.env.NODE_ENV, 'test');

type Seen = { args: string; status: number | null; resource: string | null };
let seen: Seen[] = [];
const readOnly: SpawnFn = (args, options) => {
  const read =
    (args[1] === 'pr' && ['view', 'checks'].includes(args[2])) ||
    (args[1] === 'api' && !args.some((arg) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(arg)));
  assert.ok(read, `refused non-read gh call: ${args.join(' ')}`);
  const proc = spawnProcess(args, options);
  const [mine, theirs] = (proc.stdout as ReadableStream<Uint8Array>).tee();
  const entry: Seen = { args: args.slice(1).join(' '), status: null, resource: null };
  seen.push(entry);
  void new Response(mine).text().then((text) => {
    entry.status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(text)?.[1] ?? 0) || null;
    entry.resource = /^x-ratelimit-resource:\s*(\S+)/im.exec(text)?.[1] ?? null;
  });
  return {
    stdout: theirs,
    stderr: proc.stderr,
    exited: proc.exited,
    get exitCode() {
      return proc.exitCode;
    },
    kill: (signal?: NodeJS.Signals) => proc.kill(signal),
  };
};

const db = new Database(':memory:');
runMigrations(db, () => {});
createTables(db);
createCodingPackTables(db);
const passes: { ok: boolean; calls: Seen[] }[] = [];
for (let pass = 0; pass < 2; pass++) {
  seen = [];
  const facts = await readCodingDaemonMergeFacts(db, url, readOnly);
  await new Promise((resolve) => setTimeout(resolve, 50));
  passes.push({ ok: facts.ok, calls: seen });
}
db.close();
const rest = (pass: number) => passes[pass].calls.filter((call) => call.resource === 'core');
const counted = (pass: number) => rest(pass).filter((call) => call.status !== 304).length;
const summary = {
  url,
  passes,
  coreCounted: [counted(0), counted(1)],
  secondPassRestStatuses: rest(1).map((call) => call.status),
};
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, 'github-conditional-reads.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.coreCounted), JSON.stringify(summary.secondPassRestStatuses));
assert.ok(passes.every((pass) => pass.ok), 'every merge-facts read must succeed');
assert.ok(rest(1).length >= 2, 'the second pass must still make its REST reads');
assert.equal(counted(1), 0, 'an unchanged PR must cost no counted core call on the second read');
console.log('PASS: second read of an unchanged PR answered by 304s');
