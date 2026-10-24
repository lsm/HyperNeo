import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runGhJson } from '../../../packages/daemon/src/lib/github/gh-lookup-helpers.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const gh = Bun.which('gh'); assert(gh);
const requests: string[] = [], commands: unknown[] = [];
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
  requests.push(request.url);
  const page = new URL(request.url).searchParams.get('page') ?? '1';
  return Response.json([{ page }], { headers: page === '1' ? { Link: `<http://127.0.0.1:${server.port}/reviews?page=2>; rel="next"` } : {} });
} });
assert.notEqual(server.port, 8399);
process.env.GH_TOKEN = 'synthetic-localhost-only';
let result: unknown;
try {
  result = await runGhJson([gh, 'api', `http://127.0.0.1:${server.port}/reviews`, '--paginate', '--slurp'], run,
    (args, options) => { commands.push(args); return spawnProcess(args, options); });
  assert.deepEqual(result, { ok: true, data: [[{ page: '1' }], [{ page: '2' }]] });
  assert.equal(requests.length, 2);
  console.log('PASS: installed gh paginates and slurps two real local HTTP responses through runGhJson.');
} finally {
  server.stop(true);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ requests, commands, result }, null, 2));
}
