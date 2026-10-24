import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import type { NeoSessionFacts } from '../../../packages/daemon/src/lib/neo/pack-contract.ts';

const run = resolve(process.argv[2]), execFile = promisify(execFileCallback);
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), `#!/bin/sh
printf 'CALL %s\\n' "$*" >> '${run}/evidence/gh.log'
if [ "$1" = api ] && [ "$2" = graphql ]; then cat '${run}/response.json'; exit 0; fi
exit 1
`, { mode: 0o755 });
writeFileSync(join(run, 'response.json'), JSON.stringify({ data: { rateLimit: { remaining: 4000 }, repository: { nameWithOwner: 'chosen/repo', open: { pageInfo: { hasNextPage: false }, nodes: [] }, done: { nodes: [] } } } }));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
const evidence: Record<string, unknown> = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), receipts: [] };
const open = async () => {
  app = await createDaemonApp({ config: { ...config, disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
};
const close = async () => { await service?.dispose(); service = undefined; await app?.cleanup(); app = undefined; };
const call = async (name: string, input: unknown) => {
  const { stdout } = await execFile(process.execPath, ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: String(app!.server.port) } });
  const reply = JSON.parse(stdout).reply;
  (evidence.receipts as unknown[]).push({ name, input, reply });
  assert(!reply.error, JSON.stringify(reply)); return reply;
};
const watched = async () => (await call('pack.preferences.get', { pack: 'coding', scope: { kind: 'global', key: '' }, key: 'watchedRepos' })).preference.value;
const save = async (value: string[]) => assert.deepEqual(await call('pack.preferences.set', { pack: 'coding', scope: { kind: 'global', key: '' }, key: 'watchedRepos', value }), { ok: true });
const facts = (repo: string): NeoSessionFacts => ({ ref: { adapter: 'codex-desktop', id: repo.replace('/', '-') }, status: 'done', lastActivityAt: Date.now(), remotes: [`https://github.com/${repo}.git`], branches: ['synthetic'], openedPrs: [`https://github.com/${repo}/pull/1`] });
const gh = () => existsSync(join(run, 'evidence/gh.log')) ? readFileSync(join(run, 'evidence/gh.log'), 'utf8') : '';
try {
  await open();
  assert.deepEqual(await watched(), []);
  await service!.pack('coding')!.observeSessions!([facts('foreign/repo')], Date.now());
  await service!.pack('coding')!.sweep!(Date.now());
  assert.equal(gh(), '');
  assert.deepEqual(app!.db.getDatabase().prepare('SELECT ref FROM pack_coding_session_facts').all(), []);
  evidence.fresh = { watchList: [], githubCalls: 0, foreignFacts: 0 };
  await save(['chosen/repo']);
  await service!.pack('coding')!.observeSessions!([facts('foreign/repo'), facts('chosen/repo')], Date.now());
  await service!.pack('coding')!.sweep!(Date.now());
  assert.equal((gh().match(/^CALL /gm) ?? []).length, 1);
  assert(gh().includes('o=chosen') && gh().includes('n=repo'));
  assert(!gh().includes('o=foreign'));
  const rows = app!.db.getDatabase().prepare('SELECT repos FROM pack_coding_session_facts').all();
  assert.deepEqual(rows, [{ repos: '["chosen/repo"]' }]);
  evidence.chosen = { watchList: await watched(), githubCalls: 1, facts: rows };
  await close(); await open();
  assert.deepEqual(await watched(), ['chosen/repo']);
  await save([]); const before = gh();
  await service!.pack('coding')!.sweep!(Date.now());
  assert.equal(gh(), before);
  await close(); await open();
  assert.deepEqual(await watched(), []);
  await service!.pack('coding')!.sweep!(Date.now());
  assert.equal(gh(), before);
  evidence.restart = { watchList: [], additionalGithubCalls: 0 };
  await close();
  const legacy = new Database(join(run, 'data/daemon.db'));
  try {
    legacy.prepare("DELETE FROM neo_pack_preferences WHERE pack = 'coding' AND key = 'watchedRepos'").run();
    legacy.prepare("INSERT INTO neo_concerns (id,title,summary,context,revision,created_at,updated_at) VALUES ('legacy','Synthetic legacy project','','',1,1,1)").run();
    legacy.prepare("INSERT INTO neo_project_workspaces (alias,project_id) VALUES ('repository:github.com/chosen/repo','legacy')").run();
  } finally { legacy.close(); }
  await open();
  assert.deepEqual(await watched(), ['chosen/repo']);
  app!.db.getDatabase().prepare("INSERT INTO neo_project_workspaces (alias,project_id) VALUES ('repository:github.com/foreign/repo','legacy')").run();
  await close(); await open();
  assert.deepEqual(await watched(), ['chosen/repo']);
  evidence.legacy = { watchList: ['chosen/repo'], laterProjectNotEnrolled: true };
  evidence.passed = true;
} finally {
  await close(); evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence, null, 2));
